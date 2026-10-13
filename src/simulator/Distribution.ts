import { Duration, Effect, Random } from "effect"
import type { Latency } from "./Setting.ts"
import { memoByIdentity } from "./internal/memo.ts"

/** Sampling. Uses whatever `Random` service is in scope, so a seeded one makes everything repeatable. */

/** What a latency needs for sampling, worked out once per setting rather than once per sample. */
interface Shape {
  readonly mean: number
  readonly mu: number
  readonly sigma: number
}
const shapeOf = memoByIdentity((l: Latency): Shape => {
  const mean = Duration.toMillis(l.mean)
  const sigma2 = l.cv > 0 && mean > 0 ? Math.log(1 + l.cv * l.cv) : 0
  return { mean, mu: sigma2 > 0 ? Math.log(mean) - sigma2 / 2 : mean, sigma: Math.sqrt(sigma2) }
})

/** One lognormal draw from two uniform numbers in [0, 1), in milliseconds. */
const lognormal = (shape: Shape, a: number, b: number): number =>
  // Box–Muller; 1 - a keeps the argument of log in (0, 1].
  Math.exp(shape.mu + shape.sigma * Math.sqrt(-2 * Math.log(1 - a)) * Math.cos(2 * Math.PI * b))

/** Anything that can say a number in [0, 1): a `SeededRandom`. */
export interface Source {
  readonly nextDoubleUnsafe: () => number
}

/**
 * A lognormal latency in milliseconds, drawn straight from a random source: no effects, no services. This is what
 * the hot paths use; `latency` below is the same draw as an `Effect`.
 */
export const latencyMs = (l: Latency, random: Source): number => {
  const shape = shapeOf(l)
  return shape.sigma === 0 ? shape.mean : lognormal(shape, random.nextDoubleUnsafe(), random.nextDoubleUnsafe())
}

/** A lognormal duration with the given mean and coefficient of variation; `cv` of 0 is exactly the mean. */
export const latency = (l: Latency): Effect.Effect<Duration.Duration> => {
  const shape = shapeOf(l)
  if (shape.sigma === 0) return Effect.succeed(l.mean)
  return Effect.map(Effect.zip(Random.next, Random.next), ([a, b]) => Duration.millis(lognormal(shape, a, b)))
}

/** An exponentially distributed duration: the gaps between arrivals of a Poisson process. */
export const exponential = (mean: Duration.Duration): Effect.Effect<Duration.Duration> =>
  Effect.map(Random.next, (u) => Duration.millis(-Duration.toMillis(mean) * Math.log(1 - u)))

/** Pick by weight. `undefined` when there is nothing to pick or every weight is zero. */
export const weighted = <T>(items: ReadonlyArray<T>, weights: ReadonlyArray<number>): Effect.Effect<T | undefined> =>
  Effect.gen(function*() {
    let total = 0
    for (const w of weights) total += Math.max(0, w)
    if (total <= 0) return undefined
    let r = (yield* Random.next) * total
    for (let i = 0; i < items.length; i++) {
      r -= Math.max(0, weights[i] ?? 0)
      if (r < 0) return items[i]
    }
    return items[items.length - 1]
  })
