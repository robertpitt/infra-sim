/**
 * The bookkeeping behind `Telemetry.ts`: a meter's counters, bounded samples and gauges, and how a window of them is
 * flushed into a frame's `Stats`. Plain mutable classes, because a counter is bumped and a sample taken on every call.
 */
import { Effect } from "effect"
import type { Counter, Dist, Meter, Sampler, Stats } from "../Telemetry.ts"

/** How many values a sampler keeps per window. */
const SAMPLE_CAP = 2048

/**
 * A bounded sample of a stream of values. The first `SAMPLE_CAP` are kept as they come; after that a deterministic
 * reservoir (a hash of the running count picks the slot) keeps it uniform. Backed by one preallocated typed array.
 */
export class SampleBuffer implements Sampler {
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

/** One node's, edge's or controller's meter: its counters, samplers and gauges, flushed into `Stats` once per frame. */
export class Bucket {
  readonly counters = new Map<string, Counter>()
  readonly samples = new Map<string, SampleBuffer>()
  readonly gauges = new Map<string, Effect.Effect<number>>()
  readonly fastGauges = new Map<string, () => number>()

  /** The counter named `name`, made on first use. */
  counter(name: string): Counter {
    let c = this.counters.get(name)
    if (c === undefined) {
      c = { n: 0 }
      this.counters.set(name, c)
    }
    return c
  }

  /** The sampler named `name`, made on first use. */
  sampler(name: string): SampleBuffer {
    let s = this.samples.get(name)
    if (s === undefined) {
      s = new SampleBuffer()
      this.samples.set(name, s)
    }
    return s
  }

  /** This window's rates, distributions and gauges; counters and samples start the next window empty. */
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

  /** The face of this bucket a component records through. */
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

/** Sorts `sorted` in place and reads its mean and percentiles; `n` is how many values the sample stood for. */
const summarise = (sorted: Float64Array, n: number): Dist => {
  sorted.sort()
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!
  let sum = 0
  for (const v of sorted) sum += v
  return { n, mean: sum / sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1]! }
}
