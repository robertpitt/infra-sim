import { Effect } from "effect"

/**
 * Rate limits: token buckets over the simulation's clock.
 *
 * Cloud rate limits are mostly token buckets, and they are quoted as a steady rate plus a burst: API Gateway's
 * 10,000 rps with 5,000 burst, DynamoDB's provisioned rate with up to five minutes of banked capacity. A bucket
 * starts full, refills continuously at `rate` and never holds more than `burst`. Both are read on every call, so
 * editing a quota while running takes effect at once (a smaller burst trims the bucket, a larger one lets it fill).
 *
 * This is a primitive shared by every component, written for volume: a take is a map lookup and some arithmetic, with
 * no effects, allocation or clock service call. The `Effect` forms exist for code that prefers them.
 */
export interface Limiter {
  /** Take `tokens` from the bucket named `key`, or report that there aren't enough. Never waits. */
  readonly takeUnsafe: (key: string, bucket: Bucket, tokens?: number) => boolean
  /** Whether a take of `tokens` would succeed, without taking anything. */
  readonly fitsUnsafe: (key: string, bucket: Bucket, tokens?: number) => boolean
  /** Tokens in the bucket right now. */
  readonly levelUnsafe: (key: string, bucket: Bucket) => number
  /** How many buckets are being remembered. Idle, fully refilled ones are forgotten (see `makeWith`). */
  readonly size: () => number
  readonly take: (key: string, bucket: Bucket, tokens?: number) => Effect.Effect<boolean>
  readonly level: (key: string, bucket: Bucket) => Effect.Effect<number>
}

export interface Bucket {
  /** Steady-state tokens per second. */
  readonly rate: number
  /** Bucket size: the most that can be spent at once. */
  readonly burst: number
}

interface State {
  tokens: number
  at: number
  /** The bucket's own parameters as last seen, so an idle one can be recognised as full without being asked. */
  rate: number
  burst: number
}

/** Past this many buckets, and at most this often, buckets that have refilled completely are forgotten. */
const SWEEP_ABOVE = 1_024
const SWEEP_EVERY_MS = 10_000

/** A limiter reading time from `now` (milliseconds). */
export const makeWith = (now: () => number): Limiter => {
  const states = new Map<string, State>()
  let swept = 0

  /**
   * Keys can be per-message-group, per-prefix, per-caller: an unbounded set over a long run. A bucket that has refilled
   * completely is exactly what a new one starts as, so dropping it changes nothing, and only the buckets with something
   * to remember stay. Cheap: it runs at most every `SWEEP_EVERY_MS` and only once there are many buckets.
   */
  const sweep = (t: number): void => {
    swept = t
    for (const [key, state] of states) if (state.tokens + ((t - state.at) * state.rate) / 1000 >= state.burst) states.delete(key)
  }

  /** Bring the bucket up to date: refill for the time since it was last touched, capped at the burst. */
  const refresh = (key: string, bucket: Bucket): State => {
    const t = now()
    const burst = bucket.burst < 1 ? 1 : bucket.burst
    let state = states.get(key)
    if (state === undefined) {
      if (states.size > SWEEP_ABOVE && t - swept >= SWEEP_EVERY_MS) sweep(t)
      state = { tokens: burst, at: t, rate: bucket.rate, burst }
      states.set(key, state)
      return state
    }
    state.rate = bucket.rate
    state.burst = burst
    const elapsed = t - state.at
    if (elapsed > 0) {
      state.tokens += (elapsed * bucket.rate) / 1000
      state.at = t
    }
    if (state.tokens > burst) state.tokens = burst
    return state
  }

  /** A request bigger than the whole bucket could never succeed; let it have the bucket rather than starve forever. */
  const needed = (tokens: number, bucket: Bucket): number => (tokens > bucket.burst ? Math.max(1, bucket.burst) : tokens)

  const takeUnsafe = (key: string, bucket: Bucket, tokens = 1): boolean => {
    const state = refresh(key, bucket)
    const need = needed(tokens, bucket)
    if (state.tokens < need) return false
    state.tokens -= need
    return true
  }
  const fitsUnsafe = (key: string, bucket: Bucket, tokens = 1): boolean => refresh(key, bucket).tokens >= needed(tokens, bucket)
  const levelUnsafe = (key: string, bucket: Bucket): number => refresh(key, bucket).tokens

  return {
    takeUnsafe,
    fitsUnsafe,
    levelUnsafe,
    size: () => states.size,
    take: (key, bucket, tokens) => Effect.sync(() => takeUnsafe(key, bucket, tokens)),
    level: (key, bucket) => Effect.sync(() => levelUnsafe(key, bucket))
  }
}

/** A limiter on whatever clock the running fiber has. */
export const make: Effect.Effect<Limiter> = Effect.clockWith((clock) => Effect.succeed(makeWith(() => clock.currentTimeMillisUnsafe())))
