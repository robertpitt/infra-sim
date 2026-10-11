import type { Bucket, Limiter } from "../Limiter.ts"

/**
 * Admission through several limits at once, all or nothing.
 *
 * A request that has to get past more than one token bucket (a message group, then the topic, then the region) must
 * not spend from the first if a later one refuses it: the refused request would have cost allowance it never used.
 * So every limit is checked before any is taken. List them most specific first; the reason reported is the first
 * limit that said no.
 *
 * A gate is scratch space: build one per node, then `add` the limits for a call and `take`. Nothing is allocated per call.
 */
export class Gate {
  private n = 0
  private readonly keys: Array<string> = []
  private readonly buckets: Array<Bucket> = []
  private readonly tokens: Array<number> = []
  private readonly reasons: Array<string> = []

  constructor(private readonly limiter: Limiter) {}

  /** Another limit this call must pass. */
  add(key: string, bucket: Bucket, tokens: number, reason: string): this {
    const i = this.n++
    this.keys[i] = key
    this.buckets[i] = bucket
    this.tokens[i] = tokens
    this.reasons[i] = reason
    return this
  }

  /** Take from every limit added since the last call, or from none. `undefined` is admitted; otherwise the refusing limit's reason. */
  take(): string | undefined {
    const n = this.n
    this.n = 0
    const { limiter, keys, buckets, tokens } = this
    if (n === 1) return limiter.takeUnsafe(keys[0]!, buckets[0]!, tokens[0]!) ? undefined : this.reasons[0]
    for (let i = 0; i < n; i++) if (!limiter.fitsUnsafe(keys[i]!, buckets[i]!, tokens[i]!)) return this.reasons[i]
    for (let i = 0; i < n; i++) limiter.takeUnsafe(keys[i]!, buckets[i]!, tokens[i]!)
    return undefined
  }
}
