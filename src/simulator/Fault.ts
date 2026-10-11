import { Context, Duration, Effect, Schema, type Scope, Stream, SubscriptionRef } from "effect"
import { type FieldSpec, fields } from "./Describe.ts"
import * as Setting from "./Setting.ts"

/**
 * Faults are universal: the framework applies them around every node and every edge, so a component author
 * never has to remember to support them. Each kind is a tagged `Schema`, so a fault can be validated, written
 * to disk, sent over a wire, and described to a UI like any other piece of configuration.
 */

export const Outage = Schema.TaggedStruct("Outage", {})
export const Errors = Schema.TaggedStruct("Errors", {
  rate: Setting.ratio({ default: 0.5, label: "Error rate" })
})
export const Slow = Schema.TaggedStruct("Slow", {
  extra: Setting.duration({ default: "1 second", min: 0, max: "10 minutes", label: "Extra latency" })
})
export const Blackhole = Schema.TaggedStruct("Blackhole", {})
export const Loss = Schema.TaggedStruct("Loss", {
  rate: Setting.ratio({ default: 0.2, label: "Loss rate" })
})

export const Fault = Schema.Union([Outage, Errors, Slow, Blackhole, Loss])
export type Fault = typeof Fault.Type

/** A region target's id is a placement key such as `aws:us-east-1`: every node there is affected. */
export type TargetKind = "node" | "edge" | "region"
export const Target = Schema.Struct({ kind: Schema.Literals(["node", "edge", "region"]), id: Schema.String })
export type Target = typeof Target.Type

export interface FaultKind {
  readonly tag: Fault["_tag"]
  readonly label: string
  readonly help: string
  readonly targets: ReadonlyArray<TargetKind>
  readonly fields: ReadonlyArray<FieldSpec>
}

const kinds: ReadonlyArray<Omit<FaultKind, "fields"> & { readonly schema: Schema.Top }> = [
  { tag: "Outage", label: "Outage", help: "Rejects every call at once, like a connection refused or a stopped service. On a region, the whole region is down.", targets: ["node", "edge", "region"], schema: Outage },
  { tag: "Errors", label: "Errors", help: "A fraction of calls fail with a server error after being processed.", targets: ["node", "region"], schema: Errors },
  { tag: "Slow", label: "Slow", help: "Adds fixed latency to every call.", targets: ["node", "edge", "region"], schema: Slow },
  { tag: "Blackhole", label: "Black hole", help: "Calls vanish without a reply; callers wait out their full timeout.", targets: ["edge"], schema: Blackhole },
  { tag: "Loss", label: "Packet loss", help: "A fraction of calls vanish without a reply.", targets: ["edge"], schema: Loss }
]

/** Serialisable description of every fault kind, for UIs that offer fault injection. */
export const catalog: ReadonlyArray<FaultKind> = kinds.map(({ schema, ...kind }) => ({ ...kind, fields: fields(schema) }))

export const ActiveFault = Schema.Struct({
  id: Schema.String,
  target: Target,
  fault: Fault,
  startedAt: Schema.Number,
  /** Virtual time the fault lifts itself, if it has a duration. */
  endsAt: Schema.optionalKey(Schema.Number)
})
export type ActiveFault = typeof ActiveFault.Type

/** What the active faults on one node add up to for the next call. */
export interface NodeEffect {
  readonly outage: boolean
  readonly extraMs: number
  readonly extra: Duration.Duration
  readonly errorRate: number
}
export interface EdgeEffect {
  readonly outage: boolean
  readonly blackhole: boolean
  readonly extraMs: number
  readonly extra: Duration.Duration
  readonly lossRate: number
}

export class NoSuchTarget extends Schema.TaggedError<NoSuchTarget>()("NoSuchTarget", {
  kind: Schema.String,
  id: Schema.String
}) {}

const NO_NODE: NodeEffect = { outage: false, extraMs: 0, extra: Duration.zero, errorRate: 0 }
const NO_EDGE: EdgeEffect = { outage: false, blackhole: false, extraMs: 0, extra: Duration.zero, lossRate: 0 }

export class Faults extends Context.Service<Faults, {
  readonly inject: (target: Target, fault: Fault, duration?: Duration.Input) => Effect.Effect<ActiveFault, NoSuchTarget>
  readonly clear: (id: string) => Effect.Effect<boolean>
  readonly clearAll: Effect.Effect<void>
  readonly active: Effect.Effect<ReadonlyArray<ActiveFault>>
  /** The set of active faults each time it changes. */
  readonly changes: Stream.Stream<ReadonlyArray<ActiveFault>>
  /** Hot path: read on every call. The common case (no faults) is a single map miss. */
  readonly forNode: (id: string) => Effect.Effect<NodeEffect>
  readonly forEdge: (id: string) => Effect.Effect<EdgeEffect>
  /** The same, without an effect: what the call path uses. The no-fault case is one map miss and a shared constant. */
  readonly forNodeUnsafe: (id: string) => NodeEffect
  readonly forEdgeUnsafe: (id: string) => EdgeEffect
}>()("simulator/Faults") {}

export const make = (
  known: {
    readonly nodes: ReadonlySet<string>
    readonly edges: ReadonlySet<string>
    readonly regions: ReadonlySet<string>
    /** The placement key each node runs in, so a regional fault can find its nodes. */
    readonly placementOf: (node: string) => string | undefined
  },
  now: Effect.Effect<number>
): Effect.Effect<Context.Service.Shape<typeof Faults>, never, Scope.Scope> =>
  Effect.gen(function*() {
    const scope = yield* Effect.scope
    const state = yield* SubscriptionRef.make<ReadonlyArray<ActiveFault>>([])
    // Indexed by target for the hot path; `state` is the source of truth for everyone else.
    const byTarget = new Map<string, ReadonlyArray<ActiveFault>>()
    let seq = 0

    // Almost every run has no faults at all, and the lookups below sit on every call: skip them outright.
    let active = 0
    const publish = (next: ReadonlyArray<ActiveFault>) => {
      active = next.length
      byTarget.clear()
      for (const f of next) {
        const key = `${f.target.kind}:${f.target.id}`
        byTarget.set(key, [...(byTarget.get(key) ?? []), f])
      }
      return SubscriptionRef.set(state, next)
    }

    const clear = (id: string): Effect.Effect<boolean> =>
      Effect.gen(function*() {
        const current = yield* SubscriptionRef.get(state)
        if (!current.some((f) => f.id === id)) return false
        yield* publish(current.filter((f) => f.id !== id))
        return true
      })

    const forNodeUnsafe = (id: string): NodeEffect => {
      if (active === 0) return NO_NODE
      const own = byTarget.get(`node:${id}`)
      const placement = known.placementOf(id)
      const regional = placement === undefined ? undefined : byTarget.get(`region:${placement}`)
      const faults = own === undefined ? regional : regional === undefined ? own : [...own, ...regional]
      if (faults === undefined) return NO_NODE
      let outage = false
      let extra = 0
      let ok = 1
      for (const { fault } of faults) {
        if (fault._tag === "Outage") outage = true
        else if (fault._tag === "Slow") extra += Duration.toMillis(fault.extra)
        else if (fault._tag === "Errors") ok *= 1 - fault.rate
      }
      return { outage, extraMs: extra, extra: Duration.millis(extra), errorRate: 1 - ok }
    }
    const forEdgeUnsafe = (id: string): EdgeEffect => {
      if (active === 0) return NO_EDGE
      const faults = byTarget.get(`edge:${id}`)
      if (faults === undefined) return NO_EDGE
      let outage = false
      let blackhole = false
      let extra = 0
      let ok = 1
      for (const { fault } of faults) {
        if (fault._tag === "Outage") outage = true
        else if (fault._tag === "Blackhole") blackhole = true
        else if (fault._tag === "Slow") extra += Duration.toMillis(fault.extra)
        else if (fault._tag === "Loss") ok *= 1 - fault.rate
      }
      return { outage, blackhole, extraMs: extra, extra: Duration.millis(extra), lossRate: 1 - ok }
    }

    return {
      inject: (target, fault, duration?) =>
        Effect.gen(function*() {
          const exists = target.kind === "node" ? known.nodes.has(target.id) : target.kind === "edge" ? known.edges.has(target.id) : known.regions.has(target.id)
          if (!exists) return yield* new NoSuchTarget({ kind: target.kind, id: target.id })
          const startedAt = yield* now
          const ms = duration === undefined ? undefined : Duration.toMillis(Duration.fromInputUnsafe(duration))
          const active: ActiveFault = {
            id: `fault-${++seq}`,
            target,
            fault,
            startedAt,
            ...(ms === undefined ? {} : { endsAt: startedAt + ms })
          }
          yield* publish([...(yield* SubscriptionRef.get(state)), active])
          if (ms !== undefined) yield* Effect.forkIn(Effect.sleep(ms).pipe(Effect.andThen(clear(active.id))), scope)
          return active
        }),
      clear,
      clearAll: Effect.suspend(() => publish([])),
      active: SubscriptionRef.get(state),
      changes: SubscriptionRef.changes(state),
      forNode: (id) => Effect.sync(() => forNodeUnsafe(id)),
      forEdge: (id) => Effect.sync(() => forEdgeUnsafe(id)),
      forNodeUnsafe,
      forEdgeUnsafe
    }
  })
