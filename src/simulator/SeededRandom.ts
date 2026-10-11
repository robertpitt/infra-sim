import type { Random } from "effect"

/**
 * A deterministic implementation of Effect's own `Random` service.
 *
 * Provide it with `Effect.provideService(Random.Random, rng)` and every `Random.next`, `Random.nextIntBetween`,
 * `Schedule.jittered` ... underneath is repeatable. Each node and edge gets its own stream, forked from the
 * simulation seed by label, so changing one part of a design never reshuffles the randomness seen by the rest;
 * that is what makes before/after comparisons of two designs meaningful.
 */
export interface SeededRandom extends Random.Random {
  readonly seed: number
  /** An independent stream derived from this one's seed and a label. */
  readonly fork: (label: string) => SeededRandom
}

const mix = (seed: number, label: string): number => {
  // FNV-1a over the label, seeded.
  let h = (0x811c9dc5 ^ seed) >>> 0
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

export const make = (seed: number): SeededRandom => {
  let state = seed >>> 0
  // mulberry32
  const nextDoubleUnsafe = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    seed,
    nextDoubleUnsafe,
    nextIntUnsafe: () => Math.floor(nextDoubleUnsafe() * Number.MAX_SAFE_INTEGER),
    fork: (label) => make(mix(seed, label))
  }
}
