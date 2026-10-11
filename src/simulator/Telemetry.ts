import { Context, Effect, PubSub, Schema, type Scope, Stream } from "effect"

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
  edges: Schema.Record(Schema.String, Stats)
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
  /** Every frame as it is produced. New subscribers see frames from the moment they subscribe. */
  readonly frames: Stream.Stream<Frame>
  /** Frames produced since the last call. Handy for stepping a simulation and then looking at what happened. */
  readonly drain: Effect.Effect<ReadonlyArray<Frame>>
}>()("simulator/Telemetry") {}

const SAMPLE_CAP = 2048

/**
 * A bounded sample of a stream of values. The first `SAMPLE_CAP` are kept as they come; after that a deterministic
 * reservoir (a hash of the running count picks the slot) keeps it uniform. Backed by one preallocated typed array.
 */
class SampleBuffer implements Sampler {
  readonly values = new Float64Array(SAMPLE_CAP)
  len = 0
  seen = 0

  add(value: number): void {
    const seen = ++this.seen
    if (this.len < SAMPLE_CAP) this.values[this.len++] = value
    else {
      const slot = Math.imul(seen, 2654435761) >>> 0
      if (slot % seen < SAMPLE_CAP) this.values[slot % SAMPLE_CAP] = value
    }
  }
}

class Bucket {
  readonly counters = new Map<string, Counter>()
  readonly samples = new Map<string, SampleBuffer>()
  readonly gauges = new Map<string, Effect.Effect<number>>()
  readonly fastGauges = new Map<string, () => number>()

  counter(name: string): Counter {
    let c = this.counters.get(name)
    if (c === undefined) {
      c = { n: 0 }
      this.counters.set(name, c)
    }
    return c
  }

  sampler(name: string): SampleBuffer {
    let s = this.samples.get(name)
    if (s === undefined) {
      s = new SampleBuffer()
      this.samples.set(name, s)
    }
    return s
  }

  flush(windowMs: number): Effect.Effect<Stats> {
    const seconds = windowMs / 1000
    const rates: Record<string, number> = {}
    for (const [name, c] of this.counters) {
      if (c.n !== 0) {
        rates[name] = c.n / seconds
        c.n = 0
      }
    }
    const dist: Record<string, Dist> = {}
    for (const [name, buffer] of this.samples) {
      if (buffer.len > 0) {
        dist[name] = summarise(buffer.values.slice(0, buffer.len), buffer.seen)
        buffer.len = 0
        buffer.seen = 0
      }
    }
    const gauges: Record<string, number> = {}
    for (const [name, read] of this.fastGauges) gauges[name] = read()
    if (this.gauges.size === 0) return Effect.succeed({ rates, gauges, dist })
    return Effect.forEach([...this.gauges], ([name, read]) => Effect.map(read, (v) => [name, v] as const)).pipe(
      Effect.map((entries) => ({ rates, gauges: { ...gauges, ...Object.fromEntries(entries) }, dist }))
    )
  }

  meter(): Meter {
    return {
      counter: (name) => this.counter(name),
      sampler: (name) => this.sampler(name),
      count: (name, n = 1) => Effect.sync(() => void (this.counter(name).n += n)),
      observe: (name, value) => Effect.sync(() => this.sampler(name).add(value)),
      gaugeUnsafe: (name, read) => void this.fastGauges.set(name, read),
      gauge: (name, read) => Effect.sync(() => void this.gauges.set(name, read)),
      countUnsafe: (name, n = 1) => void (this.counter(name).n += n),
      observeUnsafe: (name, value) => this.sampler(name).add(value)
    }
  }
}

const summarise = (sorted: Float64Array, n: number): Dist => {
  sorted.sort()
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!
  let sum = 0
  for (const v of sorted) sum += v
  return { n, mean: sum / sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1]! }
}

/** Start collecting. Forks the flush loop into the surrounding scope, on whatever clock the caller runs on. */
export const make = (
  frameMs: number,
  now: Effect.Effect<number>
): Effect.Effect<Context.Service.Shape<typeof Telemetry>, never, Scope.Scope> =>
  Effect.gen(function*() {
    const nodes = new Map<string, Bucket>()
    const edges = new Map<string, Bucket>()
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
      yield* PubSub.publish(pubsub, { t, dt: frameMs, nodes: nodeStats, edges: edgeStats })
    })
    yield* Effect.forkScoped(Effect.forever(Effect.sleep(frameMs).pipe(Effect.andThen(flush))))

    return {
      node: (id) => bucket(nodes, id).meter(),
      edge: (id) => bucket(edges, id).meter(),
      frames: Stream.fromPubSub(pubsub),
      // `takeUpTo` returns what is there at once; `takeAll` would wait for a frame.
      drain: PubSub.takeUpTo(collector, Number.MAX_SAFE_INTEGER)
    }
  })
