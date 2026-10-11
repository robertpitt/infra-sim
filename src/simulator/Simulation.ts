import {
  Cause,
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  Graph,
  Layer,
  Option,
  Random,
  Schema,
  Scope,
  type Stream,
  SubscriptionRef
} from "effect"
import { type AnyComponent, edgeConfigFor, type Node as NodeContext, type PortDefs } from "./Component.ts"
import type * as Design from "./Design.ts"
import * as Edge from "./Edge.ts"
import * as Limiter from "./Limiter.ts"
import { ActiveFault, type Fault, Faults, make as makeFaults, NoSuchTarget, type Target } from "./Fault.ts"
import { Failed, type Call, type CallFailure, failureCounter, type Message, Unavailable } from "./Message.ts"
import { keyOf } from "./Provider.ts"
import * as SeededRandom from "./SeededRandom.ts"
import { type Frame, make as makeTelemetry, Telemetry } from "./Telemetry.ts"
import { Registry } from "./Registry.ts"
import { VirtualTime } from "./VirtualTime.ts"

/**
 * A running simulation: a configured `Design` brought to life inside a virtual-time world.
 *
 * It is an ordinary Effect service. Nothing happens until you advance time, the same design and seed always play
 * out identically, and the whole thing can be questioned while it runs: `probe` a node for its internal state,
 * `inspect` everything at once, `configure` a node or edge live, inject faults, watch frames.
 *
 *   const program = Effect.gen(function*() {
 *     const sim = yield* Simulation
 *     yield* sim.advance("2 minutes")
 *     const queue = yield* sim.probe("orders-queue")   // { totals, inflight, state: { ready, hidden, ... } }
 *   }).pipe(Effect.provide(Simulation.layer(design)))
 */

export interface Defect {
  readonly t: number
  readonly node: string
  readonly message: string
}

export class NoSuchNode extends Schema.TaggedError<NoSuchNode>()("NoSuchNode", { id: Schema.String }) {}
export class NoSuchEdge extends Schema.TaggedError<NoSuchEdge>()("NoSuchEdge", { id: Schema.String }) {}
export class NoSuchAccount extends Schema.TaggedError<NoSuchAccount>()("NoSuchAccount", { placement: Schema.String }) {}
export class InvalidConfig extends Schema.TaggedError<InvalidConfig>()("InvalidConfig", {
  id: Schema.String,
  issues: Schema.Array(Schema.String)
}) {}
export class ComponentCrashed extends Schema.TaggedError<ComponentCrashed>()("ComponentCrashed", {
  node: Schema.String,
  message: Schema.String
}) {}

/** Counts since the simulation began, kept for every node regardless of what its component records. */
export const Totals = Schema.Struct({ in: Schema.Number, ok: Schema.Number, fail: Schema.Number })

export const NodeProbe = Schema.Struct({
  /** Requests currently inside the node, including any waiting for a worker. */
  inflight: Schema.Number,
  totals: Totals,
  /** The component's own report, described by its `state` schema. */
  state: Schema.Unknown
})
export type NodeProbe = typeof NodeProbe.Type

export const Inspection = Schema.Struct({
  /** Virtual time in milliseconds. */
  t: Schema.Number,
  seed: Schema.Number,
  nodes: Schema.Record(
    Schema.String,
    Schema.Struct({
      type: Schema.String,
      name: Schema.String,
      /** The configuration the node is running with right now, including any live edits. */
      config: Schema.Unknown,
      probe: NodeProbe
    })
  ),
  edges: Schema.Record(Schema.String, Schema.Struct({ from: Schema.String, to: Schema.String, port: Schema.String, config: Schema.Unknown })),
  /** Account-level quotas by placement, as the simulation is running them right now. */
  accounts: Schema.Record(Schema.String, Schema.Unknown),
  faults: Schema.Array(ActiveFault)
})
export type Inspection = typeof Inspection.Type

export interface Service {
  readonly design: Design.Design
  readonly seed: number
  readonly frameMs: number
  /** Current virtual time, in milliseconds. */
  readonly now: Effect.Effect<number>
  /** Run virtual time forward by this much, returning the frames completed along the way. */
  readonly advance: (by: Duration.Input) => Effect.Effect<ReadonlyArray<Frame>>
  /** Run virtual time forward to this instant. */
  readonly advanceTo: (to: Duration.Input) => Effect.Effect<ReadonlyArray<Frame>>
  /** Every frame as it is produced. */
  readonly frames: Stream.Stream<Frame>
  /** A node's internal state, right now. */
  readonly probe: (node: string) => Effect.Effect<NodeProbe, NoSuchNode>
  /** Everything at once: time, every node's configuration and state, every edge, every active fault. */
  readonly inspect: Effect.Effect<Inspection>
  readonly faults: {
    readonly inject: (target: Target, fault: Fault, duration?: Duration.Input) => Effect.Effect<ActiveFault, NoSuchTarget>
    readonly clear: (id: string) => Effect.Effect<boolean>
    readonly clearAll: Effect.Effect<void>
    readonly active: Effect.Effect<ReadonlyArray<ActiveFault>>
    readonly changes: Stream.Stream<ReadonlyArray<ActiveFault>>
  }
  /** Replace a node's settings with a new set of overrides, live. Anything not given takes its default. */
  readonly configureNode: (id: string, overrides: Readonly<Record<string, unknown>>) => Effect.Effect<void, NoSuchNode | InvalidConfig>
  readonly configureEdge: (id: string, overrides: Readonly<Record<string, unknown>>) => Effect.Effect<void, NoSuchEdge | InvalidConfig>
  /** Replace the account-level quotas of a placement (`aws:us-east-1`), live. They are shared by every node there. */
  readonly configureAccount: (placement: string, overrides: Readonly<Record<string, unknown>>) => Effect.Effect<void, NoSuchAccount | InvalidConfig>
  /** Components that threw instead of failing a call. The run carries on. */
  readonly defects: Effect.Effect<ReadonlyArray<Defect>>
}

export class Simulation extends Context.Service<Simulation, Service>()("simulator/Simulation") {
  /** The simulation for this design, on a fresh world. */
  static readonly layer = (design: Design.Design, options?: Options) =>
    Layer.effect(Simulation, make(design, options))
}


export interface Options {
  /** Overrides the design's own seed. */
  readonly seed?: number
  /** Metrics window in virtual milliseconds. Defaults to 250. */
  readonly frameMs?: number
}

interface Runtime {
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
  probe: Effect.Effect<unknown> | undefined
}

const encodeWith = (schema: Schema.Top, value: unknown): unknown => Schema.encodeSync(schema as Schema.Encoder<unknown>)(value)

const decodeOverrides = (id: string, schema: Schema.Top, overrides: Readonly<Record<string, unknown>>) =>
  Effect.mapError(
    Schema.decodeUnknownEffect(schema as Schema.Decoder<unknown>)(overrides),
    (error) => new InvalidConfig({ id, issues: error.message.split("\n").map((s) => s.trim()).filter(Boolean) })
  )

const noop = (): void => {}

export const make = (design: Design.Design, options: Options = {}): Effect.Effect<Service, ComponentCrashed, VirtualTime | Scope.Scope | Registry> =>
  Effect.gen(function*() {
    const world = yield* VirtualTime
    const registry = yield* Registry
    const seed = options.seed ?? design.seed
    const frameMs = options.frameMs ?? 250
    const root = SeededRandom.make(seed)

    /** Run an effect inside the world and wait for it. Everything the service does goes through here, so state
     *  is only ever touched on the world's own clock and scheduler. */
    const inWorld = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> => Effect.flatMap(world.fork(effect), Fiber.join)

    const defects: Array<Defect> = []
    // A callback that throws inside a timer is a component defect, reported like any other.
    world.onError = (error) => void defects.push({ t: world.nowUnsafe(), node: "(timer)", message: error instanceof Error ? error.message : String(error) })
    const nodes = new Map<string, Runtime>()
    let messages = 0

    const built = yield* inWorld(
      Effect.gen(function*() {
        const scope = yield* Scope.make()
        const nodeIds = new Set(design.nodeIndex.keys())
        const edgeIds = new Set(design.edgeIndex.keys())
        const telemetry = yield* makeTelemetry(frameMs, world.now).pipe(Scope.provide(scope))
        const faults = yield* makeFaults(
          {
            nodes: nodeIds,
            edges: edgeIds,
            regions: new Set(design.accounts.keys()),
            placementOf: (id) => {
              const n = nodes.get(id)
              return n === undefined ? undefined : keyOf(n.node.placement)
            }
          },
          world.now
        ).pipe(Scope.provide(scope))

        // Account-level quotas: one live value per placement, and a store for resources nodes there share.
        const accountRefs = new Map<string, SubscriptionRef.SubscriptionRef<unknown>>()
        for (const [key, account] of design.accounts) accountRefs.set(key, yield* SubscriptionRef.make(account.config))
        const shared = new Map<string, unknown>()
        const limiter = yield* Limiter.make
        const services = Context.make(Telemetry, telemetry).pipe(Context.add(Faults, faults), Context.add(VirtualTime, world))

        // --- Nodes ---------------------------------------------------------------------------------------
        for (const [, node] of Graph.nodes(design.graph)) {
          const random = root.fork(`node:${node.id}`)
          nodes.set(node.id, {
            node,
            config: yield* SubscriptionRef.make(node.config),
            random,
            links: new Map(Object.keys(node.component.ports as PortDefs).map((port) => [port, []])),
            totals: { in: 0, ok: 0, fail: 0 },
            inflight: 0,
            context: Context.add(world.context, Random.Random, random),
            start: undefined,
            probe: undefined
          })
        }

        // --- Edges ---------------------------------------------------------------------------------------
        const edgeConfigs = new Map<string, SubscriptionRef.SubscriptionRef<unknown>>()
        for (const [, edge] of Graph.edges(design.graph)) {
          const e = edge.data
          const source = nodes.get(e.from)!
          const config = yield* SubscriptionRef.make(e.config)
          edgeConfigs.set(e.id, config)
          const link = yield* Edge.make({
            id: e.id,
            from: e.from,
            to: e.to,
            config: config as SubscriptionRef.SubscriptionRef<Edge.Config>,
            target: {
              start: (message, done) => {
                const start = nodes.get(e.to)!.start
                if (start === undefined) {
                  done(Failed({ node: e.to, reason: "component has no handler" }))
                  return noop
                }
                return start(message, done)
              }
            },
            random: root.fork(`edge:${e.id}`)
          }).pipe(Effect.provideContext(services))
          source.links.get(e.port)!.push(link as unknown as Edge.Link<never>)
        }

        // --- Universal node behaviour: faults, metrics, defect containment ------------------------------
        // The node's handler runs in a fiber of its own (so it can outlive a caller that gave up), and the guard
        // watches that fiber from outside: when it ends, the outcome is counted and handed to the edge. Nothing wraps
        // the handler's effect, so the guard adds no operators to the call.
        const guard = (rt: Runtime, call: (message: Message) => Call): Edge.Target["start"] => {
          const meter = telemetry.node(rt.node.id)
          const received = meter.counter("in")
          const succeeded = meter.counter("ok")
          const failed = meter.counter("fail")
          const latency = meter.sampler("latency")
          const age = meter.sampler("age")
          const failures = new Map<string, { n: number }>()
          const record = (failure: CallFailure) => {
            rt.totals.fail++
            failed.n++
            const name = failureCounter(failure)
            let counter = failures.get(name)
            if (counter === undefined) failures.set(name, (counter = meter.counter(name)))
            counter.n++
          }
          const spawn = world.spawn
          return (message, done) => {
            const started = world.nowUnsafe()
            received.n++
            rt.totals.in++
            rt.inflight++
            const f = faults.forNodeUnsafe(rt.node.id)
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
                yield* call(message)
                if (f.errorRate > 0 && (yield* Random.next) < f.errorRate) {
                  return yield* Effect.fail(Failed({ node: rt.node.id, reason: "injected error" }))
                }
              })
              : call(message)
            const fiber = spawn(body, rt.context)
            fiber.addObserver((exit) => {
              rt.inflight--
              if (Exit.isSuccess(exit)) {
                const t = world.nowUnsafe()
                rt.totals.ok++
                succeeded.n++
                latency.add(t - started)
                age.add(t - message.bornAt)
                return done(undefined)
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

        // --- Instantiate the components, each inside the world scope with its own random stream -------
        const crashes: Array<ComponentCrashed> = []
        for (const rt of nodes.values()) {
          const meter = telemetry.node(rt.node.id)
          yield* meter.gauge("inflight", Effect.sync(() => rt.inflight))
          const context: NodeContext<unknown, PortDefs> = {
            id: rt.node.id,
            name: rt.node.name,
            config: rt.config,
            fast: {
              settings: () => SubscriptionRef.getUnsafe(rt.config),
              now: world.nowUnsafe,
              random: rt.random,
              after: world.after,
              account: () => SubscriptionRef.getUnsafe(accountRefs.get(keyOf(rt.node.placement))!),
              mint: (init = {}) => ({
                id: ++messages,
                bornAt: world.nowUnsafe(),
                origin: rt.node.id,
                attempt: 1,
                bytes: 1024,
                count: 1,
                invocation: "sync",
                operation: "write",
                key: rt.random.nextDoubleUnsafe(),
                ...init
              })
            },
            out: (port) => (rt.links.get(port) ?? []) as never,
            meter,
            placement: rt.node.placement,
            limiter,
            account: accountRefs.get(keyOf(rt.node.placement))!,
            shared: <A>(name: string, build: Effect.Effect<A, never, Scope.Scope>) =>
              Effect.suspend(() => {
                const key = `${keyOf(rt.node.placement)}/${name}`
                if (shared.has(key)) return Effect.succeed(shared.get(key) as A)
                // Built once, in the world's scope, on behalf of whoever asked first.
                return build.pipe(Scope.provide(scope), Effect.tap((value) => Effect.sync(() => void shared.set(key, value))))
              }),
            mint: (init = {}) =>
              Effect.gen(function*() {
                return {
                  id: ++messages,
                  bornAt: yield* world.now,
                  origin: rt.node.id,
                  attempt: 1,
                  bytes: 1024,
                  count: 1,
                  invocation: "sync",
                  operation: "write",
                  key: yield* Random.next,
                  ...init
                } satisfies Message
              }),
            spawn: (effect) =>
              Effect.asVoid(
                Effect.forkScoped(
                  effect.pipe(
                    Effect.catchCause((cause) =>
                      Cause.hasInterruptsOnly(cause)
                        ? Effect.void
                        : Effect.gen(function*() {
                          defects.push({ t: yield* world.now, node: rt.node.id, message: Cause.pretty(cause).split("\n")[0] ?? "crashed" })
                        })
                    )
                  )
                )
              )
          }
          const made = yield* rt.node.component.make(context).pipe(
            Effect.provideService(Random.Random, rt.random),
            Scope.provide(scope),
            Effect.exit
          )
          if (Exit.isFailure(made)) {
            crashes.push(new ComponentCrashed({ node: rt.node.id, message: Cause.pretty(made.cause).split("\n")[0] ?? "crashed" }))
            continue
          }
          const instance = made.value as { call?: (m: Message) => Call; probe?: Effect.Effect<unknown> }
          if (instance.call !== undefined) rt.start = guard(rt, instance.call)
          rt.probe = instance.probe
        }
        return { scope, telemetry, faults, edgeConfigs, accountRefs, crash: crashes[0] }
      })
    )

    if (built.crash !== undefined) {
      yield* world.dispose
      return yield* Effect.fail(built.crash)
    }
    yield* Effect.addFinalizer(() => world.dispose)

    const probeOf = (rt: Runtime): Effect.Effect<NodeProbe> =>
      Effect.gen(function*() {
        const state = rt.probe === undefined ? {} : encodeWith(rt.node.component.state, yield* rt.probe)
        return { inflight: rt.inflight, totals: { ...rt.totals }, state }
      })

    const lookup = (id: string) => {
      const rt = nodes.get(id)
      return rt === undefined ? Effect.fail(new NoSuchNode({ id })) : Effect.succeed(rt)
    }

    const advanceTo = (to: Duration.Input) =>
      Effect.flatMap(world.advanceTo(Duration.toMillis(Duration.fromInputUnsafe(to))), () => built.telemetry.drain)

    return {
      design,
      seed,
      frameMs,
      now: world.now,
      advanceTo,
      advance: (by) => Effect.flatMap(world.now, (now) => advanceTo(now + Duration.toMillis(Duration.fromInputUnsafe(by)))),
      frames: built.telemetry.frames,
      probe: (id) => Effect.flatMap(lookup(id), (rt) => inWorld(probeOf(rt))),
      inspect: inWorld(
        Effect.gen(function*() {
          const inspectedNodes: Record<string, Inspection["nodes"][string]> = {}
          for (const [id, rt] of nodes) {
            inspectedNodes[id] = {
              type: rt.node.type,
              name: rt.node.name,
              config: encodeWith(rt.node.component.config, yield* SubscriptionRef.get(rt.config)),
              probe: yield* probeOf(rt)
            }
          }
          const inspectedEdges: Record<string, Inspection["edges"][string]> = {}
          for (const [, edge] of Graph.edges(design.graph)) {
            const e = edge.data
            const source = nodes.get(e.from)!
            inspectedEdges[e.id] = {
              from: e.from,
              to: e.to,
              port: e.port,
              config: encodeWith(edgeConfigFor(source.node.component as AnyComponent, e.port), yield* SubscriptionRef.get(built.edgeConfigs.get(e.id)!))
            }
          }
          const inspectedAccounts: Record<string, unknown> = {}
          for (const [key, account] of design.accounts) {
            inspectedAccounts[key] = encodeWith(registry.provider(account.placement.provider)!.account(account.placement.region), yield* SubscriptionRef.get(built.accountRefs.get(key)!))
          }
          return { t: yield* world.now, seed, nodes: inspectedNodes, edges: inspectedEdges, accounts: inspectedAccounts, faults: yield* built.faults.active }
        })
      ),
      faults: {
        inject: (target, fault, duration) => inWorld(built.faults.inject(target, fault, duration)),
        clear: (id) => inWorld(built.faults.clear(id)),
        clearAll: inWorld(built.faults.clearAll),
        active: built.faults.active,
        changes: built.faults.changes
      },
      configureNode: (id, overrides) =>
        Effect.gen(function*() {
          const rt = yield* lookup(id)
          const decoded = yield* decodeOverrides(id, rt.node.component.config, overrides)
          yield* inWorld(SubscriptionRef.set(rt.config, decoded))
        }),
      configureEdge: (id, overrides) =>
        Effect.gen(function*() {
          const config = built.edgeConfigs.get(id)
          const edge = edgeOf(design, id)
          if (config === undefined || edge === undefined) return yield* Effect.fail(new NoSuchEdge({ id }))
          const source = nodes.get(edge.from)!
          const decoded = yield* decodeOverrides(id, edgeConfigFor(source.node.component as AnyComponent, edge.port), overrides)
          yield* inWorld(SubscriptionRef.set(config, decoded))
        }),
      configureAccount: (placement, overrides) =>
        Effect.gen(function*() {
          const ref = built.accountRefs.get(placement)
          const account = design.accounts.get(placement)
          if (ref === undefined || account === undefined) return yield* Effect.fail(new NoSuchAccount({ placement }))
          const decoded = yield* decodeOverrides(placement, registry.provider(account.placement.provider)!.account(account.placement.region), overrides)
          yield* inWorld(SubscriptionRef.set(ref, decoded))
        }),
      defects: Effect.sync(() => [...defects])
    }
  })

const edgeOf = (design: Design.Design, id: string): Design.Edge | undefined => {
  const index = design.edgeIndex.get(id)
  return index === undefined ? undefined : Option.getOrUndefined(Graph.getEdge(design.graph, index))?.data
}
