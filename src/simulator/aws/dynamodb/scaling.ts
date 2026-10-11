/**
 * On-demand scaling of one table or index in one direction (reads or writes).
 *
 * What AWS says (on-demand-capacity-mode, warm-throughput): a new table sustains 4,000 writes and 12,000 reads a
 * second; on-demand "instantly accommodates up to double the previous peak traffic"; "throttling can occur if you
 * exceed double your previous peak within 30 minutes", so growth beyond that should be spaced at least 30 minutes
 * apart; and once a table has scaled out "you can instantly achieve the same throughput again in the future", so the
 * previous peak does not decay. Pre-warming raises the baseline and can't be lowered.
 *
 * The model:
 *  - `peak` is the most units consumed in any one second, ever (a ratchet: it is never forgotten);
 *  - what the table may absorb right now is `max(baseline, 2 x counted)`, where `counted` is the part of the peak the
 *    ceiling has been allowed to grow to;
 *  - `counted` may at most double once per scale-out interval (`max(baseline, 2 x anchor)`, the anchor being the
 *    counted peak at the start of the interval). That is the 30-minute spacing: a table pinned at its ceiling gets a
 *    doubled ceiling one interval later, not a second later. AWS publishes no fixed step; the interval is a setting.
 *
 * Consumption is counted per whole second, lazily: nothing runs while the table is idle, and an interval boundary is
 * noticed by the first call or probe after it.
 */
export class OnDemandScaler {
  /** Most units consumed in one second so far. Never decreases. */
  peak = 0
  /** Part of the peak the ceiling is derived from: the peak, held back to at most double per interval. */
  counted = 0
  private baseline = 0
  private intervalMs = 30 * 60 * 1000
  private anchor = 0
  private anchorAt = -1
  private second = -1
  private used = 0

  /** `changes` is bumped whenever the ceiling may have moved, so memoised capacity knows to be worked out again. */
  constructor(private readonly changes: { n: number }) {}

  /** Point the scaler at the baseline (new-table default or pre-warmed) and interval now in force. Cheap when unchanged. */
  configure(baseline: number, intervalMs: number): void {
    if (baseline === this.baseline && intervalMs === this.intervalMs) return
    this.baseline = baseline
    this.intervalMs = intervalMs
    this.counted = this.allowed()
    this.changes.n++
  }

  /** Units the resource can absorb right now before quotas and any maximum. */
  ceiling(now: number): number {
    this.touch(now)
    return Math.max(this.baseline, 2 * this.counted)
  }

  /** Count `units` consumed at `now`. */
  record(now: number, units: number): void {
    const second = Math.floor(now / 1000)
    if (second !== this.second) this.advance(now, second)
    this.used += units
  }

  /** Bring the scaler up to date without consuming anything. */
  touch(now: number): void {
    const second = Math.floor(now / 1000)
    if (second !== this.second) this.advance(now, second)
  }

  private allowed(): number {
    return Math.min(this.peak, Math.max(this.baseline, 2 * this.anchor))
  }

  private advance(now: number, second: number): void {
    if (this.used > this.peak) this.peak = this.used
    this.used = 0
    this.second = second
    if (this.anchorAt < 0) this.anchorAt = now
    // Each whole interval that has passed lets the ceiling double once more. Bounded: after a few steps the anchor has
    // caught up with the peak and further steps change nothing.
    let steps = 0
    while (now - this.anchorAt >= this.intervalMs && steps++ < 64) {
      const next = this.allowed()
      this.anchorAt += this.intervalMs
      if (next === this.anchor) {
        this.anchorAt = now - ((now - this.anchorAt) % this.intervalMs)
        break
      }
      this.anchor = next
    }
    const counted = this.allowed()
    if (counted !== this.counted) {
      this.counted = counted
      this.changes.n++
    }
  }
}
