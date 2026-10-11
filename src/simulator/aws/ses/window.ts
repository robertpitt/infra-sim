/**
 * The rolling 24-hour sending quota.
 *
 * SES counts the recipients it accepted "in the previous 24 hours" (a rolling period, not a calendar day). Keeping every
 * send would grow without bound, so the day is cut into fixed 5-minute buckets in a ring: a send is added to the current
 * bucket and a bucket's recipients leave the total when the ring comes back round to it. The quota therefore frees up
 * between 24 hours and 24 hours 5 minutes after the send, and memory never exceeds 288 numbers however busy the design is.
 */
export const DAY_MS = 24 * 60 * 60 * 1000
export const BUCKET_MS = 5 * 60 * 1000
const BUCKETS = DAY_MS / BUCKET_MS

export class DailyWindow {
  private readonly counts = new Float64Array(BUCKETS)
  /** Absolute index (time / BUCKET_MS) of the newest bucket; -1 before the first use. */
  private head = -1
  private total = 0

  /** Move the ring forward to `now`, dropping the buckets that have left the 24 hours. */
  private roll(now: number): void {
    const index = Math.floor(now / BUCKET_MS)
    if (index <= this.head) return // same bucket (or a clock that did not move)
    if (this.head < 0 || index - this.head >= BUCKETS) {
      this.counts.fill(0)
      this.total = 0
    } else {
      for (let k = this.head + 1; k <= index; k++) {
        const slot = k % BUCKETS
        this.total -= this.counts[slot]!
        this.counts[slot] = 0
      }
    }
    this.head = index
  }

  /** Recipients sent in the last 24 hours. */
  used(now: number): number {
    this.roll(now)
    return this.total
  }

  /** Record `n` recipients accepted now. */
  add(now: number, n: number): void {
    this.roll(now)
    this.counts[this.head % BUCKETS]! += n
    this.total += n
  }
}
