import type { TimerHandle } from "../../VirtualTime.ts"
import type { Account } from "../account.ts"
import type { Settings, WarmPoolState } from "./config.ts"
import { instanceType } from "./instanceTypes.ts"
import { give, type Ledger, take } from "./vcpus.ts"

/**
 * A warm pool (`ec2-auto-scaling-warm-pools.html`): pre-initialised instances kept beside the group, so that a scale-out
 * starts one of them (a warm start) instead of launching from scratch (a cold start).
 *
 * - **Size.** By default the pool holds the group's maximum size minus its desired capacity; with a maximum prepared
 *   capacity set, that minus the desired capacity; never fewer than its minimum size (AWS's default minimum is none).
 * - **Preparing.** A new pool instance launches like any instance (pending, boot, user data, application start) and then
 *   stops, hibernates or keeps running, as the pool state says. While it prepares it is a running On-Demand instance and
 *   counts against the vCPU quota; stopped and hibernated ones don't (`ec2-on-demand-instances.html`).
 * - **Leaving.** A launch in a zone takes a ready pool instance from that zone, if there is one, and the pool replaces
 *   it. An empty pool means a cold start, as AWS says ("If your warm pool is depleted when there is a scale-out event,
 *   instances will launch directly into the Auto Scaling group").
 * - **Spread.** Each new pool instance goes to the zone with the fewest instances, the group's and the pool's together,
 *   which is where the group launches next. (AWS doesn't say how it spreads a pool; this is an assumption.)
 *
 * Not modelled: the instance reuse policy (scale-in returns instances to the pool; AWS's default terminates them),
 * lifecycle hooks, health checks of pool instances, and an AZ outage reaching stopped pool instances (a ready one in a
 * zone that is down is simply not used while it is down).
 */

/** One pool instance. */
interface WarmInstance {
  readonly id: number
  readonly zone: string | undefined
  /** Preparing (running its first launch), or ready in the pool state. */
  ready: boolean
  timer: TimerHandle | undefined
  /** It holds On-Demand vCPUs: while preparing, and while ready in the Running state. */
  vcpus: number
}

/** What the pool needs of its group. */
export interface PoolHost {
  readonly settings: () => Settings
  readonly account: () => Account
  readonly now: () => number
  readonly after: <A>(ms: number, fire: (arg: A) => void, arg: A) => TimerHandle
  readonly ledger: Ledger
  /** The group's zones that are up, for spreading the pool. */
  readonly zones: () => ReadonlyArray<string>
  /** The group's live instances in a zone: the pool fills the zones the group will launch into next. */
  readonly groupIn: (zone: string) => number
  /** The group's desired capacity now (clamped to its minimum and maximum). */
  readonly desired: () => number
  /** How long a cold launch takes, all phases together. */
  readonly coldMs: () => number
  /** How long a refused launch waits before it is tried again. */
  readonly retryMs: number
}

export class WarmPool {
  private readonly instances: Array<WarmInstance> = []
  private seq = 0
  private retry: TimerHandle | undefined = undefined
  private pending: TimerHandle | undefined = undefined
  /** Running totals, for a probe. */
  readonly totals = { prepared: 0, warmStarts: 0, coldStarts: 0, refusedLaunches: 0 }

  constructor(private readonly host: PoolHost) {
    // Like the group's first instances, the pool exists before the simulation starts: its first instances are ready.
    const target = this.target()
    for (let i = 0; i < target; i++) {
      const w = this.create(this.emptiestZone())
      if (!this.hold(w, this.host.settings().warmPool.poolState === "Running")) {
        this.remove(w)
        break
      }
      w.ready = true
    }
  }

  /** How many instances the pool should hold now. */
  target(): number {
    const c = this.host.settings()
    if (!c.warmPool.enabled) return 0
    const prepared = c.warmPool.maxGroupPreparedCapacity > 0 ? c.warmPool.maxGroupPreparedCapacity : c.maxSize
    return Math.max(c.warmPool.minSize, prepared - this.host.desired())
  }

  /** Instances ready in the pool. */
  get ready(): number {
    let n = 0
    for (const w of this.instances) if (w.ready) n++
    return n
  }

  /** Instances being prepared for the pool. */
  get preparing(): number {
    return this.instances.length - this.ready
  }

  /** vCPUs the pool holds against the On-Demand quota. */
  get vcpus(): number {
    let n = 0
    for (const w of this.instances) n += w.vcpus
    return n
  }

  /**
   * A launch in `zone` takes a ready pool instance from there, if the pool has one: answers its pool state (what the
   * start skips), or `undefined` for a cold start. The pool then replaces what it gave.
   */
  take(zone: string | undefined): WarmPoolState | undefined {
    if (!this.host.settings().warmPool.enabled) return undefined
    const w = this.instances.find((i) => i.ready && i.zone === zone)
    if (w === undefined) {
      this.totals.coldStarts++
      this.later()
      return undefined
    }
    // Its vCPUs (if it was running) pass to the instance it becomes, which took its own when it launched.
    this.release(w)
    this.remove(w)
    this.totals.warmStarts++
    this.later()
    return this.host.settings().warmPool.poolState
  }

  /**
   * Refresh once the launches under way have taken what they need: a scale-out launches several instances at once, and
   * the pool's size (which falls as the desired capacity rises) must not terminate instances the next launch will use.
   */
  private later(): void {
    this.pending ??= this.host.after(0, this.refreshNow, undefined)
  }

  private readonly refreshNow = (): void => {
    this.pending = undefined
    this.refresh()
  }

  /** Bring the pool to its size: prepare what is missing, terminate what is extra (ready ones last). Call after any change. */
  refresh(): void {
    const target = this.target()
    const state = this.host.settings().warmPool.poolState
    // Ready instances follow the pool state: a Running pool holds vCPUs, a stopped or hibernated one doesn't.
    for (const w of this.instances) {
      if (!w.ready) continue
      if (state === "Running" && w.vcpus === 0) this.hold(w, true)
      else if (state !== "Running" && w.vcpus > 0) this.release(w)
    }
    while (this.instances.length > target) {
      const preparing = this.instances.findLast((i) => !i.ready)
      const w = preparing ?? this.instances[this.instances.length - 1]!
      w.timer?.cancel()
      this.release(w)
      this.remove(w)
    }
    while (this.instances.length < target) {
      const w = this.create(this.emptiestZone())
      if (!this.hold(w, true)) {
        this.remove(w)
        this.totals.refusedLaunches++
        this.retry ??= this.host.after(this.host.retryMs, this.retried, undefined)
        return
      }
      w.timer = this.host.after(this.host.coldMs(), this.prepared, w)
    }
  }

  private readonly retried = (): void => {
    this.retry = undefined
    this.refresh()
  }

  /** A pool instance finished its first launch: it stops, hibernates or keeps running. */
  private readonly prepared = (w: WarmInstance): void => {
    w.timer = undefined
    w.ready = true
    this.totals.prepared++
    if (this.host.settings().warmPool.poolState !== "Running") this.release(w)
  }

  private create(zone: string | undefined): WarmInstance {
    const w: WarmInstance = { id: ++this.seq, zone, ready: false, timer: undefined, vcpus: 0 }
    this.instances.push(w)
    return w
  }

  private remove(w: WarmInstance): void {
    const i = this.instances.indexOf(w)
    if (i >= 0) this.instances.splice(i, 1)
  }

  /** Take On-Demand vCPUs for a running pool instance. */
  private hold(w: WarmInstance, running: boolean): boolean {
    if (!running || w.vcpus > 0) return true
    const vcpus = instanceType(this.host.settings().instanceType).vcpus
    if (!take(this.host.ledger, this.host.account(), "onDemand", vcpus)) return false
    w.vcpus = vcpus
    return true
  }

  private release(w: WarmInstance): void {
    if (w.vcpus === 0) return
    give(this.host.ledger, "onDemand", w.vcpus)
    w.vcpus = 0
  }

  /**
   * The group zone (up) with the fewest instances, the group's and the pool's together; ties go to the first. The group
   * launches into its emptiest zones, so this puts pool instances where the next launches will look for them.
   */
  private emptiestZone(): string | undefined {
    let best: string | undefined
    let fewest = Infinity
    for (const z of this.host.zones()) {
      let n = this.host.groupIn(z)
      for (const w of this.instances) if (w.zone === z) n++
      if (n < fewest) {
        fewest = n
        best = z
      }
    }
    return best
  }

  /** The pool, for a probe. */
  snapshot(): { readonly ready: number; readonly preparing: number; readonly target: number; readonly byZone: Readonly<Record<string, number>> } {
    const byZone: Record<string, number> = {}
    for (const w of this.instances) if (w.ready && w.zone !== undefined) byZone[w.zone] = (byZone[w.zone] ?? 0) + 1
    return { ready: this.ready, preparing: this.preparing, target: this.target(), byZone }
  }
}
