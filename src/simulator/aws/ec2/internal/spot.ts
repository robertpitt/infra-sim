import { Duration } from "effect"
import type { Fleet } from "../../../fleet/Fleet.ts"
import type { Unit } from "../../../Protocol.ts"
import type { SeededRandom } from "../../../SeededRandom.ts"
import type { TimerHandle } from "../../../VirtualTime.ts"
import type { Settings } from "./config.ts"
import { overMaxMargin, SPOT_NOTICE_MS } from "../Limits.ts"
import type { Purchase } from "../Vcpus.ts"

/**
 * Spot in an Auto Scaling group: which launches are Spot, how EC2 reclaims them, and what the group does about it.
 *
 * **The split** (`mixed-instances-groups-set-up-overview.html`, `API_InstancesDistribution.html`). The first
 * `onDemandBaseCapacity` instances are On-Demand; of the rest, `onDemandPercentageAboveBase`% are On-Demand ("if the
 * result creates a fractional number, it rounds up to the next integer in favor of On-Demand Instances") and the others
 * Spot. Each launch is whichever option is short of that split for the group's size after it.
 *
 * **Interruptions** come at random, at a rate per Spot instance-hour (a Poisson process on the group's own seeded
 * stream). Each gives the two-minute notice (`spot-instance-termination-notices.html`); at its end EC2 terminates the
 * instance, cutting off what it was doing. Then:
 * - Without Capacity Rebalancing the group does nothing until the instance is gone ("Auto Scaling doesn't replace Spot
 *   Instances until after the Amazon EC2 Spot service interrupts the instances"): the replacement launches as it is
 *   terminated, so the group is one short for the replacement's launch time.
 * - With Capacity Rebalancing (`ec2-auto-scaling-capacity-rebalancing.html`) a rebalance recommendation comes first, a
 *   lead time before the notice: the group launches a replacement at once (it may go over its maximum by 10% or one
 *   instance) and, when the replacement is InService, terminates the at-risk instance, which drains as any instance the
 *   group terminates. If the replacement isn't up by the interruption, the interruption takes the old one anyway.
 *
 * Interruptions reach only Spot instances that are serving and not already noticed; scale-in protection doesn't stop
 * them. The rate is read live, so a scenario can start a storm by raising it.
 */

/** The On-Demand instances a group of `n` wants: the base, then the percentage of the rest rounded up. */
export const onDemandOf = (n: number, base: number, percentAboveBase: number): number => Math.min(n, base) + Math.ceil((Math.max(0, n - base) * percentAboveBase) / 100)

/** What the interruptions need of the group. */
export interface SpotHost {
  readonly settings: () => Settings
  readonly now: () => number
  readonly after: <A>(ms: number, fire: (arg: A) => void, arg: A) => TimerHandle
  readonly random: SeededRandom
  readonly fleet: () => Fleet
  /** The purchase option an instance was launched as, if it was. */
  readonly purchaseOf: (unit: Unit) => Purchase | undefined
  /** Count an event for the group's metrics. */
  readonly count: (event: "interruption" | "recommendation") => void
}

/** One interruption under way. */
interface Interruption {
  readonly unit: Unit
  /** When EC2 terminates it. */
  readonly at: number
  timer: TimerHandle | undefined
  /** Capacity Rebalancing launched a replacement for it that isn't up yet. */
  awaiting: boolean
}

export class SpotInterruptions {
  /** Instances launched beyond the desired capacity to replace at-risk ones (Capacity Rebalancing). */
  extra = 0
  /** Running totals, for a probe. */
  readonly totals = { interruptions: 0, recommendations: 0, terminated: 0, replacedEarly: 0 }
  private readonly under = new Map<number, Interruption>()
  /** At-risk instances whose replacement is on its way, oldest first. */
  private readonly awaiting: Array<Interruption> = []
  private next: TimerHandle | undefined = undefined

  constructor(private readonly host: SpotHost) {}

  /** How many beyond the maximum size the group may go for replacements: 10% of the desired capacity, or one. */
  maxExtra(desired: number): number {
    return overMaxMargin(desired)
  }

  /** Spot instances serving and not yet interrupted. */
  private exposed(): Array<Unit> {
    const out: Array<Unit> = []
    for (const m of this.host.fleet().units) {
      if (m.serving && m.alive && !this.under.has(m.id) && this.host.purchaseOf(m) === "spot") out.push(m)
    }
    return out
  }

  /**
   * Work out when the next interruption comes, from the rate and the Spot instances exposed now. Call whenever either
   * changes: the process is memoryless, so drawing again is as good as waiting.
   */
  schedule(): void {
    this.next?.cancel()
    this.next = undefined
    const rate = this.host.settings().spot.interruptionsPerHour
    if (rate <= 0) return
    const n = this.exposed().length
    if (n === 0) return
    const perMs = (rate * n) / 3_600_000
    this.next = this.host.after(-Math.log(1 - this.host.random.nextDoubleUnsafe()) / perMs, this.due, undefined)
  }

  private readonly due = (): void => {
    this.next = undefined
    const exposed = this.exposed()
    const unit = exposed[Math.floor(this.host.random.nextDoubleUnsafe() * exposed.length)]
    if (unit !== undefined) this.interrupt(unit)
    this.schedule()
  }

  /** EC2 reclaims `unit`: a rebalance recommendation now (if the group rebalances), the notice, then termination. */
  interrupt(unit: Unit): void {
    if (this.under.has(unit.id)) return
    const c = this.host.settings().spot
    const leadMs = c.capacityRebalance ? Duration.toMillis(c.rebalanceLead) : 0
    const it: Interruption = { unit, at: this.host.now() + leadMs + SPOT_NOTICE_MS, timer: undefined, awaiting: false }
    it.timer = this.host.after(leadMs + SPOT_NOTICE_MS, this.terminate, it)
    this.under.set(unit.id, it)
    this.totals.interruptions++
    this.host.count("interruption")
    if (c.capacityRebalance) {
      this.totals.recommendations++
      this.host.count("recommendation")
      it.awaiting = true
      this.awaiting.push(it)
      this.extra++
      this.host.fleet().retry()
    }
  }

  /** An instance came up: if an at-risk one waits for a replacement, this is it, and the at-risk one can go. */
  up(unit: Unit): void {
    if (this.awaiting.length === 0 || this.under.has(unit.id)) return
    const it = this.awaiting.shift()!
    it.awaiting = false
    // Out of the fleet's own event, so the fleet isn't changed while it is telling its observers.
    this.host.after(0, this.replaced, it)
  }

  private readonly replaced = (it: Interruption): void => {
    // The replacement is up: the extra capacity it was launched as becomes the at-risk instance's, which goes now.
    this.extra = Math.max(0, this.extra - 1)
    const fleet = this.host.fleet()
    const live = it.unit.state !== "draining" && it.unit.state !== "terminated"
    if (!live) return fleet.retry()
    this.totals.replacedEarly++
    fleet.stop(it.unit)
  }

  /** The notice ran out: EC2 terminates the instance, whatever it was doing. */
  private readonly terminate = (it: Interruption): void => {
    it.timer = undefined
    this.under.delete(it.unit.id)
    if (it.awaiting) {
      // The replacement Capacity Rebalancing launched isn't up yet: it becomes the ordinary replacement.
      it.awaiting = false
      const i = this.awaiting.indexOf(it)
      if (i >= 0) this.awaiting.splice(i, 1)
      this.extra = Math.max(0, this.extra - 1)
    }
    const fleet = this.host.fleet()
    const state = it.unit.state
    if (state === "terminated") return
    this.totals.terminated++
    // A unit the group is already terminating (draining) is cut off; one still serving is too, and replaced at once.
    if (state === "draining") fleet.kill(it.unit, "Spot Instance interrupted")
    else fleet.interrupt(it.unit, 0)
  }

  /** Forget an instance that is gone (cancels its interruption, which no longer matters). */
  gone(unit: Unit): void {
    const it = this.under.get(unit.id)
    if (it === undefined) return
    it.timer?.cancel()
    this.under.delete(unit.id)
    if (it.awaiting) {
      const i = this.awaiting.indexOf(it)
      if (i >= 0) this.awaiting.splice(i, 1)
      this.extra = Math.max(0, this.extra - 1)
    }
  }

  /** Instances under notice now (or with a recommendation). */
  get noticed(): number {
    return this.under.size
  }
}
