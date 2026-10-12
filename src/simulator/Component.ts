import { Effect, Schema, type Scope, type SubscriptionRef } from "effect"
import * as Dashboard from "./Dashboard.ts"
import type { Limiter } from "./Limiter.ts"
import type { Placement } from "./Provider.ts"
import * as Describe from "./Describe.ts"
import * as Edge from "./Edge.ts"
import type { ActiveFault, NodeEffect } from "./Fault.ts"
import type { Call, Message } from "./Message.ts"
import type { Fleet, Protocol, Pull } from "./Protocol.ts"
import type { SeededRandom } from "./SeededRandom.ts"
import type { Meter } from "./Telemetry.ts"
import type { TimerHandle } from "./VirtualTime.ts"

/**
 * A component is a pluggable module, written as data plus one effect:
 *
 *  - `config`: a `Schema` for its settings. JSON on disk becomes typed values (defaults filled in, ranges
 *    enforced), and a UI form is derived from the same schema;
 *  - `ports`: the named exits an edge can leave from, each optionally with its own per-edge settings;
 *  - `state`: a `Schema` for what the running instance reports when probed;
 *  - `make`: given the node's live configuration and wiring, build the behaviour.
 *
 * The framework supplies everything else: edge policy (latency, timeout, retry), faults, metrics, seeded
 * randomness and virtual time, so a component only says what it does.
 *
 *   export const Echo = Component.make({
 *     type: "echo",
 *     title: "Echo",
 *     category: "compute",
 *     config: Schema.Struct({ delay: Setting.duration({ default: "10 millis" }) }),
 *     make: (node) => Effect.succeed({
 *       call: () => SubscriptionRef.get(node.config).pipe(Effect.flatMap((c) => Effect.sleep(c.delay)))
 *     })
 *   })
 */

export type Category = "traffic" | "compute" | "messaging" | "storage" | "network" | "external" | "other"

// ---------------------------------------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------------------------------------

/**
 * A named exit on a component. Edges leave from a port, and the port says how work crosses it (its `protocol`):
 *
 *  - `invoke` (`port.many`, `port.one`): the component pushes calls through `node.out(port)`;
 *  - `pull` (`port.pull`): the component holds the work and offers it (`Instance.pull`), and the connector on each edge
 *    takes it, the way Lambda's event source mapping polls a queue.
 *
 * The port can add its own per-edge settings, which the component reads from the link.
 */
export interface PortDef<C extends Schema.Struct<Schema.Struct.Fields> | undefined = Schema.Struct<Schema.Struct.Fields> | undefined> {
  readonly label: string
  /** Whether more than one edge may leave this port. */
  readonly many: boolean
  readonly protocol: Protocol
  readonly config: C
  /**
   * It sends copies to replicas, which never send a replica on through the same port: two stores replicating to each
   * other (a global table, two-way bucket replication) pass nothing round, so they are not a loop.
   */
  readonly replication?: true
}
export type PortDefs = Readonly<Record<string, PortDef>>

type PortMaker = {
  (label: string): PortDef<undefined>
  <C extends Schema.Struct<Schema.Struct.Fields>>(label: string, config: C): PortDef<C>
}

const portOf = (protocol: Protocol, many: boolean, replication = false): PortMaker =>
  ((label: string, config?: Schema.Struct<Schema.Struct.Fields>) => ({ label, many, protocol, config, ...(replication ? { replication: true } : {}) })) as PortMaker

export const port = {
  /** Calls to any number of edges. */
  many: portOf("invoke", true),
  /** Calls to at most one edge. */
  one: portOf("invoke", false),
  /** Work offered to be taken by whatever is wired here; each edge's connector takes from the same source. */
  pull: portOf("pull", true),
  /** Copies to any number of replicas, which don't copy them on again (see `PortDef.replication`). */
  replication: portOf("invoke", true, true)
}

/** The settings an edge leaving this port carries: the universal edge policy plus the port's own. */
export type PortConfig<P extends PortDef> = P extends PortDef<infer C>
  ? C extends Schema.Struct<Schema.Struct.Fields> ? Edge.Config & C["Type"] : Edge.Config
  : never

// ---------------------------------------------------------------------------------------------------------
// What `make` receives and returns
// ---------------------------------------------------------------------------------------------------------

export interface Node<Config, Ports extends PortDefs> {
  readonly id: string
  readonly name: string
  /** Where this node runs: provider and region. */
  readonly placement: Placement
  /**
   * The quotas of the account this node lives in, for its region, live. Every node in the same placement sees the
   * same ones. Typed `unknown` here; a provider's own `make` wrapper narrows it.
   */
  readonly account: SubscriptionRef.SubscriptionRef<unknown>
  /**
   * A resource shared by every node in this placement, built the first time anyone asks and then reused: Lambda's
   * regional concurrency, API Gateway's regional throttle. `key` names it within the placement.
   */
  readonly shared: <A>(key: string, build: Effect.Effect<A, never, Scope.Scope>) => Effect.Effect<A>
  /** Live settings. Read with `SubscriptionRef.get`; edits made while running apply to the next read. */
  readonly config: SubscriptionRef.SubscriptionRef<Config>
  /**
   * The synchronous toolkit for hot paths. A handler that has decided what to do doesn't need an `Effect` to read a
   * setting, draw a random number or arm a timer: these are plain calls, so a call can run its whole decision in one
   * step and only reach for an `Effect` (a callback that waits) when it genuinely has to wait.
   */
  readonly fast: Fast<Config>
  /** The edges wired to an `invoke` port, to call through. A `pull` port has none: its connectors take instead. */
  readonly out: <K extends keyof Ports & string>(port: K) => ReadonlyArray<Edge.Link<PortConfig<Ports[K]>>>
  /** Token-bucket rate limits, keyed by name. Shared across the simulation: namespace keys with your node id or placement. */
  readonly limiter: Limiter
  /** Record counters, samples and gauges that show up in frames. `in`, `ok`, `fail` and `latency` are recorded for you. */
  readonly meter: Meter
  /** Mint a fresh message (clients and other sources). */
  readonly mint: (init?: Partial<Pick<Message, "bytes" | "count" | "group" | "key" | "invocation" | "operation">>) => Effect.Effect<Message>
  /** Run a background loop for the life of the simulation. A defect in it is reported rather than lost. */
  readonly spawn: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<void, never, Scope.Scope>
  /** The availability zones of this node's region, and what is wrong with them: what a fleet spreads its units over. */
  readonly zones: Zones
  /** The faults that reach this node now, and a hook to hear them change: so a component can see an outage begin. */
  readonly faults: NodeFaults
}

/**
 * What is wrong with a node right now, as the node itself can see it. The engine applies faults around every node (a call
 * to a node with an `Outage` is refused before its handler runs), so most components never need this. It is for one that
 * reacts to them: a database whose primary failing (an outage on it) starts a failover, or a Multi-AZ resource that keeps
 * serving through its zone's outage from a standby in another zone (with `handlesZoneFaults`). Cheap enough for a hot path:
 * with nothing injected anywhere each read is one check and a shared constant.
 */
export interface NodeFaults {
  /** The node's own faults and its region's, added up: what the engine applies to every call into it. */
  readonly own: () => NodeEffect
  /** The faults on the zone it is placed in (its `zone`), added up; nothing for a node in no zone. */
  readonly zone: () => NodeEffect
  /** Every active fault that reaches it (on it, its region, its zone), as data: what, since when, until when. */
  readonly active: () => ReadonlyArray<ActiveFault>
  /** Hear when faults change anywhere, after they have: then read again. Returns a function that stops listening. */
  readonly watch: (listener: () => void) => () => void
}

/**
 * The zones of a node's region, as the node sees them, with the faults on each. Cheap to ask on every call: with no fault
 * anywhere, `effect` is one check and a shared constant.
 */
export interface Zones {
  /** The region's zones, in order (`us-east-1a`, `us-east-1b`...). Empty for a place with none. */
  readonly all: ReadonlyArray<string>
  /** The faults on one zone right now (only the zone's own: the region's reach the node itself). */
  readonly effect: (zone: string) => NodeEffect
  /** Whether a zone is down (an outage on it). */
  readonly down: (zone: string) => boolean
  /** Hear when faults change anywhere, after they have: then ask `effect` or `down` again. Returns a function that stops listening. */
  readonly watch: (listener: () => void) => () => void
}

export interface Fast<Config> {
  /** Settings as they are right now. */
  readonly settings: () => Config
  /** Virtual time, in milliseconds. */
  readonly now: () => number
  /** This node's own seeded stream: the same one `Random.next` draws from inside its handlers. */
  readonly random: SeededRandom
  /** Run `fire(arg)` after `ms` of virtual time. Cancel with the handle. A throwing callback is reported, not fatal. */
  readonly after: <A>(ms: number, fire: (arg: A) => void, arg: A) => TimerHandle
  /** Mint a message without an effect. */
  readonly mint: (init?: Partial<Pick<Message, "bytes" | "count" | "group" | "key" | "invocation" | "operation">>) => Message
  /** The account quotas of this node's placement, as they are right now. */
  readonly account: () => unknown
}

export interface Instance<State = unknown> {
  /** Handle an inbound call. Leave out for pure sources such as clients. */
  readonly call?: (message: Message) => Call
  /** What the component offers on each of its `pull` ports, for the connectors wired there to take from. */
  readonly pull?: Readonly<Record<string, Pull>>
  /**
   * Its units, for a component declared a `fleet`: what a connector that speaks `fleet` (a target group) picks from, call
   * by call. Plain calls into the node still go to `call`. See `fleet/README.md`.
   */
  readonly fleet?: Fleet
  /**
   * What the node offers whatever is wired to it, beyond calls: the connectors on edges into it (`ctx.offer()`) and the
   * components calling it (`link.offer()`). Its shape is agreed between the component and its partners (a database's
   * ledger of client connections, which the connectors of its clients register with); they narrow it with a guard.
   */
  readonly offer?: unknown
  /** Report internal state. This is what makes a running component inspectable. */
  readonly probe?: Effect.Effect<State>
}

export interface Highlight {
  /** A gauge or a per-second rate worth showing on the node card. */
  readonly gauge?: string
  readonly rate?: string
  readonly label: string
  readonly format?: "count" | "percent" | "ms"
}

/** A limit that is not a setting: documented, enforced by the component, shown read-only. */
export interface ServiceLimit {
  readonly label: string
  /** Already formatted, e.g. "6 MB request, 6 MB response". */
  readonly value: string
  /** Whether the provider raises it on request. Adjustable limits that matter are settings instead. */
  readonly adjustable: boolean
  readonly source?: string
  readonly note?: string
}

/**
 * A component that draws a boundary round others instead of handling traffic: an AWS region, a VPC. Nodes inside
 * it name it as their `parent`.
 */
export interface Container {
  /** Which components may sit directly inside. */
  readonly accepts: (child: AnyComponent) => boolean
  /** The region of everything inside, for containers that decide it. */
  // biome-ignore lint/suspicious/noExplicitAny: a container only ever reads the config it decoded itself.
  readonly region?: (config: any) => string
}

export interface ComponentDef<
  C extends Schema.Top = Schema.Top,
  P extends PortDefs = PortDefs,
  S extends Schema.Top = Schema.Top
> {
  /** Unique id, namespaced by provider: `aws.lambda`, `common.client`. */
  readonly type: string
  /** The provider it runs on (`aws`, `internet`, ...). Decides the regions it can be placed in. */
  readonly provider: string
  /** The product name within the provider, e.g. "Lambda". */
  readonly service: string
  readonly title: string
  readonly description: string
  readonly category: Category
  readonly icon: string
  /** CSS colour for the node accent. */
  readonly accent: string
  /** Documentation page for the service. */
  readonly docs: string | undefined
  /** Published limits that aren't settings. */
  readonly limits: ReadonlyArray<ServiceLimit>
  readonly highlights: ReadonlyArray<Highlight>
  /** False for pure sources (nothing may connect into them). */
  readonly inputs: boolean
  /**
   * A fleet of units (instances, tasks, pods) that can be reached one by one: an edge into it may carry a connector that
   * speaks `fleet` (a load balancer's target group), besides plain calls. Its instance offers them as `Instance.fleet`.
   */
  readonly fleet: boolean
  /**
   * Faults on the zone its node is placed in don't refuse its calls: the component reads them (`node.faults.zone()`) and
   * decides, as a Multi-AZ resource fails over to a standby in another zone and keeps serving. Its own and its region's
   * faults are applied as for any node.
   */
  readonly handlesZoneFaults: boolean
  /**
   * It runs at the provider's edge, everywhere, rather than in the region it is placed in (CloudFront, Route 53). A
   * region's or zone's fault doesn't reach it; its own faults do. Its placement still keys its quotas and its latency.
   */
  readonly global: boolean
  /**
   * Standard alarm rules (`Alarm.rules` ids) that don't fit it: a firewall's 403s are its job, not errors, so it leaves
   * out `errors`. What it passes on still alarms where it lands.
   */
  readonly quietAlarms: ReadonlyArray<string>
  /**
   * Its metrics as an operator's dashboard: key figures and charts, mirroring what the real service publishes (see
   * `Dashboard.ts`). Without one, the generic dashboard every node can have.
   */
  readonly dashboard: Dashboard.Dashboard | undefined
  /** Set for components that group others rather than handle traffic. */
  readonly container: Container | undefined
  /** Component types this must sit inside, e.g. a VPC only makes sense inside a region. */
  readonly within: ReadonlyArray<string> | undefined
  readonly config: C
  readonly ports: P
  readonly state: S
  readonly make: (node: Node<C["Type"], P>) => Effect.Effect<Instance<S["Type"]>, never, Scope.Scope>
}

export interface Input<C extends Schema.Top, P extends PortDefs, S extends Schema.Top> {
  readonly type: string
  readonly provider?: string
  readonly service?: string
  readonly docs?: string
  readonly limits?: ReadonlyArray<ServiceLimit>
  readonly title: string
  readonly description?: string
  readonly category: Category
  readonly icon?: string
  readonly accent?: string
  readonly highlights?: ReadonlyArray<Highlight>
  readonly inputs?: boolean
  readonly fleet?: boolean
  readonly handlesZoneFaults?: boolean
  readonly global?: boolean
  readonly quietAlarms?: ReadonlyArray<string>
  readonly dashboard?: Dashboard.Dashboard
  readonly container?: Container
  readonly within?: ReadonlyArray<string>
  readonly config: C
  readonly ports?: P
  readonly state?: S
  readonly make: ComponentDef<C, P, S>["make"]
}

export const make = <
  const C extends Schema.Top,
  const P extends PortDefs = { readonly out: PortDef<undefined> },
  const S extends Schema.Top = Schema.Struct<{}>
>(input: Input<C, P, S>): ComponentDef<C, P, S> => ({
  type: input.type,
  provider: input.provider ?? "internet",
  service: input.service ?? input.title,
  docs: input.docs,
  limits: input.limits ?? [],
  title: input.title,
  description: input.description ?? "",
  category: input.category,
  icon: input.icon ?? "box",
  accent: input.accent ?? "#8995a8",
  highlights: input.highlights ?? [],
  inputs: input.container === undefined ? input.inputs ?? true : false,
  fleet: input.container === undefined && (input.inputs ?? true) && (input.fleet ?? false),
  handlesZoneFaults: input.handlesZoneFaults ?? false,
  global: input.global ?? false,
  quietAlarms: input.quietAlarms ?? [],
  dashboard: input.dashboard,
  container: input.container,
  within: input.within,
  config: input.config,
  ports: (input.ports ?? { out: port.many("Next") }) as P,
  state: (input.state ?? Schema.Struct({})) as S,
  make: input.make
})

/** A component with its type parameters erased, as registries hold them. */
// biome-ignore lint/suspicious/noExplicitAny: variance: a component is only ever invoked with values it decoded itself.
export type AnyComponent = ComponentDef<any, any, any>

// ---------------------------------------------------------------------------------------------------------
// Derived pieces
// ---------------------------------------------------------------------------------------------------------

/** What a component accepts on its input: invocations, or nothing at all for a pure source. */
export const accepts = (def: AnyComponent): Protocol | undefined => (def.inputs ? "invoke" : undefined)

/** What else it accepts besides plain invocations: `fleet`, for a fleet whose units can be picked one by one. */
export const alsoAccepts = (def: AnyComponent): ReadonlyArray<Protocol> => (def.fleet ? FLEET_ONLY : NOTHING)
const FLEET_ONLY: ReadonlyArray<Protocol> = ["fleet"]
const NOTHING: ReadonlyArray<Protocol> = []

/** The serialisable description of a component, for UIs and tools that never run it. */
export interface Manifest {
  readonly type: string
  readonly provider: string
  readonly service: string
  readonly docs: string | undefined
  readonly limits: ReadonlyArray<ServiceLimit>
  readonly title: string
  readonly description: string
  readonly category: Category
  readonly icon: string
  readonly accent: string
  readonly inputs: boolean
  /** Its units can be reached one by one: a load balancer's target group may be wired to it. */
  readonly fleet?: true
  /** Set for components that draw a boundary round others: the component types allowed inside. */
  readonly container?: { readonly accepts: ReadonlyArray<string>; readonly decidesRegion: boolean }
  readonly within?: ReadonlyArray<string>
  readonly highlights: ReadonlyArray<Highlight>
  /** Its dashboard: its own, or the generic one (requests, latency, the gauges it highlights). */
  readonly dashboard: Dashboard.Dashboard
  readonly settings: ReadonlyArray<Describe.FieldSpec>
  readonly outputs: ReadonlyArray<{
    readonly port: string
    readonly label: string
    readonly many: boolean
    readonly protocol: Protocol
    /** The port's own per-edge settings, before the connector's and transport's. */
    readonly settings: ReadonlyArray<Describe.FieldSpec>
  }>
}

export const manifestOf = (def: AnyComponent, all: ReadonlyArray<AnyComponent> = []): Manifest => ({
  type: def.type,
  provider: def.provider,
  service: def.service,
  docs: def.docs,
  limits: def.limits,
  title: def.title,
  description: def.description,
  category: def.category,
  icon: def.icon,
  accent: def.accent,
  inputs: def.inputs,
  ...(def.fleet ? { fleet: true as const } : {}),
  ...(def.container === undefined
    ? {}
    : { container: { accepts: all.filter((c) => c !== def && def.container!.accepts(c)).map((c) => c.type), decidesRegion: def.container.region !== undefined } }),
  ...(def.within === undefined ? {} : { within: def.within }),
  highlights: def.highlights,
  dashboard: def.dashboard ?? Dashboard.generic(def.highlights, def.container === undefined && !def.inputs),
  settings: Describe.fields(def.config),
  outputs: Object.entries(def.ports as PortDefs).map(([name, p]) => ({
    port: name,
    label: p.label,
    many: p.many,
    protocol: p.protocol,
    settings: p.config === undefined ? [] : Describe.fields(p.config)
  }))
})
