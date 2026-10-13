import { Context, Duration, Effect, Exit, Fiber, Graph, Layer, Predicate, Random, Schema, Scope, type Stream, SubscriptionRef } from "effect"
import type { Instance as ComponentInstance, PortDefs } from "./Component.ts"
import type * as Connector from "./Connector.ts"
import type * as Controller from "./Controller.ts"
import type * as Design from "./Design.ts"
import * as Edge from "./Edge.ts"
import * as Limiter from "./Limiter.ts"
import { ActiveFault, type Fault, Faults, make as makeFaults, type NoSuchTarget, type Target } from "./Fault.ts"
import { keyOf, zoneKeyOf } from "./Provider.ts"
import * as SeededRandom from "./SeededRandom.ts"
import { type Frame, make as makeTelemetry, Telemetry } from "./Telemetry.ts"
import { Registry } from "./Registry.ts"
import { VirtualTime } from "./VirtualTime.ts"
import * as internal from "./internal/simulation.ts"

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

export const ControllerProbe = Schema.Struct({
  type: Schema.String,
  /** The node it controls. */
  target: Schema.String,
  /** The controller's own report, described by its `state` schema. */
  state: Schema.Unknown,
  /** What it said it decided, newest last. */
  log: Schema.Array(Schema.Struct({ t: Schema.Number, text: Schema.String }))
})
export type ControllerProbe = typeof ControllerProbe.Type

export class NoSuchController extends Schema.TaggedError<NoSuchController>()("NoSuchController", { id: Schema.String }) {}

export const EdgeProbe = Schema.Struct({
  /** What sits on the edge. */
  connector: Schema.String,
  /** Tries in flight across the edge's transport right now. */
  inflight: Schema.Number,
  /** The connector's own report, described by its `state` schema. */
  state: Schema.Unknown
})
export type EdgeProbe = typeof EdgeProbe.Type

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
  edges: Schema.Record(
    Schema.String,
    Schema.Struct({ from: Schema.String, to: Schema.String, port: Schema.String, connector: Schema.String, config: Schema.Unknown, probe: EdgeProbe })
  ),
  /** Account-level quotas by placement, as the simulation is running them right now. */
  accounts: Schema.Record(Schema.String, Schema.Unknown),
  controllers: Schema.Record(Schema.String, Schema.Struct({ config: Schema.Unknown, probe: ControllerProbe })),
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
  /** An edge's connector and its internal state, right now: an event source mapping's pollers, say. */
  readonly probeEdge: (edge: string) => Effect.Effect<EdgeProbe, NoSuchEdge>
  /** A controller's state and what it has decided. */
  readonly probeController: (id: string) => Effect.Effect<ControllerProbe, NoSuchController>
  /** Replace a controller's settings with a new set of overrides, live. */
  readonly configureController: (id: string, overrides: Readonly<Record<string, unknown>>) => Effect.Effect<void, NoSuchController | InvalidConfig>
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
  /**
   * Change some of a node's settings, live, keeping the rest as they are now: whatever a person, a scenario or a controller
   * last set. What a scenario's timeline does, so a `set` of a client's rate doesn't undo what an autoscaler decided.
   */
  readonly patchNode: (id: string, settings: Readonly<Record<string, unknown>>) => Effect.Effect<void, NoSuchNode | InvalidConfig>
  readonly patchEdge: (id: string, settings: Readonly<Record<string, unknown>>) => Effect.Effect<void, NoSuchEdge | InvalidConfig>
  readonly patchAccount: (placement: string, settings: Readonly<Record<string, unknown>>) => Effect.Effect<void, NoSuchAccount | InvalidConfig>
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

/** Deep merge: objects merge key by key, anything else replaces. */
const mergeDeep = (base: Readonly<Record<string, unknown>>, over: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(over)) out[k] = Predicate.isObject(v) && Predicate.isObject(out[k]) ? mergeDeep(out[k] as Record<string, unknown>, v) : v
  return out
}

/** A change to some settings, merged over what is live now (encoded, then decoded and validated as a whole). */
const patched = (id: string, schema: Schema.Top, live: unknown, settings: Readonly<Record<string, unknown>>) =>
  decodeOverrides(id, schema, mergeDeep(internal.encodeWith(schema, live) as Record<string, unknown>, settings))

/** Settings decoded and validated as a whole, or the issues that stop them. */
const decodeOverrides = (id: string, schema: Schema.Top, overrides: Readonly<Record<string, unknown>>) =>
  Effect.mapError(
    Schema.decodeUnknownEffect(schema as Schema.Decoder<unknown>)(overrides),
    (error) => new InvalidConfig({ id, issues: internal.issues(error.message) })
  )

/** Where a live edit lands: the settings it replaces, their schema, and the id its errors name. */
interface Settable {
  readonly id: string
  readonly schema: Schema.Top
  readonly ref: SubscriptionRef.SubscriptionRef<unknown>
}

/**
 * Builds the simulation inside the world: every node's runtime, every edge's transport and link, then the components,
 * the connectors on the edges and the controllers, in that order. A definition that fails to build stops it all, as a
 * `ComponentCrashed`.
 */
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
    const nodes = new Map<string, internal.NodeRuntime>()
    const edges = new Map<string, internal.EdgeRuntime>()
    const controllers = new Map<string, internal.ControllerRuntime>()

    const built = yield* inWorld(
      Effect.gen(function*() {
        const scope = yield* Scope.make()
        const telemetry = yield* makeTelemetry(frameMs, world.now).pipe(Scope.provide(scope))
        // Every zone of every placement in use can be faulted, whether or not anything is placed in it yet.
        const zonesOf = internal.zonesOf(design, registry)
        const zoneIds = new Set([...design.accounts.keys()].flatMap((key) => zonesOf(key).map((zone) => zoneKeyOf(key, zone))))
        const faults = yield* makeFaults(
          {
            nodes: new Set(design.nodeIndex.keys()),
            edges: new Set(design.edgeIndex.keys()),
            regions: new Set(design.accounts.keys()),
            zones: zoneIds,
            // A global component (CloudFront, Route 53) runs everywhere: no region's or zone's fault reaches it.
            placementOf: (id) => {
              const n = nodes.get(id)
              return n === undefined || n.node.component.global ? undefined : keyOf(n.node.placement)
            },
            zoneOf: (id) => {
              const n = nodes.get(id)
              return n === undefined || n.node.component.global ? undefined : n.node.placement.zone
            }
          },
          world.now
        ).pipe(Scope.provide(scope))

        // Account-level quotas: one live value per placement, and a store for resources nodes there share.
        const accountRefs = new Map<string, SubscriptionRef.SubscriptionRef<unknown>>()
        for (const [key, account] of design.accounts) accountRefs.set(key, yield* SubscriptionRef.make(account.config))
        const kernel: internal.Kernel = {
          world,
          telemetry,
          faults,
          limiter: yield* Limiter.make,
          nodes,
          accountRefs,
          defects,
          mint: internal.minter(world.nowUnsafe),
          spawnFor: internal.spawner(world, defects),
          sharedIn: internal.sharer(scope),
          zonesOf
        }
        const services = Context.make(Telemetry, telemetry).pipe(Context.add(Faults, faults), Context.add(VirtualTime, world))

        /** Make one definition inside the world scope with its own random stream; a failure is recorded as a crash of `owner`. */
        const crashes: Array<ComponentCrashed> = []
        const instantiate = <A, E>(owner: string, random: SeededRandom.SeededRandom, effect: Effect.Effect<A, E, Scope.Scope>) =>
          effect.pipe(
            Effect.provideService(Random.Random, random),
            Scope.provide(scope),
            Effect.exit,
            Effect.map((made) => {
              if (Exit.isSuccess(made)) return made.value
              crashes.push(new ComponentCrashed({ node: owner, message: internal.firstLine(made.cause) }))
              return undefined
            })
          )

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
            offers: undefined,
            fleet: undefined,
            offer: undefined,
            probe: undefined
          })
        }

        // --- Edges: transport now, the connector on each once the nodes exist ----------------------------
        // A source's links must exist before its component is made (it may hold on to them), but a connector that
        // takes needs what the source offers, which only the made component has. So a link sends through whatever
        // its connector turns out to be.
        for (const [, edge] of Graph.edges(design.graph)) {
          const e = edge.data
          const config = yield* SubscriptionRef.make(e.config)
          const wire = yield* Edge.wire({
            id: e.id,
            from: e.from,
            to: e.to,
            config: config as SubscriptionRef.SubscriptionRef<Edge.Transport>,
            target: internal.edgeTarget(kernel, e.to),
            random: root.fork(`edge:${e.id}`)
          }).pipe(Effect.provideContext(services))
          const rt: internal.EdgeRuntime = { edge: e, config, wire, send: undefined, probe: undefined }
          edges.set(e.id, rt)
          const source = nodes.get(e.from)!
          if ((source.node.component.ports as PortDefs)[e.port]?.protocol === "invoke") source.links.get(e.port)!.push(internal.link(rt, nodes))
        }

        // --- Instantiate the components, each inside the world scope with its own random stream -------
        // Every call into a node passes the guard: faults, metrics and defect containment, whatever the component.
        for (const rt of nodes.values()) {
          const meter = telemetry.node(rt.node.id)
          yield* meter.gauge("inflight", Effect.sync(() => rt.inflight))
          const instance: ComponentInstance | undefined = yield* instantiate(rt.node.id, rt.random, rt.node.component.make(internal.nodeContext(kernel, rt, meter)))
          if (instance === undefined) continue
          if (instance.call !== undefined) rt.start = internal.guard(kernel, rt, instance.call)
          rt.offers = instance.pull
          rt.fleet = instance.fleet
          rt.offer = instance.offer
          rt.probe = instance.probe
        }

        // --- Connectors, now that every node exists and has said what it offers ----------------------
        for (const rt of edges.values()) {
          if (crashes.length > 0) break
          const e = rt.edge
          const source = nodes.get(e.from)!
          const protocol = (source.node.component.ports as PortDefs)[e.port]?.protocol
          const offered = protocol === "pull" ? source.offers?.[e.port] : undefined
          if (protocol === "pull" && offered === undefined) {
            crashes.push(new ComponentCrashed({ node: e.from, message: `offers nothing on its "${e.port}" port` }))
            break
          }
          const fleet = e.connector.to.protocol === "fleet" ? nodes.get(e.to)!.fleet : undefined
          if (e.connector.to.protocol === "fleet" && fleet === undefined) {
            crashes.push(new ComponentCrashed({ node: e.to, message: `offers no units for the ${e.connector.type} connector to pick from` }))
            break
          }
          const random = root.fork(`connector:${e.id}`)
          const instance: Connector.Instance | undefined = yield* instantiate(e.id, random, e.connector.make(internal.connectorContext(kernel, rt, random, offered, fleet)))
          if (instance === undefined) break
          if (protocol === "invoke" && instance.send === undefined) {
            crashes.push(new ComponentCrashed({ node: e.id, message: `the ${e.connector.type} connector can't be sent to` }))
            break
          }
          rt.send = instance.send
          rt.probe = instance.probe
        }

        // --- Controllers, last: they watch and change what everything above built ------------------
        for (const c of design.controllers.values()) {
          if (crashes.length > 0) break
          const rt: internal.ControllerRuntime = { controller: c, config: yield* SubscriptionRef.make(c.config), log: [], probe: undefined }
          controllers.set(c.id, rt)
          const random = root.fork(`controller:${c.id}`)
          const instance: Controller.Instance | undefined = yield* instantiate(c.id, random, c.def.make(internal.controllerContext(kernel, rt, nodes.get(c.target)!, random)))
          if (instance === undefined) break
          rt.probe = instance.probe
        }
        return { telemetry, faults, accountRefs, crash: crashes[0] }
      })
    )

    if (built.crash !== undefined) {
      yield* world.dispose
      return yield* Effect.fail(built.crash)
    }
    yield* Effect.addFinalizer(() => world.dispose)

    const lookup = (id: string) => internal.find(nodes, id, (id) => new NoSuchNode({ id }))
    const lookupEdge = (id: string) => internal.find(edges, id, (id) => new NoSuchEdge({ id }))
    const lookupController = (id: string) => internal.find(controllers, id, (id) => new NoSuchController({ id }))

    /** An account's quotas, as something a live edit can change. */
    const accountSettings = (placement: string): Effect.Effect<Settable, NoSuchAccount> => {
      const ref = built.accountRefs.get(placement)
      const account = design.accounts.get(placement)
      if (ref === undefined || account === undefined) return Effect.fail(new NoSuchAccount({ placement }))
      return Effect.succeed({ id: placement, schema: registry.provider(account.placement.provider)!.account(account.placement.region), ref })
    }
    const nodeSettings = (id: string) => Effect.map(lookup(id), (rt): Settable => ({ id, schema: rt.node.component.config, ref: rt.config }))
    const edgeSettings = (id: string) => Effect.map(lookupEdge(id), (rt): Settable => ({ id, schema: rt.edge.schema, ref: rt.config }))
    const controllerSettings = (id: string) =>
      Effect.map(lookupController(id), (rt): Settable => ({ id, schema: rt.controller.def.config, ref: rt.config }))

    /** Replace the settings wholesale: anything not given takes its default. */
    const configure = <E>(find: Effect.Effect<Settable, E>, overrides: Readonly<Record<string, unknown>>) =>
      Effect.gen(function*() {
        const { id, schema, ref } = yield* find
        const decoded = yield* decodeOverrides(id, schema, overrides)
        yield* inWorld(SubscriptionRef.set(ref, decoded))
      })

    /** Change some settings, keeping the rest as they are live. */
    const patch = <E>(find: Effect.Effect<Settable, E>, settings: Readonly<Record<string, unknown>>) =>
      Effect.gen(function*() {
        const { id, schema, ref } = yield* find
        const decoded = yield* patched(id, schema, SubscriptionRef.getUnsafe(ref), settings)
        yield* inWorld(SubscriptionRef.set(ref, decoded))
      })

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
      probe: (id) => Effect.flatMap(lookup(id), (rt) => inWorld(internal.nodeProbe(rt))),
      probeEdge: (id) => Effect.flatMap(lookupEdge(id), (rt) => inWorld(internal.edgeProbe(rt))),
      probeController: (id) => Effect.flatMap(lookupController(id), (rt) => inWorld(internal.controllerProbe(rt))),
      configureController: (id, overrides) => configure(controllerSettings(id), overrides),
      inspect: inWorld(
        Effect.gen(function*() {
          const inspectedNodes: Record<string, Inspection["nodes"][string]> = {}
          for (const [id, rt] of nodes) {
            inspectedNodes[id] = {
              type: rt.node.type,
              name: rt.node.name,
              config: internal.encodeWith(rt.node.component.config, yield* SubscriptionRef.get(rt.config)),
              probe: yield* internal.nodeProbe(rt)
            }
          }
          const inspectedEdges: Record<string, Inspection["edges"][string]> = {}
          for (const rt of edges.values()) {
            const e = rt.edge
            inspectedEdges[e.id] = {
              from: e.from,
              to: e.to,
              port: e.port,
              connector: e.connector.type,
              config: internal.encodeWith(e.schema, yield* SubscriptionRef.get(rt.config)),
              probe: yield* internal.edgeProbe(rt)
            }
          }
          const inspectedAccounts: Record<string, unknown> = {}
          for (const key of design.accounts.keys()) {
            const { schema, ref } = yield* Effect.orDie(accountSettings(key))
            inspectedAccounts[key] = internal.encodeWith(schema, yield* SubscriptionRef.get(ref))
          }
          const inspectedControllers: Record<string, Inspection["controllers"][string]> = {}
          for (const [id, rt] of controllers) {
            inspectedControllers[id] = {
              config: internal.encodeWith(rt.controller.def.config, yield* SubscriptionRef.get(rt.config)),
              probe: yield* internal.controllerProbe(rt)
            }
          }
          return {
            t: yield* world.now,
            seed,
            nodes: inspectedNodes,
            edges: inspectedEdges,
            accounts: inspectedAccounts,
            controllers: inspectedControllers,
            faults: yield* built.faults.active
          }
        })
      ),
      faults: {
        inject: (target, fault, duration) => inWorld(built.faults.inject(target, fault, duration)),
        clear: (id) => inWorld(built.faults.clear(id)),
        clearAll: inWorld(built.faults.clearAll),
        active: built.faults.active,
        changes: built.faults.changes
      },
      configureNode: (id, overrides) => configure(nodeSettings(id), overrides),
      configureEdge: (id, overrides) => configure(edgeSettings(id), overrides),
      configureAccount: (placement, overrides) => configure(accountSettings(placement), overrides),
      patchNode: (id, settings) => patch(nodeSettings(id), settings),
      patchEdge: (id, settings) => patch(edgeSettings(id), settings),
      patchAccount: (placement, settings) => patch(accountSettings(placement), settings),
      defects: Effect.sync(() => [...defects])
    }
  })
