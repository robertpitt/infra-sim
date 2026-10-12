import type { Fast, NodeFaults, Zones } from "../Component.ts"
import { type Call, type CallFailure, Failed, type Message, Unavailable } from "../Message.ts"
import type { Fleet as Offer, HealthAnswer, Unit, UnitChange, UnitState } from "../Protocol.ts"
import type { SeededRandom } from "../SeededRandom.ts"
import type { TimerHandle } from "../VirtualTime.ts"
import { DONE, HELD, type Job, Line, Member, type Phase, RUNNING, Ticket, type TicketOwner, WAITING_LINE, WAITING_UNIT } from "./Unit.ts"

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
 * Everything per call is synchronous and allocation-light (one `Ticket`); nothing here uses an `Effect`.
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
export const REFUSED_FULL = "503 every worker busy and the queue full"
export const REFUSED_UNIT_BUSY = "503 the unit's workers are busy and its backlog full"
export const REFUSED_UNIT_GONE = "connection refused: the unit is not running"

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

const DOWN: HealthAnswer = { up: false }
const HEALTHY: HealthAnswer = { up: true, healthy: true, ms: 0 }
const SICK: HealthAnswer = { up: true, healthy: false, ms: 0 }
const RETRY_MS = 10_000
/** How often a fleet with interruptions configured but none due looks again, in case the rate was raised. */
const INTERRUPTION_RECHECK_MS = 10_000

export class Fleet implements TicketOwner {
  /** Every unit that isn't terminated, in launch order. */
  readonly units: Array<Member> = []
  /** How many units are in each state right now. */
  readonly count: Record<UnitState, number> = { requested: 0, starting: 0, grace: 0, inService: 0, draining: 0, terminated: 0 }
  /** Workers busy, over every unit. */
  busy = 0
  /** Calls waiting: in the fleet's line and in units' backlogs. */
  waiting = 0
  /** Units in a serving state that are dead and not yet noticed: counted in `count`, but serving nothing. */
  private dead = 0
  /** Running totals, for a probe. */
  readonly totals = { launched: 0, terminated: 0, replaced: 0, interrupted: 0, refusedLaunches: 0, lostCalls: 0 }

  private readonly line = new Line()
  /** Units with a free worker and nothing in their backlog, for plain calls: the idealised balancer's choice. */
  private readonly free: Array<Member> = []
  private cursor = 0
  private seq = 0
  private readonly listeners = new Set<(unit: Unit, change: UnitChange) => void>()
  /** Who `observe`s it (a host pool built on it): told of deaths too. */
  private readonly observers = new Set<(unit: Unit, event: UnitEvent) => void>()
  /** Zones of the fleet known to be down. */
  private readonly down = new Set<string>()
  /** A unit launched beyond the desired number to even out the zones; one of the fullest zone's goes when it is up. */
  private rebalancer: Member | undefined = undefined
  /** Zones may be uneven (one came back, the zones changed, a step of rebalancing finished): look. */
  private unbalanced = false
  private reconciling = false
  private again = false
  private retryTimer: TimerHandle | undefined = undefined
  /** The fleet's own stream, so its draws (interruptions, zone errors) move nothing else's. */
  private readonly random: SeededRandom

  constructor(private readonly host: Host, private readonly options: Options) {
    this.random = host.fast.random.fork("fleet")
    options.hosts?.bind(this)
    for (const zone of this.zonesList()) if (host.zones.down(zone)) this.down.add(zone)
    // The fleet exists before the simulation starts: its first units are already in service.
    const first = this.target()
    for (let i = 0; i < first; i++) {
      const m = this.create()
      if (!this.place(m)) continue
      this.setState(m, "inService")
      m.announced = true
      this.updateFree(m)
    }
    host.zones.watch(() => this.zonesChanged())
    if (options.interruptions !== undefined) this.nextInterruption()
    host.faults?.watch(() => this.crashes())
  }

  /** `Crash` faults already acted on: one crashes its units once, when it is injected. */
  private readonly crashed = new Set<string>()

  /**
   * A `Crash` fault on the node, for this fleet's kind of unit (`role`): that many of its serving units, picked at random,
   * die at once, as an instance's hardware fails or a container is OOM-killed.
   */
  private crashes(): void {
    const role = this.options.role ?? "units"
    for (const active of this.host.faults!.active()) {
      const fault = active.fault
      if (fault._tag !== "Crash" || active.target.kind !== "node" || this.crashed.has(active.id) || fault.on !== role) continue
      this.crashed.add(active.id)
      const serving = this.units.filter((m) => m.serving && m.alive)
      for (let i = 0; i < fault.units && serving.length > 0; i++) {
        const [victim] = serving.splice(Math.floor(this.random.nextDoubleUnsafe() * serving.length), 1)
        this.kill(victim!, "the unit crashed")
      }
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Calls
  // ---------------------------------------------------------------------------------------------------------

  /**
   * Take a call. Without `unit` it is a plain call: it runs on the first unit with a free worker, or waits in the fleet's
   * line. With one (a balancer's choice) it runs on that unit, or waits in its backlog. Answers the call's ticket (the
   * job's `start` may already have run) or why it was refused.
   */
  admit(job: Job, unit?: Unit): Admission {
    if (unit === undefined) {
      if (this.line.live === 0) {
        const m = this.pickFree(this.options.workers())
        if (m !== undefined) {
          const t = new Ticket(this, job)
          m.attach(t)
          this.run(t, m, this.options.workers())
          return t
        }
      }
      if (this.line.live >= this.options.line()) return REFUSED_FULL
      const t = new Ticket(this, job)
      t.state = WAITING_LINE
      this.line.push(t)
      this.waiting++
      return t
    }
    const m = unit as Member
    if (m.owner !== this || !m.alive || !(m.serving || m.state === "draining")) return REFUSED_UNIT_GONE
    const queued = m.backlog?.live ?? 0
    const workers = this.options.workers()
    if (queued === 0 && m.running < workers) {
      const t = new Ticket(this, job)
      m.attach(t)
      this.run(t, m, workers)
      return t
    }
    if (queued >= this.options.backlog()) return REFUSED_UNIT_BUSY
    const t = new Ticket(this, job)
    t.state = WAITING_UNIT
    m.attach(t)
    ;(m.backlog ??= new Line()).push(t)
    this.waiting++
    this.updateFree(m, workers)
    return t
  }

  /** Give a ticket a worker on `m` and start its work, after its zone's delay if the zone is slow. */
  private run(t: Ticket, m: Member, workers: number): void {
    t.state = RUNNING
    m.running++
    this.busy++
    this.updateFree(m, workers)
    if (m.zone !== undefined) {
      const f = this.host.zones.effect(m.zone)
      if (f.extraMs > 0 || f.errorRate > 0) {
        t.fails = f.errorRate > 0 && this.random.nextDoubleUnsafe() < f.errorRate
        t.delay = this.host.fast.after(f.extraMs, this.delayed, t)
        return
      }
    }
    t.job.start(t)
  }

  private readonly delayed = (t: Ticket): void => {
    t.delay = undefined
    if (t.state !== RUNNING) return
    if (!t.fails) return t.job.start(t)
    this.finishTicket(t)
    t.job.fail(Failed({ node: this.host.id, reason: `injected error in ${t.unit?.zone ?? "its zone"}` }))
  }

  /** @internal `Ticket.release`. */
  releaseTicket(t: Ticket): void {
    if (t.state !== RUNNING) return
    const m = t.unit!
    t.state = HELD
    m.running--
    this.busy--
    this.fill(m)
  }

  /** @internal `Ticket.finish`. */
  finishTicket(t: Ticket): void {
    const state = t.state
    if (state === DONE) return
    t.state = DONE
    if (state === WAITING_LINE) {
      this.line.live--
      this.waiting--
      return
    }
    const m = t.unit!
    if (state === WAITING_UNIT) {
      m.backlog!.live--
      this.waiting--
    } else if (state === RUNNING) {
      t.delay?.cancel()
      t.delay = undefined
      m.running--
      this.busy--
    }
    m.detach(t)
    if (m.state === "draining" && m.attached === 0 && m.holds === 0) return this.terminate(m)
    if (state !== HELD) this.fill(m)
  }

  /** Give `m`'s free workers to what waits: its own backlog first, then (if it is serving) the fleet's line. */
  private fill(m: Member): void {
    const workers = this.options.workers()
    while (m.alive && m.running < workers && (this.waiting > 0)) {
      let t = m.backlog !== undefined && m.backlog.live > 0 ? m.backlog.shift() : undefined
      if (t === undefined && m.serving && this.line.live > 0) {
        t = this.line.shift()
        if (t !== undefined) m.attach(t)
      }
      if (t === undefined) break
      this.waiting--
      this.run(t, m, workers)
    }
    this.updateFree(m, workers)
  }

  /** Keep `free` exactly the units a plain call may start on now. */
  private updateFree(m: Member, workers = this.options.workers()): void {
    const eligible = m.alive && m.serving && m.running < workers && (m.backlog === undefined || m.backlog.live === 0)
    if (eligible && m.freeIndex < 0) {
      m.freeIndex = this.free.length
      this.free.push(m)
    } else if (!eligible && m.freeIndex >= 0) this.removeFree(m)
  }

  private removeFree(m: Member): void {
    const i = m.freeIndex
    if (i < 0) return
    const last = this.free.pop()!
    if (last !== m) {
      this.free[i] = last
      last.freeIndex = i
    }
    m.freeIndex = -1
  }

  /** A unit with a free worker, taking turns so that work spreads over them. */
  private pickFree(workers: number): Member | undefined {
    while (this.free.length > 0) {
      if (this.cursor >= this.free.length) this.cursor = 0
      const m = this.free[this.cursor]!
      // Fewer workers per unit than when it joined the set (a live edit not yet refreshed): it has none free.
      if (m.running < workers) {
        this.cursor++
        return m
      }
      this.removeFree(m)
    }
    return undefined
  }

  // ---------------------------------------------------------------------------------------------------------
  // Life of a unit
  // ---------------------------------------------------------------------------------------------------------

  private create(): Member {
    const id = ++this.seq
    const m = new Member(this, id, this.options.name?.(id) ?? `unit-${id}`, this.host.fast.now())
    this.units.push(m)
    this.count.requested++
    this.totals.launched++
    return m
  }

  private setState(m: Member, next: UnitState): void {
    if (!m.alive && m.serving) this.dead--
    this.count[m.state]--
    this.count[next]++
    m.state = next
    m.since = this.host.fast.now()
    if (!m.alive && m.serving) this.dead++
  }

  /**
   * Find a requested unit a zone and the account's capacity. False if there is neither yet: it stays requested and is
   * tried again (when a zone comes back, or after the capacity retry).
   */
  private place(m: Member): boolean {
    const zones = this.zonesList()
    if (this.options.hosts !== undefined) return this.placeOnHost(m, zones)
    let zone: string | undefined
    if (zones.length > 0) {
      // The zone with the fewest units, of those that are up: how EC2 Auto Scaling and ECS spread.
      let fewest = Infinity
      for (const z of zones) {
        if (this.down.has(z)) continue
        const n = this.liveIn(z)
        if (n < fewest) {
          fewest = n
          zone = z
        }
      }
      if (zone === undefined) return false
    }
    if (!this.takeCapacity(m)) return false
    m.zone = zone
    return true
  }

  private takeCapacity(m: Member): boolean {
    const capacity = this.options.capacity
    if (capacity === undefined) return true
    if (!capacity.take(m)) {
      this.totals.refusedLaunches++
      this.retryTimer ??= this.host.fast.after(capacity.retryMs ?? RETRY_MS, this.retryLaunches, undefined)
      return false
    }
    m.holdsCapacity = true
    return true
  }

  /**
   * Place a unit on a host (`Options.hosts`): the account's capacity first, then room on a host in one of the zones that
   * are up, the emptiest first, so tenants spread over zones as ECS's and Kubernetes' schedulers spread them. Its zone is
   * its host's. No room: it stays requested, and the pool calls `retry` when room is made.
   */
  private placeOnHost(m: Member, zones: ReadonlyArray<string>): boolean {
    const up: Array<string> = []
    const counts: Array<number> = []
    for (const z of zones) {
      if (this.down.has(z)) continue
      const n = this.liveIn(z)
      let i = counts.length
      while (i > 0 && counts[i - 1]! > n) i--
      up.splice(i, 0, z)
      counts.splice(i, 0, n)
    }
    if (zones.length > 0 && up.length === 0) return false
    if (!this.takeCapacity(m)) return false
    const host = this.options.hosts!.place(m, up, counts)
    if (host === undefined) {
      if (m.holdsCapacity) {
        m.holdsCapacity = false
        this.options.capacity?.give(m)
      }
      return false
    }
    m.onHost = true
    m.zone = host.zone
    return true
  }

  private readonly retryLaunches = (): void => {
    this.retryTimer = undefined
    this.reconcile()
  }

  /** Launch a requested unit, if it can be placed: through its phases, then up. */
  private launch(m: Member): boolean {
    if (!this.place(m)) return false
    this.setState(m, "starting")
    m.phases = this.options.phases(m)
    m.phase = -1
    this.nextPhase(m)
    return true
  }

  private nextPhase(m: Member): void {
    while (++m.phase < m.phases.length) {
      const ms = m.phases[m.phase]!.ms
      if (ms > 0) {
        m.timer = this.host.fast.after(ms, this.phaseDone, m)
        return
      }
    }
    this.up(m)
  }

  private readonly phaseDone = (m: Member): void => {
    m.timer = undefined
    this.nextPhase(m)
  }

  /** Started: up and serving, in its grace period if there is one. Balancers hear about it; waiting calls get its workers. */
  private up(m: Member): void {
    const grace = this.options.grace?.() ?? 0
    this.setState(m, grace > 0 ? "grace" : "inService")
    if (grace > 0) m.timer = this.host.fast.after(grace, this.graceOver, m)
    m.announced = true
    this.emit(m, "up")
    this.fill(m)
    if (m === this.rebalancer) {
      // The extra unit is up: now one of the fullest zone's can go.
      this.rebalancer = undefined
      this.unbalanced = true
      const victim = this.servingVictim(m)
      if (victim !== undefined) this.drain(victim, this.drainMs())
      this.reconcile()
    }
  }

  private readonly graceOver = (m: Member): void => {
    m.timer = undefined
    this.setState(m, "inService")
    // What was noticed during the grace period counts now.
    if (m.detected || (!m.reportedHealthy && this.replacesUnhealthy())) this.replace(m)
  }

  /**
   * Stop sending `m` work and let it finish what it holds, for at most `ms`; it stops as soon as it holds nothing.
   * A `hard` drain (an interruption's notice) can't be extended by balancers.
   */
  private drain(m: Member, ms: number, hard = false): void {
    if (m.state === "draining" || m.state === "terminated") return
    if (!m.serving) return this.terminate(m)
    m.timer?.cancel()
    this.removeFree(m)
    this.setState(m, "draining")
    m.drainUntil = this.host.fast.now() + ms
    m.hardDrain = hard
    m.timer = this.host.fast.after(ms, this.drainOver, m)
    this.emit(m, "draining")
    if ((m.attached === 0 && m.holds === 0) || !m.alive) this.terminate(m)
  }

  private readonly drainOver = (m: Member): void => {
    m.timer = undefined
    this.lose(m, "cut off: its unit stopped before the call finished")
    this.terminate(m)
  }

  private terminate(m: Member): void {
    if (m.state === "terminated") return
    m.timer?.cancel()
    m.detection?.cancel()
    m.timer = m.detection = undefined
    this.removeFree(m)
    if (m.attached > 0) this.lose(m, "cut off: its unit stopped before the call finished")
    if (m.holdsCapacity) {
      m.holdsCapacity = false
      this.options.capacity?.give(m)
    }
    this.setState(m, "terminated")
    this.totals.terminated++
    const i = this.units.indexOf(m)
    if (i >= 0) this.units.splice(i, 1)
    if (m === this.rebalancer) this.rebalancer = undefined
    // Its room on its host goes back once it is gone, so a fleet the pool tells of the room sees it gone too.
    if (m.onHost) {
      m.onHost = false
      this.options.hosts?.release(m)
    }
    if (m.announced) this.emit(m, "gone")
    // Observers hear of every unit that goes, even one that never came up (a task that crashed as it started).
    else if (this.observers.size > 0) this.tell(m, "gone")
    this.reconcile()
  }

  /** Fail every call on `m`: it can't finish them. */
  private lose(m: Member, reason: string): void {
    if (m.attached === 0) return
    const tickets = m.detachAll()
    for (const t of tickets) {
      if (t.state === RUNNING) {
        t.delay?.cancel()
        t.delay = undefined
        this.busy--
      } else if (t.state === WAITING_UNIT) this.waiting--
      t.state = DONE
    }
    m.running = 0
    this.removeFree(m)
    this.totals.lostCalls += tickets.length
    const failure: CallFailure = Unavailable({ node: this.host.id, reason })
    for (const t of tickets) t.job.fail(failure)
  }

  /**
   * `m` died: it answers nothing, and the calls on it fail. One still starting simply failed to launch and goes now;
   * one that was up is replaced once the fleet notices (`detect`), or a balancer reports it.
   */
  kill(unit: Unit, reason = "its unit died"): void {
    const m = unit as Member
    if (m.owner !== this || !m.alive || m.state === "terminated") return
    m.alive = false
    if (m.announced) this.tell(m, "dead")
    if (m.state === "requested" || m.state === "starting") return this.terminate(m)
    if (m.serving) this.dead++
    this.lose(m, reason)
    if (m.state === "draining") return this.terminate(m)
    const ms = this.options.detect?.() ?? Infinity
    if (Number.isFinite(ms)) m.detection = this.host.fast.after(ms, this.noticed, m)
  }

  private readonly noticed = (m: Member): void => {
    m.detection = undefined
    if (m.state === "terminated") return
    if (m.state === "grace") m.detected = true
    else this.replace(m)
  }

  /** Let `m` go and start another in its place: dead ones at once, live ones after a drain. */
  private replace(m: Member): void {
    if (!m.live) return
    this.totals.replaced++
    if (!m.alive) this.terminate(m)
    else this.drain(m, this.drainMs())
    this.reconcile()
  }

  /**
   * Interrupt a unit with a notice, as Spot reclaims an instance (two minutes) or a Fargate Spot task: it stops taking
   * work at once, a replacement is launched at once, and it is cut off when the notice runs out.
   */
  interrupt(unit: Unit, noticeMs: number): void {
    const m = unit as Member
    if (m.owner !== this || !m.live) return
    this.totals.interrupted++
    this.drain(m, noticeMs, true)
    this.reconcile()
  }

  /** What its health endpoint answers, for a unit that is up: a unit can be up and failing its checks. */
  setHealthy(unit: Unit, healthy: boolean): void {
    const m = unit as Member
    if (m.owner === this) m.healthy = healthy
  }

  // ---------------------------------------------------------------------------------------------------------
  // Keeping the numbers
  // ---------------------------------------------------------------------------------------------------------

  /**
   * Bring the fleet to what it should be: tell it after the component's settings change (`refresh`). It launches what is
   * missing, lets go of what is extra, and evens out the zones, in that order.
   */
  refresh(): void {
    // Units in zones the fleet no longer spreads over move to the ones it does.
    const zones = this.zonesList()
    if (zones.length > 0) {
      for (const m of [...this.units]) if (m.live && m.zone !== undefined && !zones.includes(m.zone)) this.drain(m, this.drainMs())
      for (const z of [...this.down]) if (!zones.includes(z)) this.down.delete(z)
      for (const z of zones) if (this.host.zones.down(z)) this.down.add(z)
      this.unbalanced = true
    }
    this.reconcile()
    // More workers per unit take waiting calls at once; fewer stop taking new ones.
    for (const m of [...this.units]) this.fill(m)
  }

  private reconcile(): void {
    if (this.reconciling) {
      this.again = true
      return
    }
    this.reconciling = true
    try {
      do {
        this.again = false
        if (this.count.requested > 0) this.launchRequested()
        const want = this.target() + (this.rebalancer === undefined ? 0 : 1)
        const live = this.count.requested + this.count.starting + this.count.grace + this.count.inService
        if (live < want) {
          for (let i = live; i < want; i++) this.launch(this.create())
        } else if (live > want) this.scaleIn(live - want)
        else if (this.rebalancer === undefined) this.rebalance()
      } while (this.again)
    } finally {
      this.reconciling = false
    }
  }

  private launchRequested(): void {
    for (const m of [...this.units]) {
      if (m.state !== "requested") continue
      if (!this.launch(m)) break
    }
  }

  /** Let `n` units go: ones not yet started first (the newest), then serving ones (see `servingVictim`). */
  private scaleIn(n: number): void {
    for (; n > 0; n--) {
      const pending = this.pendingVictim()
      if (pending !== undefined) {
        this.terminate(pending)
        continue
      }
      const victim = this.servingVictim(undefined)
      if (victim === undefined) return
      this.drain(victim, this.drainMs())
    }
  }

  private pendingVictim(): Member | undefined {
    for (const state of ["requested", "starting"] as const) {
      if (this.count[state] === 0) continue
      for (let i = this.units.length - 1; i >= 0; i--) if (this.units[i]!.state === state) return this.units[i]
    }
    return undefined
  }

  /**
   * Which serving unit to let go: one from the zone with the most units serving (so the zones stay even, as EC2 Auto
   * Scaling does), the newest or the oldest there. Never `spare`.
   */
  private servingVictim(spare: Member | undefined): Member | undefined {
    let zone: string | undefined
    let most = 0
    for (const z of this.zonesList()) {
      const n = this.servingIn(z) - (spare?.zone === z ? 1 : 0)
      if (n > most) {
        most = n
        zone = z
      }
    }
    const oldest = this.options.scaleIn?.() === "oldest"
    const protect = this.options.protect
    const pick = this.options.pick
    const n = this.units.length
    for (const inZone of zone === undefined ? [false] : [true, false]) {
      if (pick !== undefined) {
        const candidates = this.units.filter((m) => m.serving && m !== spare && (!inZone || m.zone === zone) && (protect === undefined || !protect(m)))
        const chosen = candidates.length > 0 ? (pick(candidates) as Member | undefined) : undefined
        if (chosen !== undefined && candidates.includes(chosen)) return chosen
      }
      for (let k = 0; k < n; k++) {
        const m = this.units[oldest ? k : n - 1 - k]!
        if (m.serving && m !== spare && (!inZone || m.zone === zone) && (protect === undefined || !protect(m))) return m
      }
    }
    return undefined
  }

  /**
   * After a zone comes back (or the zones change), units are uneven: launch one more in the emptiest zone, and when it is
   * up let one go from the fullest (`up`), until no zone has two more than another. New before old, so rebalancing never
   * leaves the fleet short, as EC2 Auto Scaling's AZRebalance does.
   */
  private rebalance(): void {
    if (!this.unbalanced) return
    if (this.options.rebalance?.() === false) {
      this.unbalanced = false
      return
    }
    const zones = this.zonesList()
    let fewest = Infinity
    let most = -1
    for (const z of zones) {
      if (this.down.has(z)) continue
      const n = this.liveIn(z)
      if (n < fewest) fewest = n
      if (n > most) most = n
    }
    if (zones.length < 2 || most - fewest <= 1) {
      this.unbalanced = false
      return
    }
    const m = this.create()
    this.rebalancer = m
    // No capacity for the extra unit, or (on hosts) room only in a zone no emptier than the rest: leave the zones as they
    // are until something changes, as ECS's AZ rebalancing does when it can't place a task where it is short.
    if (!this.launch(m) || (m.zone !== undefined && this.liveIn(m.zone) - 1 > fewest)) {
      this.unbalanced = false
      this.rebalancer = undefined
      this.terminate(m)
    }
  }

  private zonesChanged(): void {
    const zones = this.zonesList()
    let changed = false
    for (const z of zones) {
      const isDown = this.host.zones.down(z)
      if (isDown === this.down.has(z)) continue
      changed = true
      if (isDown) {
        this.down.add(z)
        for (const m of [...this.units]) if (m.zone === z) this.kill(m, `connection reset: ${z} went down`)
      } else {
        this.down.delete(z)
        this.unbalanced = true
      }
    }
    if (changed) this.reconcile()
  }

  private nextInterruption(): void {
    const spec = this.options.interruptions?.()
    const serving = this.count.grace + this.count.inService
    if (spec === undefined || spec.perUnitHour <= 0 || serving === 0) {
      this.host.fast.after(INTERRUPTION_RECHECK_MS, this.interruptionDue, false)
      return
    }
    const perMs = (spec.perUnitHour * serving) / 3_600_000
    // Interruptions are memoryless, so drawing again later is exact: a wait past the recheck is cut short and redrawn
    // then, so a rate raised (or more units serving) is felt within a recheck, not after a draw made at the old rate.
    const wait = -Math.log(1 - this.random.nextDoubleUnsafe()) / perMs
    if (wait > INTERRUPTION_RECHECK_MS) this.host.fast.after(INTERRUPTION_RECHECK_MS, this.interruptionDue, false)
    else this.host.fast.after(wait, this.interruptionDue, true)
  }

  private readonly interruptionDue = (due: boolean): void => {
    const spec = this.options.interruptions?.()
    if (due && spec !== undefined && spec.perUnitHour > 0) {
      const serving = this.units.filter((m) => m.serving && m.alive)
      const victim = serving[Math.floor(this.random.nextDoubleUnsafe() * serving.length)]
      if (victim !== undefined) this.interrupt(victim, spec.noticeMs)
    }
    this.nextInterruption()
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

  private check(m: Member): HealthAnswer {
    if (m.owner !== this || !m.alive || m.state === "terminated") return DOWN
    if (m.zone !== undefined) {
      const f = this.host.zones.effect(m.zone)
      if (f.outage) return DOWN
      if (f.extraMs > 0) return { up: true, healthy: m.healthy, ms: f.extraMs }
    }
    return m.healthy ? HEALTHY : SICK
  }

  private report(m: Member, healthy: boolean): void {
    if (m.owner !== this) return
    m.reportedHealthy = healthy
    if (!healthy && m.state === "inService" && this.replacesUnhealthy()) this.replace(m)
  }

  private holdDraining(m: Member, ms: number): void {
    if (m.owner !== this || m.state !== "draining" || m.hardDrain) return
    const until = this.host.fast.now() + ms
    if (until <= m.drainUntil) return
    m.drainUntil = until
    m.timer?.cancel()
    m.timer = this.host.fast.after(ms, this.drainOver, m)
  }

  private emit(m: Member, change: UnitChange): void {
    if (this.observers.size > 0) this.tell(m, change)
    if (this.listeners.size === 0) return
    for (const listener of [...this.listeners]) listener(m, change)
  }

  private tell(m: Member, event: UnitEvent): void {
    for (const observer of [...this.observers]) observer(m, event)
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

  /**
   * Try again now to launch the units waiting for capacity or a host, and to scale in units that were protected: room was
   * made (a host came up, a tenant left one), or a protection was lifted.
   */
  retry(): void {
    this.reconcile()
  }

  /**
   * Let one unit go: it drains (no new calls, finishes what it holds) and the fleet then launches whatever brings it back
   * to `desired`. Lower `desired` first to remove it for good (an autoscaler removing the node it chose, a deployment
   * stopping an old task); leave `desired` as it is to have it replaced (a pod evicted from a node being drained).
   */
  stop(unit: Unit): void {
    const m = unit as Member
    if (m.owner !== this || !m.live) return
    this.drain(m, this.drainMs())
    this.reconcile()
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
    const m = unit as Member
    if (m.owner !== this || m.holds === 0) return
    m.holds--
    if (m.state === "draining" && m.attached === 0 && m.holds === 0) this.terminate(m)
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
  servingIn(zone: string): number {
    let n = 0
    for (const m of this.units) if (m.serving && m.alive && m.zone === zone) n++
    return n
  }

  /** Every unit, for a probe. */
  snapshot(): ReadonlyArray<UnitReport> {
    return this.units.map((m) => ({ id: m.id, name: m.name, zone: m.zone, state: m.state, phase: m.phaseName, alive: m.alive, busy: m.running, queued: m.backlog?.live ?? 0 }))
  }

  /** The zones it spreads over now (its options' zones). */
  zonesList(): ReadonlyArray<string> {
    return this.options.zones?.() ?? []
  }

  private liveIn(zone: string): number {
    let n = 0
    for (const m of this.units) if (m.live && m.zone === zone) n++
    return n
  }

  private target(): number {
    const lo = this.options.min?.() ?? 0
    const hi = this.options.max?.() ?? Infinity
    return Math.max(0, Math.min(hi, Math.max(lo, Math.round(this.options.desired()))))
  }

  private drainMs(): number {
    return this.options.drain?.() ?? 0
  }

  private replacesUnhealthy(): boolean {
    return this.options.replaceUnhealthy?.() ?? true
  }
}
