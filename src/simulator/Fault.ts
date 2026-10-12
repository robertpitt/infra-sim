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

export const Crash = Schema.TaggedStruct("Crash", {
  units: Setting.int({ default: 1, min: 1, max: 10_000, label: "How many" }),
  on: Setting.choice(["units", "hosts"], {
    default: "units",
    label: "What crashes",
    labels: { units: "What serves (instances, tasks, pods)", hosts: "The hosts under them (container instances, nodes)" },
    help: "For a service whose tasks or pods run on hosts it also manages (ECS on EC2, EKS), whether the tasks crash or the hosts do."
  })
})

export const Fault = Schema.Union([Outage, Errors, Slow, Blackhole, Loss, Crash])
export type Fault = typeof Fault.Type

/**
 * What a fault is on. A region target's id is a placement key such as `aws:us-east-1`: every node there is affected. A
 * zone target's id is a placement key and one of its zones, `aws:us-east-1:us-east-1a`: every node placed in that zone,
 * and every unit a fleet runs there (see `Placement.zone` and `fleet/`).
 */
export type TargetKind = "node" | "edge" | "region" | "zone"
export const Target = Schema.Struct({ kind: Schema.Literals(["node", "edge", "region", "zone"]), id: Schema.String })
export type Target = typeof Target.Type

export interface FaultKind {
  readonly tag: Fault["_tag"]
  readonly label: string
  readonly help: string
  readonly targets: ReadonlyArray<TargetKind>
  /** It means something only on a fleet's node (a component whose units a balancer can reach one by one). */
  readonly fleetsOnly?: boolean
  readonly fields: ReadonlyArray<FieldSpec>
}

const kinds: ReadonlyArray<Omit<FaultKind, "fields"> & { readonly schema: Schema.Top }> = [
  {
    tag: "Outage",
    label: "Outage",
    help: "Rejects every call at once, like a connection refused or a stopped service. On a region, the whole region is down; on a zone, everything placed in it and every unit a fleet runs there.",
    targets: ["node", "edge", "region", "zone"],
    schema: Outage
  },
  { tag: "Errors", label: "Errors", help: "A fraction of calls fail with a server error after being processed.", targets: ["node", "region", "zone"], schema: Errors },
  { tag: "Slow", label: "Slow", help: "Adds fixed latency to every call.", targets: ["node", "edge", "region", "zone"], schema: Slow },
  { tag: "Blackhole", label: "Black hole", help: "Calls vanish without a reply; callers wait out their full timeout.", targets: ["edge"], schema: Blackhole },
  { tag: "Loss", label: "Packet loss", help: "A fraction of calls vanish without a reply.", targets: ["edge"], schema: Loss },
  {
    tag: "Crash",
    label: "Crash units",
    help: "Crashes some of a fleet's units at once (EC2 instances, ECS tasks, EKS pods or nodes): calls on them fail, a load balancer keeps sending them traffic until its health checks catch them, and the fleet replaces them when it notices. It happens in an instant; on a component that isn't a fleet it does nothing.",
    targets: ["node"],
    fleetsOnly: true,
    schema: Crash
  }
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

/** Nothing wrong: what every lookup answers while no fault reaches what it asks about. */
export const NO_FAULT: NodeEffect = NO_NODE

/** The faults on one target, if any. */
type Faulted = ReadonlyArray<ActiveFault> | undefined

const add = (effect: { outage: boolean; extraMs: number; ok: number }, faults: Faulted): void => {
  if (faults === undefined) return
  for (const { fault } of faults) {
    if (fault._tag === "Outage") effect.outage = true
    else if (fault._tag === "Slow") effect.extraMs += Duration.toMillis(fault.extra)
    else if (fault._tag === "Errors") effect.ok *= 1 - fault.rate
  }
}
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
  /**
   * The same, without an effect: what the call path uses. The no-fault case is one check and a shared constant. A node's
   * own faults, its region's and, for a node placed in a zone, that zone's, add up.
   */
  readonly forNodeUnsafe: (id: string) => NodeEffect
  readonly forEdgeUnsafe: (id: string) => EdgeEffect
  /**
   * The faults on one zone of a placement (`forZoneUnsafe("aws:us-east-1", "us-east-1a")`), and only those: a fleet
   * applies them to the units it runs there, while its region's faults reach it through the node like any other's.
   */
  readonly forZoneUnsafe: (placement: string, zone: string) => NodeEffect
  /** A node's own faults and its region's, without its zone's: what reaches a node that handles its zone's faults itself. */
  readonly forNodeOwnUnsafe: (id: string) => NodeEffect
  /** Every active fault that reaches a node: on the node, its region, or the zone it is placed in. */
  readonly reaching: (id: string) => ReadonlyArray<ActiveFault>
  /**
   * Hear, synchronously, each time the set of active faults changes (after it has). Returns a function that stops
   * listening. What a component uses to notice a zone going down without a fiber of its own.
   */
  readonly listen: (listener: () => void) => () => void
}>()("simulator/Faults") {}

export const make = (
  known: {
    readonly nodes: ReadonlySet<string>
    readonly edges: ReadonlySet<string>
    readonly regions: ReadonlySet<string>
    /** Zone keys (`aws:us-east-1:us-east-1a`) of every zone of every placement in use. */
    readonly zones?: ReadonlySet<string>
    /** The placement key each node runs in, so a regional fault can find its nodes. */
    readonly placementOf: (node: string) => string | undefined
    /** The zone a node is placed in, if it is placed in one. */
    readonly zoneOf?: (node: string) => string | undefined
  },
  now: Effect.Effect<number>
): Effect.Effect<Context.Service.Shape<typeof Faults>, never, Scope.Scope> =>
  Effect.gen(function*() {
    const scope = yield* Effect.scope
    const state = yield* SubscriptionRef.make<ReadonlyArray<ActiveFault>>([])
    // Indexed by target for the hot path; `state` is the source of truth for everyone else.
    const byTarget = new Map<string, ReadonlyArray<ActiveFault>>()
    let seq = 0
    const listeners = new Set<() => void>()

    // Almost every run has no faults at all, and the lookups below sit on every call: skip them outright.
    let active = 0
    const publish = (next: ReadonlyArray<ActiveFault>) =>
      Effect.andThen(
        Effect.suspend(() => {
          active = next.length
          byTarget.clear()
          for (const f of next) {
            const key = `${f.target.kind}:${f.target.id}`
            byTarget.set(key, [...(byTarget.get(key) ?? []), f])
          }
          return SubscriptionRef.set(state, next)
        }),
        // A snapshot: a listener may stop listening, or start another, while it is told.
        Effect.sync(() => {
          for (const listener of [...listeners]) listener()
        })
      )

    /** Lookup keys per node, made once: they are needed on every call while any fault is active. */
    const keys = new Map<string, { readonly node: string; readonly region: string | undefined; readonly zone: string | undefined }>()
    const keysOf = (id: string) => {
      let k = keys.get(id)
      if (k === undefined) {
        const placement = known.placementOf(id)
        const zone = placement === undefined ? undefined : known.zoneOf?.(id)
        k = { node: `node:${id}`, region: placement === undefined ? undefined : `region:${placement}`, zone: zone === undefined ? undefined : `zone:${placement}:${zone}` }
        keys.set(id, k)
      }
      return k
    }

    const clear = (id: string): Effect.Effect<boolean> =>
      Effect.gen(function*() {
        const current = yield* SubscriptionRef.get(state)
        if (!current.some((f) => f.id === id)) return false
        yield* publish(current.filter((f) => f.id !== id))
        return true
      })

    /** What up to three sets of faults (a node's own, its region's, its zone's) add up to. On the call path: no allocation unless something applies. */
    const sum = (a: Faulted, b: Faulted, c: Faulted): NodeEffect => {
      if (a === undefined && b === undefined && c === undefined) return NO_NODE
      const effect = { outage: false, extraMs: 0, ok: 1 }
      add(effect, a)
      add(effect, b)
      add(effect, c)
      return { outage: effect.outage, extraMs: effect.extraMs, extra: Duration.millis(effect.extraMs), errorRate: 1 - effect.ok }
    }

    const forNodeUnsafe = (id: string): NodeEffect => {
      if (active === 0) return NO_NODE
      const k = keysOf(id)
      return sum(byTarget.get(k.node), k.region === undefined ? undefined : byTarget.get(k.region), k.zone === undefined ? undefined : byTarget.get(k.zone))
    }
    const forZoneUnsafe = (placement: string, zone: string): NodeEffect => (active === 0 ? NO_NODE : sum(byTarget.get(`zone:${placement}:${zone}`), undefined, undefined))
    const forNodeOwnUnsafe = (id: string): NodeEffect => {
      if (active === 0) return NO_NODE
      const k = keysOf(id)
      return sum(byTarget.get(k.node), k.region === undefined ? undefined : byTarget.get(k.region), undefined)
    }
    const reaching = (id: string): ReadonlyArray<ActiveFault> => {
      if (active === 0) return []
      const k = keysOf(id)
      return [k.node, k.region, k.zone].flatMap((key) => (key === undefined ? [] : byTarget.get(key) ?? []))
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
          const exists = target.kind === "node"
            ? known.nodes.has(target.id)
            : target.kind === "edge"
            ? known.edges.has(target.id)
            : target.kind === "zone"
            ? known.zones?.has(target.id) ?? false
            : known.regions.has(target.id)
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
      forEdgeUnsafe,
      forZoneUnsafe,
      forNodeOwnUnsafe,
      reaching,
      listen: (listener) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      }
    }
  })
