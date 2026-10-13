import { type Effect, Schema, type Scope, type SubscriptionRef } from "effect"
import type * as Dashboard from "./Dashboard.ts"
import type { PortDef } from "./Component.ts"
import * as Describe from "./Describe.ts"
import * as Edge from "./Edge.ts"
import { memoByIdentity } from "./internal/memo.ts"
import type { Limiter } from "./Limiter.ts"
import type { Message } from "./Message.ts"
import type { Fleet, Protocol, Pull } from "./Protocol.ts"
import type { SeededRandom } from "./SeededRandom.ts"
import type { Meter } from "./Telemetry.ts"
import type { TimerHandle } from "./VirtualTime.ts"

/**
 * A connector is what sits on an edge: a first-class, typed, possibly active thing between two ports.
 *
 * Most edges are plain links (`core.link`): the source pushes a call and the link adds a timeout and retries. Some
 * aren't, and those are the "function in between" that real systems have: Lambda's event source mapping between a
 * queue and a function (pollers, batching, scaling), a subscription between a topic and its subscriber, an integration
 * between an API and its backend. Their settings, their state and their behaviour belong to neither end, so they get a
 * definition of their own:
 *
 *   export const Mapping = Connector.make({
 *     type: "aws.sqs.event-source-mapping",
 *     title: "Event source mapping",
 *     from: { protocol: "pull", component: "aws.sqs", port: "deliver" },
 *     to: { protocol: "invoke" },
 *     config: Consumer,
 *     state: Schema.Struct({ concurrency: Schema.Number }),
 *     make: (ctx) => Effect.sync(() => { ...ctx.source.take(...)... ctx.sink.call(batch, Edge.once, done) ... })
 *   })
 *
 * A connector never sees latency: its calls go through the edge's transport (`ctx.sink`, a `Wire`), which applies the
 * network and the edge's faults and records the edge's metrics. What it adds is behaviour.
 *
 * **Inference.** A wire in a design doesn't have to name its connector. The registry picks the most specific one that
 * fits both ends (see `pick`): one that names the source component and port beats one that names the component, which
 * beats one that only names the protocols. A document can name one (`connector: core.poller`) when several fit.
 */

// ---------------------------------------------------------------------------------------------------------
// Where a connector fits
// ---------------------------------------------------------------------------------------------------------

/** The source end a connector fits: a protocol, and optionally one component's port. */
export interface FromEnd<P extends Protocol = Protocol> {
  readonly protocol: P
  readonly component?: string
  readonly port?: string
}

/** The target end: what the target must accept, and optionally which component it must be. */
export interface ToEnd<P extends Protocol = Protocol> {
  readonly protocol: P
  readonly component?: string
  /**
   * `false`: it doesn't fit a fleet (instances, tasks, pods), whose workers poll for themselves. Lambda's event source
   * mappings are Lambda's: a queue drained by an ECS service or an Auto Scaling group gets a plain poller instead.
   */
  readonly fleets?: false
}

/** The two ends of one wire, as the registry sees them when choosing a connector. */
export interface Query {
  readonly from: { readonly component: string; readonly port: string; readonly protocol: Protocol }
  /**
   * `protocol` is what the target accepts; `undefined` for a pure source, which accepts nothing. `also` is what else it
   * accepts: `fleet` for a fleet whose units can be picked one by one.
   */
  readonly to: { readonly component: string; readonly protocol: Protocol | undefined; readonly also?: ReadonlyArray<Protocol> }
}

/** What `pick` needs of a connector: plain data, so a UI holding manifests can run the same rule. */
export interface Fits {
  readonly type: string
  readonly from: FromEnd
  readonly to: ToEnd
}

/**
 * How well a connector fits a wire: `undefined` if it doesn't, otherwise higher for more specific. Naming a component
 * counts most, then naming a port; the target end counts as much as the source end.
 */
export const score = (c: Fits, q: Query): number | undefined => {
  if (c.from.protocol !== q.from.protocol || q.to.protocol === undefined) return undefined
  if (c.to.protocol !== q.to.protocol && !(q.to.also?.includes(c.to.protocol) ?? false)) return undefined
  if (c.from.component !== undefined && c.from.component !== q.from.component) return undefined
  if (c.from.port !== undefined && c.from.port !== q.from.port) return undefined
  if (c.to.component !== undefined && c.to.component !== q.to.component) return undefined
  if (c.to.fleets === false && (q.to.also?.includes("fleet") ?? false)) return undefined
  return (c.from.component !== undefined ? 4 : 0) + (c.from.port !== undefined ? 2 : 0) + (c.to.component !== undefined ? 4 : 0)
}

export type Picked<C extends Fits> =
  | { readonly ok: true; readonly connector: C; readonly explicit: boolean }
  | { readonly ok: false; readonly reason: string }

/**
 * The connector for a wire: the one the document names, if it fits, or else the most specific that does. Among equally
 * specific ones the first registered wins, so a provider can't silently displace another's choice by registering later.
 */
export const pick = <C extends Fits>(candidates: ReadonlyArray<C>, q: Query, explicit?: string): Picked<C> => {
  if (explicit !== undefined) {
    const named = candidates.find((c) => c.type === explicit)
    if (named === undefined) return { ok: false, reason: `unknown connector "${explicit}"` }
    if (score(named, q) === undefined) return { ok: false, reason: `the ${explicit} connector doesn't fit a ${q.from.protocol} port wired to ${q.to.component}` }
    return { ok: true, connector: named, explicit: true }
  }
  let best: C | undefined
  let bestScore = -1
  for (const c of candidates) {
    const s = score(c, q)
    if (s !== undefined && s > bestScore) {
      best = c
      bestScore = s
    }
  }
  if (best === undefined) {
    return {
      ok: false,
      reason: q.to.protocol === undefined
        ? `${q.to.component} doesn't accept connections`
        : `nothing connects a ${q.from.protocol} port to something that accepts ${q.to.protocol}`
    }
  }
  return { ok: true, connector: best, explicit: false }
}

/** All the connectors that fit a wire, most specific first: what an editor offers when someone wants to choose. */
export const candidates = <C extends Fits>(all: ReadonlyArray<C>, q: Query): ReadonlyArray<C> =>
  all
    .map((c, i) => ({ c, i, s: score(c, q) }))
    .filter((x): x is { c: C; i: number; s: number } => x.s !== undefined)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.c)

// ---------------------------------------------------------------------------------------------------------
// What `make` receives and returns
// ---------------------------------------------------------------------------------------------------------

/** The source end, as a connector sees it: what a `pull` port offers; nothing for `invoke`, whose source pushes. */
export type SourceOf<P extends Protocol> = P extends "pull" ? Pull : undefined

/** The target end, as a connector sees it: a fleet's units for `fleet`; nothing for `invoke`, which is only called. */
export type TargetOf<P extends Protocol> = P extends "fleet" ? Fleet : undefined

export interface Context<Config, From extends Protocol = Protocol, To extends Protocol = Protocol> {
  /** The edge's id. */
  readonly id: string
  readonly from: string
  readonly port: string
  readonly to: string
  /** The edge's live settings: the source port's own fields, this connector's, and transport's. */
  readonly config: SubscriptionRef.SubscriptionRef<Config>
  /** Synchronous tools for hot paths, as a component's `node.fast`. */
  readonly fast: {
    readonly settings: () => Config
    readonly now: () => number
    /** The connector's own seeded stream (separate from transport's, so adding a draw here moves nothing else). */
    readonly random: SeededRandom
    readonly after: <A>(ms: number, fire: (arg: A) => void, arg: A) => TimerHandle
    readonly mint: (init?: Partial<Pick<Message, "bytes" | "count" | "group" | "key" | "invocation" | "operation">>) => Message
  }
  /** The edge's meter: transport's counters are already in it, a connector adds its own. */
  readonly meter: Meter
  readonly limiter: Limiter
  /** Run a background loop for the life of the simulation. */
  readonly spawn: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<void, never, Scope.Scope>
  /** The far end, through the edge's transport. */
  readonly sink: Edge.Wire
  /** The near end, for a connector that takes rather than being sent to. */
  readonly source: SourceOf<From>
  /** The far end's units, for a connector that picks one per call (`to: { protocol: "fleet" }`). */
  readonly target: TargetOf<To>
  /**
   * What the far end's node offers beyond calls (its `Instance.offer`), if anything: a database's ledger of client
   * connections, say. Its shape is agreed between the component and its connectors; narrow it with a guard.
   */
  readonly offer: () => unknown
  /**
   * A resource shared by everything in the far end's placement, as `node.shared` hands it to nodes there: built the first
   * time anyone (a node or a connector) asks for `key`, then reused.
   */
  readonly shared: <A>(key: string, build: Effect.Effect<A, never, Scope.Scope>) => Effect.Effect<A>
}

export interface Instance<State = unknown> {
  /** What happens to a message the source sends. Required when the source port pushes (`invoke`). */
  readonly send?: (message: Message, done?: Edge.Done) => Edge.Cancel
  /** Report internal state: what a probe of the edge returns. */
  readonly probe?: Effect.Effect<State>
}

export type Settings = Schema.Struct<Schema.Struct.Fields>

export interface ConnectorDef<C extends Settings = Settings, S extends Schema.Top = Schema.Top, From extends Protocol = Protocol, To extends Protocol = Protocol> {
  /** Unique id, namespaced like components: `core.link`, `aws.sqs.event-source-mapping`. */
  readonly type: string
  /** `core` for the built-in ones, otherwise the provider that defines it. */
  readonly provider: string
  readonly title: string
  readonly description: string
  readonly icon: string
  readonly docs: string | undefined
  readonly from: FromEnd<From>
  readonly to: ToEnd<To>
  /** What it records on its edge, as charts beside transport's (see `Dashboard.ts`). */
  readonly dashboard: Dashboard.Dashboard | undefined
  /** Its own settings. An edge's full settings add the source port's own before them and transport's after. */
  readonly config: C
  readonly state: S
  readonly make: (ctx: Context<C["Type"], From, To>) => Effect.Effect<Instance<S["Type"]>, never, Scope.Scope>
}

export interface Input<C extends Settings, S extends Schema.Top, From extends Protocol, To extends Protocol> {
  readonly type: string
  readonly provider?: string
  readonly title: string
  readonly description?: string
  readonly icon?: string
  readonly docs?: string
  readonly from: FromEnd<From>
  readonly to?: ToEnd<To>
  readonly dashboard?: Dashboard.Dashboard
  readonly config: C
  readonly state?: S
  readonly make: ConnectorDef<C, S, From, To>["make"]
}

export const make = <const C extends Settings, const From extends Protocol, const S extends Schema.Top = Schema.Struct<{}>, const To extends Protocol = "invoke">(
  input: Input<C, S, From, To>
): ConnectorDef<C, S, From, To> => ({
  type: input.type,
  provider: input.provider ?? "core",
  title: input.title,
  description: input.description ?? "",
  icon: input.icon ?? "chevron",
  docs: input.docs,
  from: input.from,
  to: input.to ?? ({ protocol: "invoke" } as ToEnd<To>),
  dashboard: input.dashboard,
  config: input.config,
  state: (input.state ?? Schema.Struct({})) as S,
  make: input.make
})

/** A connector with its type parameters erased, as registries hold them. */
// biome-ignore lint/suspicious/noExplicitAny: variance: a connector is only ever invoked with values it decoded itself.
export type AnyConnector = ConnectorDef<any, any, any, any>

/** The plain link every push gets unless something more specific fits. */
export const LINK = "core.link"

/** Whether a connector is the plain link, which an editor doesn't need to draw. */
export const isPlain = (type: string): boolean => type === LINK

// ---------------------------------------------------------------------------------------------------------
// An edge's settings
// ---------------------------------------------------------------------------------------------------------

/** Each connector's edge schemas, by the port they leave from, each built once. */
const schemas = memoByIdentity((_: AnyConnector) => new Map<PortDef | undefined, Settings>())

/**
 * The full settings of an edge leaving `port` through `connector`: the port's own fields first (the source component
 * reads them), then the connector's, then transport's. A port can redeclare a field the connector or transport has to
 * change its default (SNS gives its subscriptions a far longer retry policy than a plain call has).
 */
export const edgeSchema = (connector: AnyConnector, port: PortDef | undefined): Settings => {
  const byPort = schemas(connector)
  const known = byPort.get(port)
  if (known !== undefined) return known
  const own: Schema.Struct.Fields = port?.config?.fields ?? {}
  const mine = Object.fromEntries(Object.entries((connector.config as Settings).fields).filter(([k]) => !(k in own)))
  const transport = Object.fromEntries(Object.entries(Edge.Transport.fields).filter(([k]) => !(k in own) && !(k in mine)))
  const schema: Settings = Schema.Struct({ ...own, ...mine, ...transport })
  byPort.set(port, schema)
  return schema
}

// ---------------------------------------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------------------------------------

/** The serialisable description of a connector, for UIs and tools that never run it. */
export interface Manifest extends Fits {
  readonly provider: string
  readonly title: string
  readonly description: string
  readonly icon: string
  readonly docs: string | undefined
  /** Its own settings, without the source port's or transport's. */
  readonly settings: ReadonlyArray<Describe.FieldSpec>
  /** Its charts, shown after transport's on an edge it sits on. */
  readonly dashboard?: Dashboard.Dashboard
}

export const manifestOf = (c: AnyConnector): Manifest => ({
  type: c.type,
  provider: c.provider,
  title: c.title,
  description: c.description,
  icon: c.icon,
  docs: c.docs,
  from: c.from,
  to: c.to,
  settings: Describe.fields(c.config),
  ...(c.dashboard === undefined ? {} : { dashboard: c.dashboard })
})

/** Transport's settings, which every edge has after its port's and its connector's. */
export const transportFields = (): ReadonlyArray<Describe.FieldSpec> => Describe.fields(Edge.Transport)

/**
 * The form for one edge: the port's fields, then the connector's, then transport's, each name once (the first to
 * declare a field owns it, as in `edgeSchema`).
 */
export const edgeFields = (...groups: ReadonlyArray<ReadonlyArray<Describe.FieldSpec>>): ReadonlyArray<Describe.FieldSpec> => {
  const seen = new Set<string>()
  const out: Array<Describe.FieldSpec> = []
  for (const group of groups) {
    for (const field of group) {
      if (seen.has(field.key)) continue
      seen.add(field.key)
      out.push(field)
    }
  }
  return out
}
