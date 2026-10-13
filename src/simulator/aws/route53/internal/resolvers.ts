import type { SeededRandom } from "../../../SeededRandom.ts"

/** A cache holding no answer. */
export const NONE = -1

/**
 * The DNS caches between the callers and Route 53: recursive resolvers, and the stub caches in clients. Each holds at
 * most one answer (the index of a record) until it expires, so a change Route 53 makes reaches only the callers whose
 * cache has run out since. Two typed arrays, so a population of 100,000 costs no objects.
 *
 * A call uses the cache its key falls in. The key is the caller's own (a message keeps it through retries), so a
 * retry asks the same cache as the try it repeats, as a client asks the same resolver; and a hot key, one client, sits
 * behind one cache.
 */
export class ResolverCaches {
  answers: Int32Array = new Int32Array(0)
  expires: Float64Array = new Float64Array(0)

  get size(): number {
    return this.answers.length
  }

  /** Grow or shrink the population. Caches that stay keep what they hold; new ones start empty. */
  resize(n: number): void {
    if (n === this.answers.length) return
    const keep = Math.min(n, this.answers.length)
    const answers = new Int32Array(n).fill(NONE)
    const expires = new Float64Array(n)
    answers.set(this.answers.subarray(0, keep))
    expires.set(this.expires.subarray(0, keep))
    this.answers = answers
    this.expires = expires
  }

  /** The cache a call with this key uses. */
  of(key: number): number {
    const n = this.answers.length
    const i = Math.floor((key > 0 ? (key < 1 ? key : 0.999999999999) : 0) * n)
    return i < n ? i : n - 1
  }

  /** The record cache `i` answers with right now, or `NONE` when it has to ask. */
  cached(i: number, now: number): number {
    return this.expires[i]! > now ? this.answers[i]! : NONE
  }

  /**
   * Keep an answer for `holdMs`. A cache filling for the first time is given a random part of its lifetime, as if it
   * had asked at some moment before the run began: otherwise every cache would fill in the first second and expire
   * together, and a change would reach all the traffic at once instead of spreading over one TTL.
   */
  store(i: number, record: number, now: number, holdMs: number, random: SeededRandom): void {
    const first = this.answers[i] === NONE
    this.answers[i] = record
    this.expires[i] = now + (first ? holdMs * random.nextDoubleUnsafe() : holdMs)
  }

  /** How many caches hold a live answer, and how many of those point at a record `bad` says no to. */
  count(now: number, bad: (record: number) => boolean): { readonly live: number; readonly bad: number } {
    let live = 0
    let unhealthy = 0
    for (let i = 0; i < this.answers.length; i++) {
      if (this.expires[i]! <= now) continue
      live++
      if (bad(this.answers[i]!)) unhealthy++
    }
    return { live, bad: unhealthy }
  }

  /** How many caches hold a live answer pointing at each record. */
  perRecord(now: number, records: number): Array<number> {
    const out = new Array<number>(records).fill(0)
    for (let i = 0; i < this.answers.length; i++) {
      const record = this.answers[i]!
      if (this.expires[i]! > now && record >= 0 && record < records) out[record] = out[record]! + 1
    }
    return out
  }
}
