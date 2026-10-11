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
  /** Tokens in the bucket right now. */
  readonly levelUnsafe: (key: string, bucket: Bucket) => number
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
}

/** A limiter reading time from `now` (milliseconds). */
export const makeWith = (now: () => number): Limiter => {
  const states = new Map<string, State>()

  /** Bring the bucket up to date: refill for the time since it was last touched, capped at the burst. */
  const refresh = (key: string, bucket: Bucket): State => {
    const t = now()
    const burst = bucket.burst < 1 ? 1 : bucket.burst
    let state = states.get(key)
    if (state === undefined) {
      state = { tokens: burst, at: t }
      states.set(key, state)
      return state
    }
    const elapsed = t - state.at
    if (elapsed > 0) {
      state.tokens += (elapsed * bucket.rate) / 1000
      state.at = t
    }
    if (state.tokens > burst) state.tokens = burst
    return state
  }

  const takeUnsafe = (key: string, bucket: Bucket, tokens = 1): boolean => {
    const state = refresh(key, bucket)
    // A request bigger than the whole bucket could never succeed; let it have the bucket rather than starve forever.
    const needed = tokens > bucket.burst ? Math.max(1, bucket.burst) : tokens
    if (state.tokens < needed) return false
    state.tokens -= needed
    return true
  }
  const levelUnsafe = (key: string, bucket: Bucket): number => refresh(key, bucket).tokens

  return {
    takeUnsafe,
    levelUnsafe,
    take: (key, bucket, tokens) => Effect.sync(() => takeUnsafe(key, bucket, tokens)),
    level: (key, bucket) => Effect.sync(() => levelUnsafe(key, bucket))
  }
}

/** A limiter on whatever clock the running fiber has. */
export const make: Effect.Effect<Limiter> = Effect.clockWith((clock) => Effect.succeed(makeWith(() => clock.currentTimeMillisUnsafe())))
