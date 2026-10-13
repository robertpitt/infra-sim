import type { Unit } from "../Protocol.ts"
import type { TimerHandle } from "../VirtualTime.ts"
import type { Fleet } from "./Fleet.ts"
import { isLive, isServing } from "./Unit.ts"

/**
 * A rolling replacement of a fleet's units by a new version of them: an ECS service deploying a new task definition
 * (`minimumHealthyPercent`, `maximumPercent`), a Kubernetes Deployment's rolling update (`maxUnavailable`, `maxSurge`),
 * an EC2 Auto Scaling instance refresh (`MinHealthyPercentage`, `MaxHealthyPercentage`). They are one algorithm with two
 * bounds:
 *
 *  - **at most `maxTotal` units live** (requested, starting or serving, old and new together): room for new ones;
 *  - **at least `minHealthy` units healthy**: old units are stopped only while that stays true.
 *
 * Each step stops the old units it may (the unhealthy ones first: starting, dead), then launches new ones up to the room
 * left. A new unit counts as healthy once it has been up for `healthyAfter` (ECS waits 40 s after RUNNING with no health
 * checks; a Deployment's `minReadySeconds`); as each does, more old ones go. When no old unit is left it is done.
 *
 * The rollout drives the fleet through its `desired`: give the fleet `desired: () => rollout.target()`. In steady state
 * that is the component's own desired count; during a rollout it is the number of units the rollout wants live, and the
 * old units it stops are named (`Fleet.stop`), never left to scale-in's choice. Units are stamped with the version
 * that is current when they launch (`stamp`, from the fleet's `phases`).
 */

export interface RolloutOptions {
  /** The version units should run now (a task definition revision, a pod template hash). */
  readonly version: () => number
  /** Units wanted once the rollout is done: the component's desired count (an autoscaler may change it meanwhile). */
  readonly desired: () => number
  /** Most units live at once while rolling, given the desired count. */
  readonly maxTotal: (desired: number) => number
  /** Fewest units healthy while rolling, given the desired count. */
  readonly minHealthy: (desired: number) => number
  /** How long a new unit must have been up (serving and alive) before it counts as healthy, in ms. */
  readonly healthyAfter: () => number
  /**
   * Whether a unit passes its health checks (an ECS container health check, a readiness probe): one that doesn't never
   * counts as healthy, however long it has been up. Default: every unit does.
   */
  readonly ok?: (unit: Unit) => boolean
  /** Virtual time and timers: a component's `node.fast`. */
  readonly now: () => number
  readonly after: <A>(ms: number, fire: (arg: A) => void, arg: A) => TimerHandle
  /** Told when a rollout finishes: every live unit runs `version` and enough are healthy. */
  readonly done?: (version: number) => void
  /**
   * While rolling, a unit that replaces an old one the rollout meant to keep (evicted, or lost with its node) runs the old
   * version: a Kubernetes ReplicaSet recreates its own pods from its own template. Off (ECS): every launch runs `version`.
   */
  readonly replaceInKind?: boolean
}

/** Where a rollout is, for a probe. */
export interface RolloutStatus {
  readonly version: number
  readonly rolling: boolean
  readonly old: number
  readonly fresh: number
  readonly freshHealthy: number
  readonly target: number
}

export class Rollout {
  private fleet: Fleet | undefined = undefined
  /** The version each unit was launched with, by unit id. Units there before `attach` run the version current then. */
  private readonly versions = new Map<number, number>()
  /** When each unit came up, by unit id. Units there before `attach` count as long up. */
  private readonly upAt = new Map<number, number>()
  private baseline = 0
  /** What `target` answers while rolling. */
  private current = 0
  private rolling = false
  /** Old units the last step meant to keep, and the version they run. */
  private oldKept = 0
  private previous = 0
  private stepping = false
  private again = false
  /** Old units it stopped, rollouts begun and rollouts completed, over its life. */
  readonly totals = { stopped: 0, rollouts: 0, completed: 0 }

  constructor(private readonly options: RolloutOptions) {}

  /** Start following a fleet built with `desired: () => rollout.target()`. Call once, right after making the fleet. */
  attach(fleet: Fleet): void {
    this.fleet = fleet
    this.baseline = this.options.version()
    for (const u of fleet.units) this.versions.set(u.id, this.baseline)
    fleet.observe((unit, event) => {
      if (event === "up") {
        this.upAt.set(unit.id, this.options.now())
        // Look again when it has been up long enough to count as healthy.
        const wait = this.options.healthyAfter()
        if (wait > 0 && this.rolling) this.options.after(wait, this.later, undefined)
      } else if (event === "gone") {
        this.versions.delete(unit.id)
        this.upAt.delete(unit.id)
      }
      if (this.rolling || this.versionOf(unit) !== this.options.version()) this.step()
    })
  }

  /** Record the version a unit is launched with: call it from the fleet's `phases(unit)`. */
  stamp(unit: Unit): void {
    if (this.options.replaceInKind === true && this.rolling && this.fleet !== undefined) {
      const v = this.options.version()
      let old = 0
      for (const u of this.fleet.units) if (u !== unit && isLive(u) && this.versionOf(u) !== v) old++
      if (old < this.oldKept) {
        this.versions.set(unit.id, this.previous)
        return
      }
    }
    this.versions.set(unit.id, this.options.version())
  }

  versionOf(unit: Unit): number {
    return this.versions.get(unit.id) ?? this.baseline
  }

  /** Whether a unit counts as healthy: serving, alive, passing its health checks, and up long enough. */
  healthy(unit: Unit): boolean {
    if (!isServing(unit)) return false
    // A fleet's own units say whether they are alive; a dead one is still "serving" until the fleet notices.
    if ((unit as { readonly alive?: boolean }).alive === false) return false
    if (this.options.ok !== undefined && !this.options.ok(unit)) return false
    const at = this.upAt.get(unit.id)
    return at === undefined || this.options.now() - at >= this.options.healthyAfter()
  }

  /** The number of units the fleet should keep live now: give it to the fleet as its `desired`. */
  target(): number {
    return this.rolling ? this.current : this.options.desired()
  }

  get inProgress(): boolean {
    return this.rolling
  }

  status(): RolloutStatus {
    const v = this.options.version()
    let old = 0
    let fresh = 0
    let freshHealthy = 0
    for (const u of this.fleet?.units ?? []) {
      if (!isLive(u)) continue
      if (this.versionOf(u) === v) {
        fresh++
        if (this.healthy(u)) freshHealthy++
      } else old++
    }
    return { version: v, rolling: this.rolling, old, fresh, freshHealthy, target: this.target() }
  }

  private readonly later = (): void => this.step()

  /** Look at the fleet and move the rollout on: call it when the version or the desired count changes. */
  step(): void {
    const fleet = this.fleet
    if (fleet === undefined) return
    if (this.stepping) {
      this.again = true
      return
    }
    this.stepping = true
    try {
      do {
        this.again = false
        this.move(fleet)
      } while (this.again)
    } finally {
      this.stepping = false
    }
  }

  private move(fleet: Fleet): void {
    const v = this.options.version()
    const desired = Math.max(0, Math.round(this.options.desired()))
    const inKind = this.options.replaceInKind === true
    // Units still waiting to launch have no version yet: they take one as they launch (`stamp`).
    const old: Array<Unit> = []
    let fresh = 0
    let freshHealthy = 0
    let live = 0
    for (const u of fleet.units) {
      if (!isLive(u)) continue
      live++
      if (u.state === "requested") continue
      if (this.versionOf(u) === v) {
        fresh++
        if (this.healthy(u)) freshHealthy++
      } else old.push(u)
    }
    // Replacing in kind, old units the last step kept but that are gone (evicted, lost) are still owed: their ReplicaSet
    // recreates them.
    const owed = inKind && this.rolling ? Math.max(0, this.oldKept - old.length) : 0
    if (old.length === 0 && owed === 0) {
      this.oldKept = 0
      if (this.rolling) {
        this.rolling = false
        this.totals.completed++
        this.options.done?.(v)
        fleet.retry()
      }
      return
    }
    if (!this.rolling) {
      this.rolling = true
      this.totals.rollouts++
    }
    const maxTotal = Math.max(1, this.options.maxTotal(desired))
    const minHealthy = Math.max(0, this.options.minHealthy(desired))
    let oldHealthy = 0
    for (const u of old) if (this.healthy(u)) oldHealthy++
    const victims: Array<Unit> = []
    let dropped = 0
    if (inKind) {
      // Kubernetes' Deployment controller: old pods may go only as far as every pod, less the minimum available, less the
      // new pods not yet available; unhealthy ones first (cleanupUnhealthyReplicas), then healthy ones.
      let budget = old.length + owed + fresh - minHealthy - (fresh - freshHealthy)
      for (const u of old) if (budget > 0 && !this.healthy(u)) victims.push(u), budget--
      dropped = Math.max(0, Math.min(owed, budget))
      budget -= dropped
      for (let i = old.length - 1; i >= 0 && budget > 0; i--) {
        const u = old[i]!
        if (!this.healthy(u)) continue
        victims.push(u)
        budget--
      }
    } else {
      // ECS: old units that aren't healthy go first (they serve nothing), then healthy ones while enough stay healthy;
      // once the new version is all there, every old one goes.
      for (const u of old) if (!this.healthy(u)) victims.push(u)
      for (let i = old.length - 1; i >= 0; i--) {
        const u = old[i]!
        if (!this.healthy(u)) continue
        if (oldHealthy - 1 + freshHealthy < minHealthy && freshHealthy < desired) break
        victims.push(u)
        oldHealthy--
      }
    }
    const kept = old.length + owed - dropped - victims.length
    this.oldKept = kept
    if (old.length > 0) this.previous = this.versionOf(old[0]!)
    const wanted = Math.max(0, Math.min(desired, maxTotal - kept))
    // Stop the victims with the target following, so the fleet never sees a shortfall to fill or a surplus to choose from.
    this.current = live
    for (const u of victims) {
      this.current--
      this.totals.stopped++
      fleet.stop(u)
    }
    this.current = kept + Math.max(wanted, Math.min(fresh, desired))
    fleet.retry()
  }
}
