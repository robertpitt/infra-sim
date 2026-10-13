import type { Fast, NodeFaults, Zones } from "../Component.ts"
import type { Call, Message } from "../Message.ts"
import type { Fleet as Offer, Unit, UnitChange, UnitState } from "../Protocol.ts"
import * as internal from "./internal/fleet.ts"
import type { Job, Member, Phase, Ticket } from "./Unit.ts"

export { type Job, type Phase, Ticket } from "./Unit.ts"

/**
 * A fleet of identical units (EC2 instances in an Auto Scaling group, ECS tasks, Kubernetes pods, a Deployment's
 * replicas) modelled one by one: each unit has a zone, a life (requested → starting → grace → in service → draining →
 * terminated) and workers of its own. A component builds one in `make` and hands it the calls it gets; the fleet decides
 * which unit and worker each runs on, keeps the number of units at what the component's settings ask, spreads them over
 * zones, replaces the ones that die, and drains the ones it lets go.
 *
 * It is provider-neutral and has no settings of its own: every number it needs is a function in `Options`, read when it
 * matters, so the component decides what is a setting (and so what an autoscaler or a person can change while it runs).
 *
 * Calls reach units two ways:
 *  - a plain call into the node (`admit(job)`) waits in one line in front of the whole fleet and runs on whichever unit
 *    has a free worker first: an idealised balancer, which knows at once which units are dead;
 *  - a call a connector addressed to one unit (`admit(job, unit)`, from `Offer.serve`) waits in that unit's own backlog.
 *    A balancer on the edge picks the unit, by its own health checks and algorithm: see `TargetGroup.ts`.
 *
 * Everything per call is synchronous and allocation-light (one `Ticket`); nothing here uses an `Effect`. The machinery
 * (lines, placing, a unit's life, reconciling, rebalancing) is in `internal/fleet.ts`.
 */

/** Numbers the fleet reads from the component, each when it needs it. Durations are milliseconds. */
export interface Options {
  /** How many units it should run: a setting, so that an autoscaler can drive it. */
  readonly desired: () => number
  /** Bounds on `desired` (an Auto Scaling group's MinSize and MaxSize). Default: none. */
  readonly min?: () => number
  readonly max?: () => number
  /**
   * The zones to spread units over, from the node's region (`node.zones.all`). Empty or absent: units have no zone, and no
   * zone fault reaches them.
   */
  readonly zones?: () => ReadonlyArray<string>
  /** The start-up phases of a new unit, in order. Phases of 0 ms are skipped. */
  readonly phases: (unit: Unit) => ReadonlyArray<Phase>
  /** How long a unit that came up is in its grace period: up and serving, but bad health reports are ignored. Default 0. */
  readonly grace?: () => number
  /** Workers per unit: how many calls one unit works on at once. */
  readonly workers: () => number
  /** Calls that may wait in the fleet's one line for a free worker (plain calls). Past it they are refused. */
  readonly line: () => number
  /** Calls that may wait in one unit's backlog (calls a balancer addressed to it). Past it they are refused. */
  readonly backlog: () => number
  /**
   * How long a unit let go (scaled in, replaced) has to finish what it holds before it is cut off: no new calls reach it
   * meanwhile, and it stops as soon as it holds nothing. Balancers can extend it (`holdDraining`). Default 0.
   */
  readonly drain?: () => number
  /** How long until the fleet notices on its own that a unit died, and replaces it. Default: never (only balancers' reports). */
  readonly detect?: () => number
  /** Whether a balancer's report of an unhealthy unit gets it replaced. Default true. */
  readonly replaceUnhealthy?: () => boolean
  /**
   * Capacity the account must grant for each unit (vCPUs against EC2's On-Demand quota, Fargate's task quota): `take`
   * one unit's worth or refuse, `give` it back when the unit goes. A refused launch stays `requested` and is tried again
   * after `retryMs` (default 10 s). Both are told which unit, for a component whose units draw on different quotas
   * (Fargate and Fargate Spot).
   */
  readonly capacity?: { readonly take: (unit: Unit) => boolean; readonly give: (unit: Unit) => void; readonly retryMs?: number }
  /**
   * Units run on hosts (ECS tasks on container instances, pods on nodes): before a unit launches, a host pool finds it room
   * on a host (`Hosts.ts`), and the unit lives in that host's zone. With no room it stays `requested` until the pool says
   * room was made (`retry`). Absent: a unit's workers are its own (Fargate, a VM).
   */
  readonly hosts?: Placement
  /**
   * Scale-in protection: serving units it answers true for are never chosen by scale-in (EC2 Auto Scaling's instance
   * scale-in protection, which ECS's managed termination protection sets on instances running tasks). The fleet then
   * runs above `desired` until they are no longer protected and someone calls `retry`. Default: none.
   */
  readonly protect?: (unit: Unit) => boolean
  /**
   * Whether it evens out its zones when they become uneven (a zone came back): EC2 Auto Scaling's AZRebalance and ECS's
   * AZ rebalancing do; Kubernetes never moves a running pod. Default true.
   */
  readonly rebalance?: () => boolean
  /** Which units scale-in lets go first, once the zones are even: the newest (Kubernetes' choice) or the oldest. Default newest. */
  readonly scaleIn?: () => "newest" | "oldest"
  /**
   * A component's own rule for which unit scale-in (or rebalancing) lets go, once the zone is chosen: it is given the
   * serving, unprotected candidates of that zone in launch order (oldest first) and answers one of them, or `undefined`
   * to leave it to `scaleIn`. An EC2 Auto Scaling group's termination policy (the purchase option out of proportion
   * first, then the instance closest to its next billing hour) is one. Default: `scaleIn` decides.
   */
  readonly pick?: (candidates: ReadonlyArray<Unit>) => Unit | undefined
  /** What a unit is called: `i-3`, `task-3`. Default `unit-3`. */
  readonly name?: (id: number) => string
  /**
   * Units are interrupted at random (Spot reclaiming capacity), each with a notice before it is cut off: so many per
   * unit-hour. `undefined` or a rate of 0: never.
   */
  readonly interruptions?: () => { readonly perUnitHour: number; readonly noticeMs: number } | undefined
  /**
   * What this fleet's units are to its component, for the `Crash` fault: what serves (`units`, the default) or the hosts
   * another fleet's units run on (`hosts`: ECS container instances, EKS nodes).
   */
  readonly role?: "units" | "hosts"
}

/**
 * Where a fleet's units run when they run on hosts: what a host pool (`Hosts.ts`) gives a fleet of tenants as its
 * `Options.hosts`. Kept to three calls so that the fleet knows nothing of hosts beyond "find this unit room".
 */
export interface Placement {
  /** Called once, by the fleet it places units for, as it is made: the pool tells it when room is made, and kills its units whose host died. */
  readonly bind: (fleet: Fleet) => void
  /**
   * Find `unit` room on a host, in one of `zones` (the fleet's zones that are up, the one with the fewest of its units
   * first; `counts` are their units, placed ones). Answer the host (its zone becomes the unit's), or `undefined` when no
   * host has room. With no zones, any host will do.
   */
  readonly place: (unit: Unit, zones: ReadonlyArray<string>, counts: ReadonlyArray<number>) => { readonly zone: string | undefined } | undefined
  /** `unit` is gone (terminated): give back its room. */
  readonly release: (unit: Unit) => void
}

/** What `observe` hears: what a balancer hears (`UnitChange`), and a unit dying, which a balancer must find out for itself. */
export type UnitEvent = UnitChange | "dead"

/** What a fleet needs of its node: time, timers, randomness and the zones of its region. A component's `node` is one. */
export interface Host {
  readonly id: string
  readonly fast: Pick<Fast<unknown>, "now" | "after" | "random">
  readonly zones: Zones
  /** The node's faults, for the `Crash` fault: a fleet made on a node gets them; one made for a test may not. */
  readonly faults?: Pick<NodeFaults, "active" | "watch">
}

/** Why a call was refused. A string, so a component can put it in its failure as it is. */
export const REFUSED_FULL = internal.REFUSED_FULL
export const REFUSED_UNIT_BUSY = internal.REFUSED_UNIT_BUSY
export const REFUSED_UNIT_GONE = internal.REFUSED_UNIT_GONE

/** What `admit` answers: a ticket, or why there is none. */
export type Admission = Ticket | typeof REFUSED_FULL | typeof REFUSED_UNIT_BUSY | typeof REFUSED_UNIT_GONE

/** One unit, as a probe reports it. */
export interface UnitReport {
  readonly id: number
  readonly name: string
  readonly zone: string | undefined
  readonly state: UnitState
  readonly phase: string | undefined
  readonly alive: boolean
  readonly busy: number
  readonly queued: number
}

/**
 * A fleet on `host` (a component's `node`), its numbers read from `options`. Its first units are already in service:
 * the fleet exists before the simulation starts.
 */
export class Fleet extends internal.Machine {
  /** Every unit that isn't terminated, in launch order. */
  declare readonly units: Array<Member>
  /** How many units are in each state right now. */
  declare readonly count: Record<UnitState, number>
  /** Workers busy, over every unit. */
  declare busy: number
  /** Calls waiting: in the fleet's line and in units' backlogs. */
  declare waiting: number
  /** Running totals, for a probe. */
  declare readonly totals: { launched: number; terminated: number; replaced: number; interrupted: number; refusedLaunches: number; lostCalls: number }

  // ---------------------------------------------------------------------------------------------------------
  // Calls
  // ---------------------------------------------------------------------------------------------------------

  /**
   * Take a call. Without `unit` it is a plain call: it runs on the first unit with a free worker, or waits in the fleet's
   * line. With one (a balancer's choice) it runs on that unit, or waits in its backlog. Answers the call's ticket (the
   * job's `start` may already have run) or why it was refused.
   */
  admit(job: Job, unit?: Unit): Admission {
    return this.admitCall(job, unit)
  }

  // ---------------------------------------------------------------------------------------------------------
  // Life of a unit
  // ---------------------------------------------------------------------------------------------------------

  /**
   * `m` died: it answers nothing, and the calls on it fail. One still starting simply failed to launch and goes now;
   * one that was up is replaced once the fleet notices (`detect`), or a balancer reports it.
   */
  kill(unit: Unit, reason = "its unit died"): void {
    this.killUnit(unit, reason)
  }

  /**
   * Interrupt a unit with a notice, as Spot reclaims an instance (two minutes) or a Fargate Spot task: it stops taking
   * work at once, a replacement is launched at once, and it is cut off when the notice runs out.
   */
  interrupt(unit: Unit, noticeMs: number): void {
    this.interruptUnit(unit, noticeMs)
  }

  /** What its health endpoint answers, for a unit that is up: a unit can be up and failing its checks. */
  setHealthy(unit: Unit, healthy: boolean): void {
    const m = unit as Member
    if (m.owner === this) m.healthy = healthy
  }

  /**
   * Let one unit go: it drains (no new calls, finishes what it holds) and the fleet then launches whatever brings it back
   * to `desired`. Lower `desired` first to remove it for good (an autoscaler removing the node it chose, a deployment
   * stopping an old task); leave `desired` as it is to have it replaced (a pod evicted from a node being drained).
   */
  stop(unit: Unit): void {
    this.stopUnit(unit)
  }

  /**
   * Something other than calls is on the unit (a host's tenants): while anything is held, a drain waits for it as it waits
   * for calls, until the drain time runs out. `unhold` when it is gone.
   */
  hold(unit: Unit): void {
    const m = unit as Member
    if (m.owner === this) m.holds++
  }

  unhold(unit: Unit): void {
    this.unholdUnit(unit)
  }

  // ---------------------------------------------------------------------------------------------------------
  // Keeping the numbers
  // ---------------------------------------------------------------------------------------------------------

  /**
   * Bring the fleet to what it should be: tell it after the component's settings change (`refresh`). It launches what is
   * missing, lets go of what is extra, and evens out the zones, in that order.
   */
  refresh(): void {
    this.resync()
  }

  /**
   * Try again now to launch the units waiting for capacity or a host, and to scale in units that were protected: room was
   * made (a host came up, a tenant left one), or a protection was lifted.
   */
  retry(): void {
    this.reconcile()
  }

  // ---------------------------------------------------------------------------------------------------------
  // What others see
  // ---------------------------------------------------------------------------------------------------------

  /**
   * The fleet's units as a node offers them (`Instance.fleet`), for a connector that picks one per call. `serve` is the
   * component's handler for a call addressed to a unit; it should `admit(job, unit)` like its plain handler does.
   */
  offer(serve: (unit: Unit, message: Message) => Call): Offer {
    return {
      each: (visit) => {
        for (const m of this.units) if (m.serving || m.state === "draining") visit(m)
      },
      watch: (listener) => {
        this.listeners.add(listener)
        return () => void this.listeners.delete(listener)
      },
      check: (unit) => this.check(unit as Member),
      serve,
      report: (unit, healthy) => this.report(unit as Member, healthy),
      holdDraining: (unit, ms) => this.holdDraining(unit as Member, ms)
    }
  }

  /**
   * Hear about every change in its units' lives: coming up, draining, gone (every unit, even one that never came up), and
   * dying (which balancers are not told). For
   * what is built on the fleet itself, such as a pool of hosts whose tenants die with their host (`Hosts.ts`). Units
   * there before the simulation started never come `up`: read `units` when you start observing.
   */
  observe(observer: (unit: Unit, event: UnitEvent) => void): () => void {
    this.observers.add(observer)
    return () => void this.observers.delete(observer)
  }

  /** Units up and serving (in service or in their grace period), not counting dead ones the fleet hasn't noticed yet. */
  get serving(): number {
    return this.count.grace + this.count.inService - this.dead
  }

  /** Units requested or starting: on their way. */
  get pending(): number {
    return this.count.requested + this.count.starting
  }

  /** Busy workers over the workers of the units serving: 1 when there are none but there is work. */
  get utilization(): number {
    const capacity = this.serving * this.options.workers()
    return capacity === 0 ? (this.busy > 0 ? 1 : 0) : Math.min(1, this.busy / capacity)
  }

  /** Units serving in one zone (alive ones). */
  override servingIn(zone: string): number {
    return super.servingIn(zone)
  }

  /** Every unit, for a probe. */
  snapshot(): ReadonlyArray<UnitReport> {
    return this.units.map((m) => ({ id: m.id, name: m.name, zone: m.zone, state: m.state, phase: m.phaseName, alive: m.alive, busy: m.running, queued: m.backlog?.live ?? 0 }))
  }

  /** The zones it spreads over now (its options' zones). */
  zonesList(): ReadonlyArray<string> {
    return this.zones()
  }
}
