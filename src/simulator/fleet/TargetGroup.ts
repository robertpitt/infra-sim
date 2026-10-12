import { Duration, Schema } from "effect"
import * as Edge from "../Edge.ts"
import { type CallFailure, type Message, Unavailable } from "../Message.ts"
import type { Fleet, HealthAnswer, Unit } from "../Protocol.ts"
import { CROSS_ZONE_MS } from "../Provider.ts"
import type { SeededRandom } from "../SeededRandom.ts"
import * as Setting from "../Setting.ts"
import type { Counter, Meter } from "../Telemetry.ts"
import type { TimerHandle } from "../VirtualTime.ts"

/**
 * A load balancer's target group: the part of a load balancer that knows the units of one fleet, checks their health,
 * and picks one for each request. It lives on an edge into a fleet (the connector `core.target-group` is a thin wrapper,
 * see `connectors/TargetGroup.ts`), so the load balancer component in front only does what a listener does (its own
 * limits, and turning failures into 502, 503 and 504) and calls through the edge like any other.
 *
 * What it models:
 *  - **registration**: units the fleet brings up are registered (`initial` until they pass a health check: one is
 *    enough, as for an ALB's targets); units it lets go are deregistered (`draining`: no new requests, and the fleet keeps
 *    them at least `deregistrationDelay` unless they finish first); units that are gone are forgotten;
 *  - **health checks** every `interval` per target, across the edge's transport (latency, the edge's faults), each given
 *    up after `timeout`. `unhealthyThreshold` failures in a row and a target is unhealthy; `healthyThreshold` passes and it
 *    is healthy again. A dead unit gets requests (which fail) until its checks catch it. With `replaceUnhealthy` the fleet
 *    hears of it, as an Auto Scaling group with ELB health checks or an ECS service does;
 *  - **choosing**: round robin, least outstanding requests (its own count of requests sent and not yet answered), random,
 *    or a flow hash (the message's key: one key, one target, as a Network Load Balancer keeps a flow on one target);
 *  - **slow start**: a target that just became healthy gets a share that grows linearly to a full one over `slowStart`;
 *  - **zones**: a request reaches the balancer in one of the zones that have targets, or in the zone the balancer says
 *    (`send`'s `arrival`, for a balancer that models its own nodes and DNS); with `crossZone` off it is sent only to
 *    targets in that zone (all of them, healthy or not, when none there is healthy); a target in another zone costs
 *    `CROSS_ZONE_MS` each way;
 *  - **fail open**: with no healthy target at all it sends to every registered one, as ALB and NLB do; otherwise a
 *    request finds no target and fails at once (`NO_HEALTHY_TARGETS`, a 503) without crossing the network.
 *
 * Health checks don't count in the edge's metrics (they aren't requests), and nothing is allocated per request beyond a
 * closure to count the request's answer.
 */

export const ALGORITHMS = ["round-robin", "least-outstanding", "random", "flow-hash"] as const
export type Algorithm = (typeof ALGORITHMS)[number]

/** Why a request failed when the target group had no target for it: the balancer's own 503. */
export const NO_HEALTHY_TARGETS = "503 no healthy target"

/** Whether a failure is the target group finding no target (a load balancer answers 503), rather than a target failing. */
export const isNoTarget = (failure: CallFailure): boolean => failure._tag === "Unavailable" && failure.reason === NO_HEALTHY_TARGETS

/** Defaults a load balancer's own target group can set (AWS's are not the core connector's). */
export interface Defaults {
  readonly algorithm?: Algorithm
  readonly crossZone?: boolean
  readonly slowStart?: Duration.Input
  readonly deregistrationDelay?: Duration.Input
  readonly failOpen?: boolean
  readonly replaceUnhealthy?: boolean
  readonly healthCheck?: {
    readonly enabled?: boolean
    readonly interval?: Duration.Input
    readonly timeout?: Duration.Input
    readonly healthyThreshold?: number
    readonly unhealthyThreshold?: number
  }
}

/**
 * The target group's settings, with these defaults. The core connector's are assumptions (see `connectors/TargetGroup.ts`);
 * a load balancer that publishes its own (ALB's 30-second interval, 300-second deregistration delay) passes them here.
 */
export const fields = (d: Defaults = {}) => ({
  algorithm: Setting.choice(ALGORITHMS, {
    default: d.algorithm ?? "round-robin",
    labels: { "round-robin": "Round robin", "least-outstanding": "Least outstanding requests", random: "Random", "flow-hash": "Flow hash (by key)" },
    label: "Algorithm",
    help: "How a target is picked for each request: in turn, the one with the fewest requests in flight from this balancer, at random, or by the request's key (one key always reaches the same target while the targets don't change)."
  }),
  crossZone: Setting.bool({
    default: d.crossZone ?? true,
    label: "Cross-zone",
    help: "On: a request may go to a target in any zone. Off: only to targets in the zone where it reached the balancer, so a zone with fewer targets gives each of them more."
  }),
  slowStart: Setting.duration({
    default: d.slowStart ?? 0,
    min: 0,
    max: "15 minutes",
    label: "Slow start",
    help: "A target that just became healthy gets a share of requests that grows linearly to a full one over this long. 0: off."
  }),
  deregistrationDelay: Setting.duration({
    default: d.deregistrationDelay ?? "30 seconds",
    min: 0,
    max: "1 hour",
    label: "Deregistration delay",
    help: "How long a target the fleet lets go is kept to finish its requests (it gets no new ones). It goes sooner if it finishes them."
  }),
  failOpen: Setting.bool({
    default: d.failOpen ?? true,
    label: "Fail open",
    help: "With no healthy target at all, send to every registered target anyway, as ALB and NLB do. Off: refuse (503)."
  }),
  replaceUnhealthy: Setting.bool({
    default: d.replaceUnhealthy ?? true,
    label: "Fleet replaces unhealthy targets",
    help: "Tell the fleet when a target fails its health checks, so it replaces it: what an ECS service does, and an Auto Scaling group whose health check type is ELB."
  }),
  healthCheck: Setting.group(
    {
      enabled: Setting.bool({ default: d.healthCheck?.enabled ?? true, label: "Enabled", help: "Off: every registered target counts as healthy." }),
      interval: Setting.duration({ default: d.healthCheck?.interval ?? "10 seconds", min: "1 second", max: "5 minutes", label: "Interval", help: "Time between checks of one target." }),
      timeout: Setting.duration({
        default: d.healthCheck?.timeout ?? "5 seconds",
        min: "1 millis",
        max: "2 minutes",
        label: "Timeout",
        help: "A check with no answer in this long fails. Never longer than the interval."
      }),
      healthyThreshold: Setting.int({
        default: d.healthCheck?.healthyThreshold ?? 3,
        min: 1,
        max: 10,
        unit: "checks",
        label: "Healthy threshold",
        help: "Passes in a row before an unhealthy target counts as healthy again. A newly registered one needs a single pass."
      }),
      unhealthyThreshold: Setting.int({ default: d.healthCheck?.unhealthyThreshold ?? 3, min: 1, max: 10, unit: "checks", label: "Unhealthy threshold", help: "Failures in a row before a target counts as unhealthy." })
    },
    { label: "Health checks" }
  )
})

const settingsSchema = Schema.Struct(fields())

/** What the target group reads: its own settings, and the call's timeout and shape (the plain link's). */
export type Settings = typeof settingsSchema.Type & Pick<Edge.Policy, "timeout" | "cancelOnTimeout" | "request">

/** A target's health, as this group sees it. */
export type Health = "initial" | "healthy" | "unhealthy" | "draining"

/** A target as a probe reports it. */
export const TargetState = Schema.Struct({
  name: Schema.String,
  zone: Schema.optionalKey(Schema.String),
  health: Schema.Literals(["initial", "healthy", "unhealthy", "draining"]),
  outstanding: Schema.Number
})

export const State = Schema.Struct({
  healthy: Schema.Number,
  unhealthy: Schema.Number,
  initial: Schema.Number,
  draining: Schema.Number,
  /** Requests that found no target (503 from the balancer itself). */
  noTarget: Schema.Number,
  targets: Schema.Array(TargetState)
})
export type State = typeof State.Type

/** One registered unit. */
interface Target {
  readonly unit: Unit
  health: Health
  /** Checks passed and failed in a row. */
  passes: number
  fails: number
  /** Requests sent to it and not yet answered: least outstanding requests counts these. */
  outstanding: number
  /** When it last became healthy, for slow start. */
  healthySince: number
  /** Smooth weighted round robin's running credit. */
  credit: number
  tick: TimerHandle | undefined
  ping: Edge.Cancel | undefined
  readonly answer: () => HealthAnswer
  readonly heard: (healthy: boolean) => void
}

/** What a target group works with: the fleet it targets, the edge's transport, time and randomness, and the edge's meter. */
export interface Context {
  /** The node the edge leads to, for failures. */
  readonly to: string
  readonly fleet: Fleet
  readonly sink: Edge.Wire
  readonly fast: {
    readonly settings: () => Settings
    readonly now: () => number
    readonly random: SeededRandom
    readonly after: <A>(ms: number, fire: (arg: A) => void, arg: A) => TimerHandle
  }
  readonly meter: Meter
  /**
   * The zones the balancer has a node in, for a balancer that models its own (ELB): a target in any other zone is unused,
   * gets no requests even with cross-zone on, as ELB sends nothing to targets in zones it isn't enabled in. The array's
   * identity is what changes when they do. Absent: every target is used.
   */
  readonly zones?: () => ReadonlyArray<string> | undefined
}

/** A share of requests is never quite zero in slow start, so a target at the very start of it still gets one now and then. */
const MIN_WEIGHT = 0.01
const NONE: ReadonlyArray<Target> = []

const policies = new WeakMap<object, Edge.CallPolicy>()
/** The call policy of a request: the edge's timeout, and no retries (a load balancer doesn't retry a request). */
const policyOf = (c: Settings): Edge.CallPolicy => {
  let p = policies.get(c)
  if (p === undefined) policies.set(c, (p = { ...Edge.once, timeoutMs: Duration.toMillis(c.timeout), cancelOnTimeout: c.cancelOnTimeout }))
  return p
}

export class TargetGroup {
  private readonly targets = new Map<number, Target>()
  /** Registered targets in registration order: what every list below is built from, so choices are deterministic. */
  private readonly order: Array<Target> = []
  private dirty = true
  private builtFor: Settings | undefined
  private builtZones: ReadonlyArray<string> | undefined
  /** Who may get requests now: the healthy targets (or every registered one, failing open). */
  private pool: ReadonlyArray<Target> = NONE
  private readonly byZone = new Map<string, Array<Target>>()
  /**
   * Per zone, who a balancer node there sends to with cross-zone off: its zone's healthy targets, or (none healthy) every
   * registered one there, as ELB's routing failover does. Only used when the balancer says where a request arrived.
   */
  private readonly zonePools = new Map<string, ReadonlyArray<Target>>()
  /** The zones a request can reach the balancer in: those with targets in the pool. */
  private zones: ReadonlyArray<string> = []
  /** Until when some target in the pool is in slow start. */
  private rampUntil = -Infinity
  private turn = 0
  private readonly noTarget: Counter
  private noTargetTotal = 0
  private readonly withShape: (m: Message, c: Settings) => Message

  constructor(private readonly ctx: Context, shape: (m: Message, c: Settings) => Message) {
    this.withShape = shape
    this.noTarget = ctx.meter.counter("noTarget")
    // Units already up when the simulation starts have been registered and healthy for a while.
    ctx.fleet.each((unit) => {
      if (unit.state !== "draining") this.register(unit, true)
    })
    ctx.fleet.watch((unit, change) => {
      if (change === "up") this.register(unit, false)
      else if (change === "draining") this.deregister(unit)
      else this.forget(unit)
    })
    for (const health of ["healthy", "unhealthy", "initial", "draining"] as const) {
      ctx.meter.gaugeUnsafe(`targets.${health}`, () => this.counted(health))
    }
  }

  /**
   * Send one request to a target this group picks, through the edge's transport.
   *
   * `arrival` is the zone the request reached the balancer in, for a balancer that has a node in each of its zones and
   * decides that itself (an ELB load balancer: its DNS, its nodes' health). With cross-zone off the request then goes to
   * that zone's healthy targets, or to every registered target there when none is healthy (routing failover), or nowhere
   * when the zone has none (`NO_HEALTHY_TARGETS`: ELB's 503 for a request entering an empty zone). Without it, a request
   * reaches one of the zones that have targets in the pool, at random, as if DNS had already steered it.
   */
  send(message: Message, done: Edge.Done | undefined, arrival?: string): Edge.Cancel {
    const c = this.ctx.fast.settings()
    const enabled = this.ctx.zones?.()
    if (this.dirty || c !== this.builtFor || enabled !== this.builtZones) this.build(c, enabled)
    let zone: string | undefined
    let pool = this.pool
    if (arrival !== undefined) {
      zone = arrival
      if (!c.crossZone) pool = this.zonePools.get(arrival) ?? NONE
    } else if (this.zones.length > 0) {
      zone = this.zones.length === 1 ? this.zones[0] : this.zones[Math.floor(this.ctx.fast.random.nextDoubleUnsafe() * this.zones.length)]
      if (!c.crossZone) pool = this.byZone.get(zone!) ?? NONE
    }
    if (pool.length === 0) {
      this.noTarget.n++
      this.noTargetTotal++
      done?.(Unavailable({ node: this.ctx.to, reason: NO_HEALTHY_TARGETS }))
      return noop
    }
    const t = this.pick(pool, c, message)
    const extra = zone !== undefined && t.unit.zone !== undefined && t.unit.zone !== zone ? CROSS_ZONE_MS : 0
    t.outstanding++
    let open = true
    const cancel = this.ctx.sink.call(
      this.withShape(message, c),
      policyOf(c),
      (failure, items) => {
        if (open) {
          open = false
          t.outstanding--
        }
        done?.(failure, items)
      },
      t.unit,
      extra
    )
    return () => {
      if (!open) return
      open = false
      t.outstanding--
      cancel()
    }
  }

  /** What a probe reports. */
  status(): State {
    return {
      healthy: this.counted("healthy"),
      unhealthy: this.counted("unhealthy"),
      initial: this.counted("initial"),
      draining: this.counted("draining"),
      noTarget: this.noTargetTotal,
      targets: this.order.map((t) => ({ name: t.unit.name, ...(t.unit.zone === undefined ? {} : { zone: t.unit.zone }), health: t.health, outstanding: t.outstanding }))
    }
  }

  /** Healthy targets in `zone`, or in every zone when it is `undefined`: what a balancer's DNS failover looks at. */
  healthyIn(zone: string | undefined): number {
    let n = 0
    for (const t of this.order) if (t.health === "healthy" && (zone === undefined || t.unit.zone === zone)) n++
    return n
  }

  /** Registered targets (not draining) in `zone`, or in every zone when it is `undefined`. */
  registeredIn(zone: string | undefined): number {
    let n = 0
    for (const t of this.order) if (t.health !== "draining" && (zone === undefined || t.unit.zone === zone)) n++
    return n
  }

  // ---------------------------------------------------------------------------------------------------------
  // Choosing
  // ---------------------------------------------------------------------------------------------------------

  private pick(pool: ReadonlyArray<Target>, c: Settings, message: Message): Target {
    if (pool.length === 1) return pool[0]!
    const now = this.ctx.fast.now()
    const slow = now < this.rampUntil ? Duration.toMillis(c.slowStart) : 0
    switch (c.algorithm) {
      case "round-robin":
        return slow > 0 ? this.weightedTurn(pool, now, slow) : pool[this.nextTurn() % pool.length]!
      case "least-outstanding":
        return this.leastOutstanding(pool, now, slow)
      case "random":
        return this.byShare(pool, now, slow, this.ctx.fast.random.nextDoubleUnsafe())
      case "flow-hash":
        return this.byShare(pool, now, slow, message.key)
    }
  }

  private nextTurn(): number {
    const turn = this.turn
    this.turn = turn >= 1e9 ? 0 : turn + 1
    return turn
  }

  /** A target's share: 1, or less while it is in slow start (growing linearly from when it became healthy). */
  private weight(t: Target, now: number, slow: number): number {
    if (slow <= 0 || t.health !== "healthy") return 1
    const into = now - t.healthySince
    return into >= slow ? 1 : Math.max(MIN_WEIGHT, into / slow)
  }

  /** Round robin by share (nginx's smooth weighted round robin): each target's turns in proportion to its weight. */
  private weightedTurn(pool: ReadonlyArray<Target>, now: number, slow: number): Target {
    let best = pool[0]!
    let total = 0
    for (const t of pool) {
      const w = this.weight(t, now, slow)
      t.credit += w
      total += w
      if (t.credit > best.credit) best = t
    }
    best.credit -= total
    return best
  }

  /** The fewest requests in flight for its share; ties go round, so equal targets take turns. */
  private leastOutstanding(pool: ReadonlyArray<Target>, now: number, slow: number): Target {
    const n = pool.length
    const start = this.nextTurn() % n
    let best = pool[start]!
    let score = Infinity
    for (let k = 0; k < n; k++) {
      const t = pool[(start + k) % n]!
      const s = slow > 0 ? (t.outstanding + 1) / this.weight(t, now, slow) : t.outstanding
      if (s < score) {
        score = s
        best = t
      }
    }
    return best
  }

  /** The target at `u` of the way along the pool, by share: a random draw, or a flow's key. */
  private byShare(pool: ReadonlyArray<Target>, now: number, slow: number, u: number): Target {
    if (slow <= 0) return pool[Math.min(pool.length - 1, Math.floor(u * pool.length))]!
    let total = 0
    for (const t of pool) total += this.weight(t, now, slow)
    let r = u * total
    for (const t of pool) {
      r -= this.weight(t, now, slow)
      if (r < 0) return t
    }
    return pool[pool.length - 1]!
  }

  /** Who may get requests, per zone, and until when anyone is in slow start: rebuilt only when something changed. */
  private build(c: Settings, enabled: ReadonlyArray<string> | undefined): void {
    this.dirty = false
    this.builtFor = c
    this.builtZones = enabled
    // Targets in a zone the balancer has no node in are registered but unused.
    const used = enabled === undefined ? this.order : this.order.filter((t) => t.unit.zone === undefined || enabled.includes(t.unit.zone))
    const healthy = used.filter((t) => t.health === "healthy")
    this.pool = healthy.length > 0 ? healthy : c.failOpen ? used.filter((t) => t.health !== "draining") : NONE
    this.byZone.clear()
    const zones: Array<string> = []
    let rampUntil = -Infinity
    const slow = Duration.toMillis(c.slowStart)
    for (const t of this.pool) {
      if (t.health === "healthy" && slow > 0) rampUntil = Math.max(rampUntil, t.healthySince + slow)
      const z = t.unit.zone
      if (z === undefined) continue
      let inZone = this.byZone.get(z)
      if (inZone === undefined) {
        this.byZone.set(z, (inZone = []))
        zones.push(z)
      }
      inZone.push(t)
    }
    this.zones = zones
    this.rampUntil = rampUntil
    for (const t of this.order) t.credit = 0
    // Each zone's own pool, for requests a balancer says arrived there: healthy ones, else (failing open) all registered.
    this.zonePools.clear()
    const registered = new Map<string, Array<Target>>()
    for (const t of used) {
      const z = t.unit.zone
      if (z === undefined || t.health === "draining") continue
      let inZone = registered.get(z)
      if (inZone === undefined) registered.set(z, (inZone = []))
      inZone.push(t)
    }
    for (const [z, all] of registered) {
      const well = all.filter((t) => t.health === "healthy")
      this.zonePools.set(z, well.length > 0 ? well : c.failOpen ? all : NONE)
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Registration and health
  // ---------------------------------------------------------------------------------------------------------

  private register(unit: Unit, established: boolean): void {
    if (this.targets.has(unit.id)) return
    const checks = this.ctx.fast.settings().healthCheck.enabled
    const t: Target = {
      unit,
      health: established || !checks ? "healthy" : "initial",
      passes: 0,
      fails: 0,
      outstanding: 0,
      // A unit that was there all along isn't slow-starting; one that just came up and needs no checks is.
      healthySince: established ? -Infinity : this.ctx.fast.now(),
      credit: 0,
      tick: undefined,
      ping: undefined,
      answer: () => this.ctx.fleet.check(unit),
      heard: (healthy) => this.heard(t, healthy)
    }
    this.targets.set(unit.id, t)
    this.order.push(t)
    this.dirty = true
    if (checks) t.tick = this.ctx.fast.after(0, this.beat, t)
  }

  /** The fleet let it go: no new requests, and it is kept at least the deregistration delay unless it finishes first. */
  private deregister(unit: Unit): void {
    const t = this.targets.get(unit.id)
    if (t === undefined) return
    this.stopChecks(t)
    t.health = "draining"
    this.dirty = true
    this.ctx.fleet.holdDraining(unit, Duration.toMillis(this.ctx.fast.settings().deregistrationDelay))
  }

  private forget(unit: Unit): void {
    const t = this.targets.get(unit.id)
    if (t === undefined) return
    this.stopChecks(t)
    this.targets.delete(unit.id)
    const i = this.order.indexOf(t)
    if (i >= 0) this.order.splice(i, 1)
    this.dirty = true
  }

  private stopChecks(t: Target): void {
    t.tick?.cancel()
    t.ping?.()
    t.tick = t.ping = undefined
  }

  /** Check one target now, and again after the interval. */
  private readonly beat = (t: Target): void => {
    t.tick = undefined
    if (t.health === "draining") return
    const hc = this.ctx.fast.settings().healthCheck
    if (!hc.enabled) {
      // Checks turned off: every registered target counts as healthy.
      if (t.health !== "healthy") this.becomeHealthy(t)
      return
    }
    const interval = Duration.toMillis(hc.interval)
    t.ping = this.ctx.sink.ping(t.answer, Math.min(Duration.toMillis(hc.timeout), interval), t.heard)
    t.tick = this.ctx.fast.after(interval, this.beat, t)
  }

  private heard(t: Target, healthy: boolean): void {
    t.ping = undefined
    if (t.health === "draining") return
    const hc = this.ctx.fast.settings().healthCheck
    if (healthy) {
      t.fails = 0
      t.passes++
      // A new target needs one passing check whatever the threshold (as an ALB's does); an unhealthy one the threshold.
      if (t.health === "initial" || (t.health === "unhealthy" && t.passes >= hc.healthyThreshold)) this.becomeHealthy(t)
    } else {
      t.passes = 0
      t.fails++
      if (t.health !== "unhealthy" && t.fails >= hc.unhealthyThreshold) this.becomeUnhealthy(t)
    }
  }

  private becomeHealthy(t: Target): void {
    const was = t.health
    t.health = "healthy"
    t.healthySince = this.ctx.fast.now()
    this.dirty = true
    if (was === "unhealthy" && this.ctx.fast.settings().replaceUnhealthy) this.ctx.fleet.report(t.unit, true)
  }

  private becomeUnhealthy(t: Target): void {
    t.health = "unhealthy"
    this.dirty = true
    // Last: the fleet may let the unit go at once, which deregisters it here.
    if (this.ctx.fast.settings().replaceUnhealthy) this.ctx.fleet.report(t.unit, false)
  }

  private counted(health: Health): number {
    let n = 0
    for (const t of this.order) if (t.health === health) n++
    return n
  }
}

const noop = (): void => {}
