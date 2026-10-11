import { Duration, Effect, type Scope, Schema } from "effect"
import type * as Design from "../Design.ts"
import { codec } from "../Design.ts"
import * as Simulation from "../Simulation.ts"
import type { Frame } from "../Telemetry.ts"
import { VirtualTime } from "../VirtualTime.ts"
import { layer, registry } from "./registry.ts"

/** Decode a document with the built-in components, failing with every problem listed. */
export const decode = (doc: Design.Doc): Effect.Effect<Design.Design> =>
  Schema.decodeUnknownEffect(codec(registry))(doc, { errors: "all" }).pipe(
    Effect.catch((error) => Effect.die(new Error(error.message)))
  )

/** A simulation of the document, living as long as the surrounding scope. */
export const start = (doc: Design.Doc, options: Simulation.Options = {}): Effect.Effect<Simulation.Service, never, Scope.Scope> =>
  Effect.gen(function*() {
    const design = yield* decode(doc)
    return yield* Simulation.make(design, options).pipe(Effect.provide(VirtualTime.layer), Effect.provide(layer), Effect.orDie)
  })

/** Run a test body against a fresh simulation. */
export const sim = <A, E>(
  doc: Design.Doc,
  body: (sim: Simulation.Service) => Effect.Effect<A, E>,
  options: Simulation.Options = {}
): Promise<A> => Effect.runPromise(Effect.scoped(Effect.flatMap(start(doc, options), body)))

/** Run a document for this long and return every frame. */
export const frames = (doc: Design.Doc, ms: number, options: Simulation.Options = {}): Promise<ReadonlyArray<Frame>> =>
  sim(doc, (s) => s.advanceTo(ms), options)

/** Average a node's or edge's rate or gauge over frames whose window ends in [fromMs, toMs]. */
export const mean = (
  all: ReadonlyArray<Frame>,
  scope: "nodes" | "edges",
  id: string,
  kind: "rates" | "gauges",
  name: string,
  fromMs = 0,
  toMs = Infinity
): number => {
  const picked = all.filter((f) => f.t >= fromMs && f.t <= toMs)
  if (picked.length === 0) return 0
  return picked.reduce((sum, f) => sum + (f[scope][id]?.[kind][name] ?? 0), 0) / picked.length
}

export const dist = (all: ReadonlyArray<Frame>, id: string, name: string, fromMs = 0, toMs = Infinity) => {
  const picked = all.filter((f) => f.t >= fromMs && f.t <= toMs).flatMap((f) => (f.nodes[id]?.dist[name] ? [f.nodes[id]!.dist[name]!] : []))
  const avg = (key: "p50" | "p95" | "p99" | "mean") => picked.reduce((s, d) => s + d[key], 0) / Math.max(1, picked.length)
  return { p50: avg("p50"), p95: avg("p95"), p99: avg("p99"), mean: avg("mean"), windows: picked.length }
}

export const ms = Duration.millis
