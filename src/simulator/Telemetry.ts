import { Context, Effect, PubSub, Schema, type Scope, Stream } from "effect"
import { Bucket } from "./internal/telemetry.ts"

/**
 * Windowed telemetry.
 *
 * Every node and edge owns a meter. The simulation flushes all of them once per frame and publishes a
 * `Frame`: counters become per-second rates, samples become percentiles, gauges (effects) are read at flush.
 * Frames are plain, schema-described data, so they cross any boundary: a chart, a worker, a file.
 */

export const Dist = Schema.Struct({
  n: Schema.Number,
  mean: Schema.Number,
  p50: Schema.Number,
  p95: Schema.Number,
  p99: Schema.Number,
  max: Schema.Number
})
export type Dist = typeof Dist.Type

export const Stats = Schema.Struct({
  /** Events per second over the window, by counter name (`in`, `ok`, `fail`, `fail.Throttled`, ...). */
  rates: Schema.Record(Schema.String, Schema.Number),
  /** Instantaneous values read at flush time (`inflight`, `depth`, ...). */
  gauges: Schema.Record(Schema.String, Schema.Number),
  /** Distributions of sampled values (`latency` in ms). */
  dist: Schema.Record(Schema.String, Dist)
})
export type Stats = typeof Stats.Type

export const Frame = Schema.Struct({
  /** Virtual time (ms) at the end of the window. */
  t: Schema.Number,
  /** Window length in ms. */
  dt: Schema.Number,
  nodes: Schema.Record(Schema.String, Stats),
  edges: Schema.Record(Schema.String, Stats),
  /** What controllers recorded: the value they track, what they set. */
  controllers: Schema.Record(Schema.String, Stats)
})
export type Frame = typeof Frame.Type

/**
 * A counter you resolve once and bump forever: `const ok = meter.counter("ok")` then `ok.n++`. No lookup on the hot
 * path, which is what makes counting a handful of things per call nearly free.
 */
export interface Counter {
  n: number
}

/** A sample recorder you resolve once: `latency.add(ms)`. Keeps a bounded, deterministic sample. */
export interface Sampler {
  add(value: number): void
}

/** What a component sees: record events, sample values, expose gauges. All effects. */
export interface Meter {
  /** The counter named `name`. Hold on to it; looking it up per event is the slow way. */
  readonly counter: (name: string) => Counter
  /** The sampler named `name`. */
  readonly sampler: (name: string) => Sampler
  readonly count: (name: string, n?: number) => Effect.Effect<void>
  readonly observe: (name: string, value: number) => Effect.Effect<void>
  /** Register a gauge from a plain function, read at every flush. The cheap form: no effect to run. */
  readonly gaugeUnsafe: (name: string, read: () => number) => void
  /** Register a gauge. `read` runs at every flush, so it can be any effect: `Ref.get`, a probe, a computation. */
  readonly gauge: (name: string, read: Effect.Effect<number>) => Effect.Effect<void>
  /** Synchronous variants for use inside an `Effect.sync` that records several things at once. */
  readonly countUnsafe: (name: string, n?: number) => void
  readonly observeUnsafe: (name: string, value: number) => void
}

export class Telemetry extends Context.Service<Telemetry, {
  readonly node: (id: string) => Meter
  readonly edge: (id: string) => Meter
  readonly controller: (id: string) => Meter
  /** Every frame as it is produced. New subscribers see frames from the moment they subscribe. */
  readonly frames: Stream.Stream<Frame>
  /** Frames produced since the last call. Handy for stepping a simulation and then looking at what happened. */
  readonly drain: Effect.Effect<ReadonlyArray<Frame>>
}>()("simulator/Telemetry") {}

/** Start collecting. Forks the flush loop into the surrounding scope, on whatever clock the caller runs on. */
export const make = (
  frameMs: number,
  now: Effect.Effect<number>
): Effect.Effect<Context.Service.Shape<typeof Telemetry>, never, Scope.Scope> =>
  Effect.gen(function*() {
    const nodes = new Map<string, Bucket>()
    const edges = new Map<string, Bucket>()
    const controllers = new Map<string, Bucket>()
    const bucket = (map: Map<string, Bucket>, id: string) => {
      let b = map.get(id)
      if (b === undefined) {
        b = new Bucket()
        map.set(id, b)
      }
      return b
    }
    const pubsub = yield* PubSub.unbounded<Frame>()
    const collector = yield* PubSub.subscribe(pubsub)

    const flush = Effect.gen(function*() {
      const t = yield* now
      const nodeStats: Record<string, Stats> = {}
      for (const [id, b] of nodes) nodeStats[id] = yield* b.flush(frameMs)
      const edgeStats: Record<string, Stats> = {}
      for (const [id, b] of edges) edgeStats[id] = yield* b.flush(frameMs)
      const controllerStats: Record<string, Stats> = {}
      for (const [id, b] of controllers) controllerStats[id] = yield* b.flush(frameMs)
      yield* PubSub.publish(pubsub, { t, dt: frameMs, nodes: nodeStats, edges: edgeStats, controllers: controllerStats })
    })
    yield* Effect.forkScoped(Effect.forever(Effect.sleep(frameMs).pipe(Effect.andThen(flush))))

    return {
      node: (id) => bucket(nodes, id).meter(),
      edge: (id) => bucket(edges, id).meter(),
      controller: (id) => bucket(controllers, id).meter(),
      frames: Stream.fromPubSub(pubsub),
      // `takeUpTo` returns what is there at once; `takeAll` would wait for a frame.
      drain: PubSub.takeUpTo(collector, Number.MAX_SAFE_INTEGER)
    }
  })
