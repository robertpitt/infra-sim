import { Effect, type Scope, Schema } from "effect"
import type { AnyComponent } from "./Component.ts"
import { builtins, providers } from "./components/Builtins.ts"
import * as Design from "./Design.ts"
import type { Provider } from "./Provider.ts"
import * as Registry from "./Registry.ts"
import * as Simulation from "./Simulation.ts"
import type { Frame } from "./Telemetry.ts"
import { VirtualTime } from "./VirtualTime.ts"

/**
 * Helpers for the simulator's tests: running a design on virtual time, and reading its frames. A folder's own
 * `testing.ts` adds what only its tests need (test components, the designs they build).
 */

// ---------------------------------------------------------------------------------------------------------
// Running a design
// ---------------------------------------------------------------------------------------------------------

/** Ways to run a design against one registry. */
export interface Simulator {
  /** The built-in components and providers, plus the test ones. */
  readonly registry: Registry.Components
  /** Decode a document, failing with every problem listed. */
  readonly decode: (doc: Design.Doc) => Effect.Effect<Design.Design>
  /** A simulation of the document, living as long as the surrounding scope. */
  readonly start: (doc: Design.Doc, options?: Simulation.Options) => Effect.Effect<Simulation.Service, never, Scope.Scope>
  /** Run a test body against a fresh simulation. */
  readonly sim: <A, E>(doc: Design.Doc, body: (sim: Simulation.Service) => Effect.Effect<A, E>, options?: Simulation.Options) => Promise<A>
  /** Run a document for this long and return every frame. */
  readonly frames: (doc: Design.Doc, ms: number, options?: Simulation.Options) => Promise<ReadonlyArray<Frame>>
}

/** A `Simulator` whose registry has the built-ins plus `components` and `extraProviders` (test-only ones). */
export const simulator = (components: ReadonlyArray<AnyComponent> = [], extraProviders: ReadonlyArray<Provider> = []): Simulator => {
  const all = [...builtins, ...components]
  const allProviders = [...providers, ...extraProviders]
  const registry = Registry.make(all, allProviders)
  const layer = Registry.Registry.layer(all, allProviders)
  const codec = Design.codec(registry)
  const decode = (doc: Design.Doc): Effect.Effect<Design.Design> =>
    Schema.decodeUnknownEffect(codec)(doc, { errors: "all" }).pipe(Effect.catch((error) => Effect.die(new Error(error.message))))
  const start = (doc: Design.Doc, options: Simulation.Options = {}) =>
    Effect.flatMap(decode(doc), (design) => Simulation.make(design, options).pipe(Effect.provide([VirtualTime.layer, layer]), Effect.orDie))
  const sim = <A, E>(doc: Design.Doc, body: (sim: Simulation.Service) => Effect.Effect<A, E>, options: Simulation.Options = {}): Promise<A> =>
    Effect.runPromise(Effect.scoped(Effect.flatMap(start(doc, options), body)))
  const frames = (doc: Design.Doc, ms: number, options: Simulation.Options = {}) => sim(doc, (s) => s.advanceTo(ms), options)
  return { registry, decode, start, sim, frames }
}

/** The built-in components and providers. */
export const { decode, start, sim, frames } = simulator()

// ---------------------------------------------------------------------------------------------------------
// Reading frames
// ---------------------------------------------------------------------------------------------------------

/** The frames whose window ends in [fromMs, toMs]. */
const between = (all: ReadonlyArray<Frame>, fromMs: number, toMs: number): ReadonlyArray<Frame> => all.filter((f) => f.t >= fromMs && f.t <= toMs)

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
  const picked = between(all, fromMs, toMs)
  if (picked.length === 0) return 0
  return picked.reduce((sum, f) => sum + (f[scope][id]?.[kind][name] ?? 0), 0) / picked.length
}

/** The largest value a node's or edge's rate or gauge reached in any one frame ending in [fromMs, toMs] (0 at least). */
export const peak = (
  all: ReadonlyArray<Frame>,
  scope: "nodes" | "edges",
  id: string,
  kind: "rates" | "gauges",
  name: string,
  fromMs = 0,
  toMs = Infinity
): number => between(all, fromMs, toMs).reduce((most, f) => Math.max(most, f[scope][id]?.[kind][name] ?? 0), 0)

/** A node's rate, averaged over the frames ending in [fromMs, toMs]. */
export const rate = (all: ReadonlyArray<Frame>, id: string, name: string, fromMs = 0, toMs = Infinity): number =>
  mean(all, "nodes", id, "rates", name, fromMs, toMs)

/** A node's gauge, averaged over the frames ending in [fromMs, toMs]. */
export const gauge = (all: ReadonlyArray<Frame>, id: string, name: string, fromMs = 0, toMs = Infinity): number =>
  mean(all, "nodes", id, "gauges", name, fromMs, toMs)

/** The largest value a node's gauge reached in frames ending in [fromMs, toMs] (0 at least). */
export const peakGauge = (all: ReadonlyArray<Frame>, id: string, name: string, fromMs = 0, toMs = Infinity): number =>
  peak(all, "nodes", id, "gauges", name, fromMs, toMs)

/** The smallest value of a node's gauge in frames ending in [fromMs, toMs]; a frame without it counts as Infinity. */
export const minGauge = (all: ReadonlyArray<Frame>, id: string, name: string, fromMs = 0, toMs = Infinity): number =>
  Math.min(...between(all, fromMs, toMs).map((f) => f.nodes[id]?.gauges[name] ?? Infinity))

/** The largest value of a node's gauge in frames ending in [fromMs, toMs]; a frame without it counts as -Infinity. */
export const maxGauge = (all: ReadonlyArray<Frame>, id: string, name: string, fromMs = 0, toMs = Infinity): number =>
  Math.max(...between(all, fromMs, toMs).map((f) => f.nodes[id]?.gauges[name] ?? -Infinity))

/** The end of the first frame, at or after `fromMs`, in which a node's gauge passes `test`. */
export const firstAt = (all: ReadonlyArray<Frame>, id: string, name: string, test: (v: number) => boolean, fromMs = 0): number | undefined =>
  all.find((f) => f.t >= fromMs && test(f.nodes[id]?.gauges[name] ?? Number.NaN))?.t

/** A node's latency distribution, each statistic averaged over the frames ending in [fromMs, toMs] that have it. */
export const dist = (all: ReadonlyArray<Frame>, id: string, name: string, fromMs = 0, toMs = Infinity) => {
  const picked = between(all, fromMs, toMs).flatMap((f) => (f.nodes[id]?.dist[name] ? [f.nodes[id]!.dist[name]!] : []))
  const avg = (key: "p50" | "p95" | "p99" | "mean") => picked.reduce((s, d) => s + d[key], 0) / Math.max(1, picked.length)
  return { p50: avg("p50"), p95: avg("p95"), p99: avg("p99"), mean: avg("mean"), windows: picked.length }
}
