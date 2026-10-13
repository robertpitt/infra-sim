/**
 * The machinery behind `Simulation.ts`: what each running node, edge and controller holds, the contexts their
 * definitions are made with, the guard every call into a node passes through, and the probes that report on them.
 * `Simulation.make` builds a `Kernel` once and wires the design together with these.
 *
 * The guard and the `fast` members of each context are on the call path, so they stay plain synchronous closures that
 * capture what they need once, when the node or edge is built.
 */
import { Cause, type Context, Effect, Exit, Random, Schema, Scope, Stream, SubscriptionRef } from "effect"
import type { Node as NodeContext, PortDefs } from "../Component.ts"
import type * as Connector from "../Connector.ts"
import type * as Controller from "../Controller.ts"
import type * as Design from "../Design.ts"
import * as Edge from "../Edge.ts"
import { type Faults, NO_FAULT } from "../Fault.ts"
import type { Limiter } from "../Limiter.ts"
import { type Call, type CallFailure, Failed, type ItemFailures, type Message, Unavailable } from "../Message.ts"
import type { Fleet, Pull, Unit } from "../Protocol.ts"
import { keyOf } from "../Provider.ts"
import type { Registry } from "../Registry.ts"
import type * as SeededRandom from "../SeededRandom.ts"
import type { ControllerProbe, Defect, EdgeProbe, NodeProbe } from "../Simulation.ts"
import type { Meter, Telemetry } from "../Telemetry.ts"
import type { World } from "../VirtualTime.ts"
import { failureCounters } from "../kit/Tally.ts"

// ---------------------------------------------------------------------------------------------------------
// What runs
// ---------------------------------------------------------------------------------------------------------

/** One node, running. */
export interface NodeRuntime {
  readonly node: Design.Node
  readonly config: SubscriptionRef.SubscriptionRef<unknown>
  readonly random: SeededRandom.SeededRandom
  readonly links: Map<string, Array<Edge.Link<never>>>
  readonly totals: { in: number; ok: number; fail: number }
  inflight: number
  /** The context the node's fibers run in: the world's clock and scheduler, and this node's own random stream. */
  readonly context: Context.Context<never>
  /** Start the node's handler for a message (see `Edge.Target`). Undefined for nodes with no `call`. */
  start: Edge.Target["start"] | undefined
  /** What the node offers on its `pull` ports. */
  offers: Readonly<Record<string, Pull>> | undefined
  /** Its units, if its component is a fleet. */
  fleet: Fleet | undefined
  /** What it offers beyond calls (`Instance.offer`). */
  offer: unknown
  probe: Effect.Effect<unknown> | undefined
}

/** One edge, running: its transport and the connector on it. */
export interface EdgeRuntime {
  readonly edge: Design.Edge
  readonly config: SubscriptionRef.SubscriptionRef<unknown>
  readonly wire: Edge.Wire
  /** What the connector does with a message a source sends; set once the connector is built. */
  send: ((message: Message, done?: Edge.Done) => Edge.Cancel) | undefined
  probe: Effect.Effect<unknown> | undefined
}

/** One controller, running. */
export interface ControllerRuntime {
  readonly controller: Design.Controller
  readonly config: SubscriptionRef.SubscriptionRef<unknown>
  /** What it said it decided, newest last. */
  readonly log: Array<{ readonly t: number; readonly text: string }>
  probe: Effect.Effect<unknown> | undefined
}

/** A fresh message from `origin`, its key drawn from the caller's own stream. */
export type Mint = (origin: string, random: SeededRandom.SeededRandom, init: Partial<Message>) => Message

/** What every node, edge and controller of one simulation shares: the world and the services built in it. */
export interface Kernel {
  readonly world: World
  readonly telemetry: Telemetry["Service"]
  readonly faults: Faults["Service"]
  readonly limiter: Limiter
  readonly nodes: ReadonlyMap<string, NodeRuntime>
  /** Account-level quotas: one live value per placement. */
  readonly accountRefs: ReadonlyMap<string, SubscriptionRef.SubscriptionRef<unknown>>
  readonly defects: Array<Defect>
  readonly mint: Mint
  /** Run a background loop for the life of the simulation, reporting a defect in it against `owner`. */
  readonly spawnFor: (owner: string) => <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<void, never, Scope.Scope>
  /** A resource shared by everything in a placement, built the first time anyone asks. */
  readonly sharedIn: <A>(placement: string, name: string, build: Effect.Effect<A, never, Scope.Scope>) => Effect.Effect<A>
  /** Every zone of a placement, by its key. */
  readonly zonesOf: (key: string) => ReadonlyArray<string>
}

// ---------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------

/** How many of a controller's log lines are kept. */
const LOG_KEEP = 50

/** Does nothing: the cancel of a call that never started. */
export const noop = (): void => {}

/** `value` encoded by `schema`, which is known to fit it. */
export const encodeWith = (schema: Schema.Top, value: unknown): unknown => Schema.encodeSync(schema as Schema.Encoder<unknown>)(value)

/** A schema error's message as a list of issues, one per non-empty line. */
export const issues = (message: string): Array<string> => message.split("\n").map((s) => s.trim()).filter(Boolean)

/** The first line of a cause, for a crash or defect report. */
export const firstLine = (cause: Cause.Cause<unknown>, fallback = "crashed"): string => Cause.pretty(cause).split("\n")[0] ?? fallback

/** `settings` with `value` at `path`, as a new object. */
export const setAt = (settings: Readonly<Record<string, unknown>>, path: ReadonlyArray<string>, value: unknown): Record<string, unknown> => {
  const [head, ...rest] = path
  if (head === undefined) return { ...settings }
  const inner = (settings[head] ?? {}) as Record<string, unknown>
  return { ...settings, [head]: rest.length === 0 ? value : setAt(inner, rest, value) }
}

/** What `map` holds under `id`, or the failure `missing` makes. */
export const find = <A, E>(map: ReadonlyMap<string, A>, id: string, missing: (id: string) => E): Effect.Effect<A, E> => {
  const found = map.get(id)
  return found === undefined ? Effect.fail(missing(id)) : Effect.succeed(found)
}

// ---------------------------------------------------------------------------------------------------------
// The kernel's parts
// ---------------------------------------------------------------------------------------------------------

/** Mints messages numbered from 1, born at the world's current time. */
export const minter = (now: () => number): Mint => {
  let messages = 0
  return (origin, random, init) => ({
    id: ++messages,
    bornAt: now(),
    origin,
    attempt: 1,
    bytes: 1024,
    count: 1,
    invocation: "sync",
    operation: "write",
    key: random.nextDoubleUnsafe(),
    ...init
  })
}

/** `Kernel.spawnFor`, recording defects into `defects`. */
export const spawner = (world: World, defects: Array<Defect>): Kernel["spawnFor"] => (owner) => (effect) =>
  Effect.asVoid(
    Effect.forkScoped(
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.gen(function*() {
              defects.push({ t: yield* world.now, node: owner, message: firstLine(cause) })
            })
        )
      )
    )
  )

/** `Kernel.sharedIn`, building each resource in `scope`. */
export const sharer = (scope: Scope.Scope): Kernel["sharedIn"] => {
  const shared = new Map<string, unknown>()
  return <A>(placement: string, name: string, build: Effect.Effect<A, never, Scope.Scope>): Effect.Effect<A> =>
    Effect.suspend(() => {
      const key = `${placement}/${name}`
      if (shared.has(key)) return Effect.succeed(shared.get(key) as A)
      // Built once, in the world's scope, on behalf of whoever asked first.
      return build.pipe(Scope.provide(scope), Effect.tap((value) => Effect.sync(() => void shared.set(key, value))))
    })
}

/** Every zone of every placement in use, by placement key: what can be faulted whether or not anything is placed in it. */
export const zonesOf = (design: Design.Design, registry: Registry["Service"]) => (key: string): ReadonlyArray<string> => {
  const account = design.accounts.get(key)
  return account === undefined ? [] : registry.provider(account.placement.provider)?.regions.find((r) => r.id === account.placement.region)?.zones ?? []
}

// ---------------------------------------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------------------------------------

/** What an edge's transport calls: whatever handler the node at `to` turns out to have, and whether it answers at all. */
export const edgeTarget = (k: Kernel, to: string): Edge.Target => {
  const { nodes, faults } = k
  /**
   * The faults the engine applies around a node's calls: its own, its region's and its zone's, except that a
   * component that handles its zone's faults itself (a Multi-AZ resource) is spared its zone's.
   */
  const effectOn = (id: string) => (nodes.get(id)?.node.component.handlesZoneFaults ? faults.forNodeOwnUnsafe(id) : faults.forNodeUnsafe(id))
  return {
    start: (message, done, unit) => {
      const start = nodes.get(to)!.start
      if (start === undefined) {
        done(Failed({ node: to, reason: "component has no handler" }))
        return noop
      }
      return start(message, done, unit)
    },
    reachable: () => !effectOn(to).outage
  }
}

/**
 * The link a source holds for an `invoke` edge. It exists before the source's component is made (which may hold on to
 * it), and sends through whatever the edge's connector turns out to be.
 */
export const link = (rt: EdgeRuntime, nodes: ReadonlyMap<string, NodeRuntime>): Edge.Link<never> => {
  const e = rt.edge
  return Edge.link({
    id: e.id,
    from: e.from,
    to: e.to,
    config: rt.config as SubscriptionRef.SubscriptionRef<Edge.Config>,
    send: (message, done) => {
      if (rt.send !== undefined) return rt.send(message, done)
      done?.(Unavailable({ node: e.to, reason: "not connected yet" }))
      return noop
    },
    offer: () => nodes.get(e.to)?.offer
  }) as unknown as Edge.Link<never>
}

// ---------------------------------------------------------------------------------------------------------
// Universal node behaviour: faults, metrics, defect containment
// ---------------------------------------------------------------------------------------------------------

/**
 * The node's handler runs in a fiber of its own (so it can outlive a caller that gave up), and the guard
 * watches that fiber from outside: when it ends, the outcome is counted and handed to the edge. Nothing wraps
 * the handler's effect, so the guard adds no operators to the call.
 */
export const guard = (k: Kernel, rt: NodeRuntime, call: (message: Message) => Call): Edge.Target["start"] => {
  const { world, faults, defects } = k
  // A call a connector addressed to one unit of a fleet runs on that unit; everything else about it is the same.
  const serve = (message: Message, unit: Unit | undefined): Call =>
    unit === undefined
      ? call(message)
      : rt.fleet === undefined
      ? Effect.fail(Failed({ node: rt.node.id, reason: "addressed to a unit, but this is not a fleet" }))
      : rt.fleet.serve(unit, message)
  const meter = k.telemetry.node(rt.node.id)
  const received = meter.counter("in")
  const succeeded = meter.counter("ok")
  const partial = meter.counter("partial")
  const failed = meter.counter("fail")
  const latency = meter.sampler("latency")
  const age = meter.sampler("age")
  const failures = failureCounters(meter)
  const record = (failure: CallFailure) => {
    rt.totals.fail++
    failed.n++
    failures(failure).n++
  }
  const spawn = world.spawn
  const handlesZone = rt.node.component.handlesZoneFaults
  return (message, done, unit) => {
    const started = world.nowUnsafe()
    received.n++
    rt.totals.in++
    rt.inflight++
    const f = handlesZone ? faults.forNodeOwnUnsafe(rt.node.id) : faults.forNodeUnsafe(rt.node.id)
    if (f.outage) {
      rt.inflight--
      const failure = Unavailable({ node: rt.node.id, reason: "outage" })
      record(failure)
      done(failure)
      return noop
    }
    const body: Call = f.extraMs > 0 || f.errorRate > 0
      ? Effect.gen(function*() {
        if (f.extraMs > 0) yield* Effect.sleep(f.extraMs)
        const reply = yield* serve(message, unit)
        if (f.errorRate > 0 && (yield* Random.next) < f.errorRate) {
          return yield* Effect.fail(Failed({ node: rt.node.id, reason: "injected error" }))
        }
        return reply
      })
      : serve(message, unit)
    const fiber = spawn(body, rt.context)
    fiber.addObserver((exit) => {
      rt.inflight--
      if (Exit.isSuccess(exit)) {
        const t = world.nowUnsafe()
        rt.totals.ok++
        succeeded.n++
        latency.add(t - started)
        age.add(t - message.bornAt)
        // A success may name records of its batch that failed: the caller decides what to do about them.
        const items = exit.value as ItemFailures | undefined
        if (items !== undefined) partial.n++
        return done(undefined, items)
      }
      // A typed failure is the component saying no; a defect is the component breaking, which is contained.
      let failure: CallFailure | undefined
      let defect: unknown
      let interrupted = false
      for (const reason of exit.cause.reasons) {
        if (reason._tag === "Fail") {
          failure = reason.error as CallFailure
          break
        }
        if (reason._tag === "Die") defect = reason.defect
        else interrupted = true
      }
      if (failure === undefined) {
        // Cancelled by an edge that gave up, or interrupted for good: nobody is waiting, nothing to report.
        if (defect === undefined && interrupted) return
        defects.push({ t: world.nowUnsafe(), node: rt.node.id, message: defect instanceof Error ? defect.message : String(defect) })
        failure = Failed({ node: rt.node.id, reason: "component crashed" })
      }
      record(failure)
      done(failure)
    })
    return () => void fiber.interruptUnsafe()
  }
}

// ---------------------------------------------------------------------------------------------------------
// What each definition is made with
// ---------------------------------------------------------------------------------------------------------

/** What a node's component is made with: its settings, its links, its meter, and the world it runs in. */
export const nodeContext = (k: Kernel, rt: NodeRuntime, meter: Meter): NodeContext<unknown, PortDefs> => {
  const { world, faults, accountRefs, mint, limiter } = k
  const placementKey = keyOf(rt.node.placement)
  return {
    id: rt.node.id,
    name: rt.node.name,
    config: rt.config,
    fast: {
      settings: () => SubscriptionRef.getUnsafe(rt.config),
      now: world.nowUnsafe,
      random: rt.random,
      after: world.after,
      account: () => SubscriptionRef.getUnsafe(accountRefs.get(keyOf(rt.node.placement))!),
      mint: (init = {}) => mint(rt.node.id, rt.random, init)
    },
    out: (port) => (rt.links.get(port) ?? []) as never,
    meter,
    placement: rt.node.placement,
    limiter,
    account: accountRefs.get(keyOf(rt.node.placement))!,
    shared: <A>(name: string, build: Effect.Effect<A, never, Scope.Scope>) => k.sharedIn(placementKey, name, build),
    mint: (init = {}) => Effect.sync(() => mint(rt.node.id, rt.random, init)),
    spawn: k.spawnFor(rt.node.id),
    zones: {
      all: k.zonesOf(placementKey),
      effect: (zone) => faults.forZoneUnsafe(placementKey, zone),
      down: (zone) => faults.forZoneUnsafe(placementKey, zone).outage,
      watch: faults.listen
    },
    faults: {
      own: () => faults.forNodeOwnUnsafe(rt.node.id),
      zone: rt.node.placement.zone === undefined ? () => NO_FAULT : () => faults.forZoneUnsafe(placementKey, rt.node.placement.zone!),
      active: () => faults.reaching(rt.node.id),
      watch: faults.listen
    }
  }
}

/**
 * What an edge's connector is made with: its settings, the edge's wire to send through, and what the two ends offer
 * (`source` on a `pull` port, `target` for a `fleet`).
 */
export const connectorContext = (
  k: Kernel,
  rt: EdgeRuntime,
  random: SeededRandom.SeededRandom,
  source: Pull | undefined,
  target: Fleet | undefined
): Connector.Context<unknown> => {
  const { world, mint, nodes } = k
  const e = rt.edge
  return {
    id: e.id,
    from: e.from,
    port: e.port,
    to: e.to,
    config: rt.config,
    fast: {
      settings: () => SubscriptionRef.getUnsafe(rt.config),
      now: world.nowUnsafe,
      random,
      after: world.after,
      mint: (init = {}) => mint(e.from, random, init)
    },
    meter: k.telemetry.edge(e.id),
    limiter: k.limiter,
    spawn: k.spawnFor(e.id),
    sink: rt.wire,
    source,
    target,
    offer: () => nodes.get(e.to)?.offer,
    shared: (name, build) => k.sharedIn(keyOf(nodes.get(e.to)!.node.placement), name, build)
  }
}

/**
 * What a controller is made with: its own settings, the frames to watch, and a way to change its target's settings
 * through the same door an edit uses.
 */
export const controllerContext = (
  k: Kernel,
  rt: ControllerRuntime,
  target: NodeRuntime,
  random: SeededRandom.SeededRandom
): Controller.Context<unknown> => {
  const { world, telemetry, faults } = k
  const c = rt.controller
  const schema = target.node.component.config
  const settings = () => encodeWith(schema, SubscriptionRef.getUnsafe(target.config)) as Record<string, unknown>
  return {
    id: c.id,
    target: c.target,
    config: rt.config,
    fast: { settings: () => SubscriptionRef.getUnsafe(rt.config), now: world.nowUnsafe, random, after: world.after },
    watch: (listener, of) => k.spawnFor(c.id)(Stream.runForEach(telemetry.frames, (frame) => listener(frame.nodes[of?.() || c.target], frame.t))),
    settings,
    // The same door an edit uses: the whole settings, decoded and validated, then swapped in.
    set: (path, value) =>
      Effect.suspend(() => Schema.decodeUnknownEffect(schema as Schema.Decoder<unknown>)(setAt(settings(), path, value))).pipe(
        Effect.mapError((error) => issues(error.message)),
        Effect.flatMap((decoded) => SubscriptionRef.set(target.config, decoded))
      ),
    inject: (fault, ms) => faults.inject({ kind: "node", id: c.target }, fault, ms).pipe(Effect.orDie),
    clear: (id) => faults.clear(id),
    meter: telemetry.controller(c.id),
    log: (text) => {
      rt.log.push({ t: world.nowUnsafe(), text })
      if (rt.log.length > LOG_KEEP) rt.log.shift()
    },
    spawn: k.spawnFor(c.id)
  }
}

// ---------------------------------------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------------------------------------

/** A node's probe: its counts and its component's own report. */
export const nodeProbe = (rt: NodeRuntime): Effect.Effect<NodeProbe> =>
  Effect.gen(function*() {
    const state = rt.probe === undefined ? {} : encodeWith(rt.node.component.state, yield* rt.probe)
    return { inflight: rt.inflight, totals: { ...rt.totals }, state }
  })

/** An edge's probe: its connector, tries in flight, and the connector's own report. */
export const edgeProbe = (rt: EdgeRuntime): Effect.Effect<EdgeProbe> =>
  Effect.gen(function*() {
    const state = rt.probe === undefined ? {} : encodeWith(rt.edge.connector.state, yield* rt.probe)
    return { connector: rt.edge.connector.type, inflight: rt.wire.inflight(), state }
  })

/** A controller's probe: its own report and its log. */
export const controllerProbe = (rt: ControllerRuntime): Effect.Effect<ControllerProbe> =>
  Effect.gen(function*() {
    const state = rt.probe === undefined ? {} : encodeWith(rt.controller.def.state, yield* rt.probe)
    return { type: rt.controller.type, target: rt.controller.target, state, log: [...rt.log] }
  })
