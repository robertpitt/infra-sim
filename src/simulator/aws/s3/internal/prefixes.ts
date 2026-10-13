import { Duration } from "effect"
import type { Bucket } from "../../../Limiter.ts"

/**
 * How S3 limits requests: per prefix, with the read and the write allowance counted apart.
 *
 * Each prefix has a guaranteed rate ("at least" 3,500 writes and 5,500 reads a second) and S3 scales a prefix that
 * keeps being asked for more, gradually, answering 503 Slow Down until the scaling catches up. The scaling is
 * described but not timed in AWS's documentation, so it is an optional, assumed model: a prefix that is refused
 * without a break for `splitAfter` is split, which doubles its rate, up to `maxSplits` doublings.
 *
 * One `Allowance` is one token bucket (rate = burst: a second's worth) for one prefix and one class of request.
 * They are created the first time a prefix is hit, so a bucket with 100,000 prefixes only holds the ones that carry traffic.
 */

/**
 * "Without a break": refusals further apart than this start a new run. S3 publishes nothing about how it decides a
 * prefix is persistently hot, so ten seconds is an assumption: long enough to bridge the gaps in a refused stream,
 * short enough that a brief spike never counts as sustained.
 */
export const SUSTAIN_GAP_MS = 10_000

export interface Scaling {
  readonly enabled: boolean
  readonly splitAfter: Duration.Duration
  readonly maxSplits: number
}

export class Allowance {
  /** Doublings S3 has applied to this prefix so far. */
  splits = 0
  /** The bucket the limiter reads on every call. Replaced (never mutated) when the rate changes, so it is allocation-free per call. */
  bucket: Bucket
  /** Start of the current run of refusals, and the most recent refusal. */
  private runStart = 0
  private lastRefusal = Number.NEGATIVE_INFINITY

  constructor(readonly key: string, readonly read: boolean, public floor: number) {
    this.bucket = { rate: floor, burst: floor }
  }

  /** The rate this prefix is allowed now, in requests a second. */
  get ceiling(): number {
    return this.bucket.rate
  }

  /** Back to a guaranteed rate of `floor`, forgetting any scaling. */
  reset(floor: number): void {
    this.floor = floor
    this.splits = 0
    this.runStart = 0
    this.lastRefusal = Number.NEGATIVE_INFINITY
    this.bucket = { rate: floor, burst: floor }
  }

  /**
   * A request was refused at `now`. Under the scale-up model, count it towards a run, and split the prefix when
   * the run has lasted `splitAfter`. Returns whether the rate changed.
   */
  refused(now: number, scaling: Scaling): boolean {
    if (now - this.lastRefusal > SUSTAIN_GAP_MS) this.runStart = now
    this.lastRefusal = now
    if (this.splits >= scaling.maxSplits || now - this.runStart < Duration.toMillis(scaling.splitAfter)) return false
    this.splits++
    this.runStart = now
    const rate = this.floor * 2 ** this.splits
    this.bucket = { rate, burst: rate }
    return true
  }
}

/** The allowances of one bucket: a table per class of request, indexed by prefix. */
export class PrefixTable {
  private readonly reads: Array<Allowance | undefined> = []
  private readonly writes: Array<Allowance | undefined> = []
  /** Prefixes currently above their guaranteed rate; the only ones a gauge or probe needs to look at. */
  readonly scaled = new Set<Allowance>()

  constructor(private readonly id: string) {}

  /**
   * The allowance for `index`, at a guaranteed rate of `floor`. Fixes up an allowance that is stale after a live
   * edit: a changed guarantee (bucket type), or scaling that was turned off or lowered.
   */
  get(index: number, read: boolean, floor: number, scaling: Scaling): Allowance {
    const table = read ? this.reads : this.writes
    let a = table[index]
    if (a === undefined) {
      a = new Allowance(`${this.id}/prefix${index}/${read ? "read" : "write"}`, read, floor)
      table[index] = a
      return a
    }
    if (a.floor !== floor) {
      a.reset(floor)
      this.scaled.delete(a)
    } else if (a.splits !== 0 && (!scaling.enabled || a.splits > scaling.maxSplits)) {
      a.reset(floor)
      this.scaled.delete(a)
    }
    return a
  }

  /** Report a refusal on `a`; keeps `scaled` up to date. */
  refuse(a: Allowance, now: number, scaling: Scaling): void {
    if (scaling.enabled && a.refused(now, scaling)) this.scaled.add(a)
  }

  /** The highest rate any scaled prefix of this class has reached. */
  highest(read: boolean): number {
    let top = 0
    for (const a of this.scaled) if (a.read === read && a.ceiling > top) top = a.ceiling
    return top
  }
}

/** The prefix a key falls on: keys are spread evenly over [0, 1); anything outside lands on the nearest end. */
export const prefixIndex = (key: number, prefixes: number): number =>
  key > 0 ? (key < 1 ? Math.min(prefixes - 1, Math.floor(key * prefixes)) : prefixes - 1) : 0
