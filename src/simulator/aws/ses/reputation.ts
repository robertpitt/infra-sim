/**
 * Sender reputation and what SES does about it.
 *
 * SES watches two rates on every account (source: `sources.reputation`, `sources.enforcement`):
 *  - the bounce rate: hard bounces as a share of mail sent (soft bounces, verified domains, suppressed addresses and the
 *    mailbox simulator do not count);
 *  - the complaint rate: complaints as a share of mail sent.
 * At 5% bounces or 0.1% complaints AWS "automatically places your account under review": mail still flows, and if the
 * problem is not fixed by the end of the review period, at 10% bounces or 0.5% complaints "we might pause your account's
 * ability to send". A paused account cannot send at all (SendingPausedException) until AWS lifts it.
 *
 * Both rates are computed over a "representative volume" of recent mail, not a fixed period, and AWS does not say how big
 * that is. Here it is a window of the last N recipients, kept as a ring of fixed slices so memory is constant.
 */

/** Status values, as numbers so a gauge can show them: 0 healthy, 1 under review, 2 sending paused. */
export const HEALTHY = 0
export const REVIEW = 1
export const PAUSED = 2
export type Standing = typeof HEALTHY | typeof REVIEW | typeof PAUSED
export const STATUS_NAMES = ["healthy", "review", "paused"] as const

/** The documented thresholds. "5% or greater" and "0.1% or greater" place the account under review. */
export const REVIEW_BOUNCE_RATE = 0.05
export const REVIEW_COMPLAINT_RATE = 0.001
/** "10% or greater" and "0.5% or greater": the account might be paused if the review period ends unresolved. */
export const PAUSE_BOUNCE_RATE = 0.1
export const PAUSE_COMPLAINT_RATE = 0.005

/** How the window is cut. More slices follow a changing rate more smoothly; 20 keeps a slice at 5% of the window. */
const SLICES = 20

export interface Enforcement {
  readonly enforcement: boolean
  /** Recipients that must be in the window before its rates are acted on (a handful of sends proves nothing). */
  readonly minVolume: number
  readonly reviewPeriodMs: number
  /** How long a pause lasts before AWS restores sending; 0 means never. */
  readonly pauseMs: number
}

export class Reputation {
  status: Standing = HEALTHY
  /** When the current review period ends. */
  reviewEndsAt = 0
  /** When sending was paused. */
  pausedAt = 0

  private readonly sent = new Float64Array(SLICES)
  private readonly bounces = new Float64Array(SLICES)
  private readonly complaints = new Float64Array(SLICES)
  private cur = 0
  private sentSum = 0
  private bounceSum = 0
  private complaintSum = 0

  private rotate(): void {
    this.cur = (this.cur + 1) % SLICES
    this.sentSum -= this.sent[this.cur]!
    this.bounceSum -= this.bounces[this.cur]!
    this.complaintSum -= this.complaints[this.cur]!
    this.sent[this.cur] = 0
    this.bounces[this.cur] = 0
    this.complaints[this.cur] = 0
  }

  /** Recipients sent that count toward the rates, into a window of about `volume` recipients. */
  addSent(n: number, volume: number): void {
    const size = Math.max(1, Math.ceil(volume / SLICES))
    let left = n
    while (left > 0) {
      if (this.sent[this.cur]! >= size) this.rotate()
      const take = Math.min(size - this.sent[this.cur]!, left)
      this.sent[this.cur]! += take
      this.sentSum += take
      left -= take
    }
  }

  addBounces(n: number): void {
    this.bounces[this.cur]! += n
    this.bounceSum += n
  }

  addComplaints(n: number): void {
    this.complaints[this.cur]! += n
    this.complaintSum += n
  }

  /** Recipients in the window. */
  get volume(): number {
    return this.sentSum
  }

  /** The raw rates over what is in the window (what the Reputation.* metrics show). */
  get bounceRate(): number {
    return this.sentSum > 0 ? this.bounceSum / this.sentSum : 0
  }
  get complaintRate(): number {
    return this.sentSum > 0 ? this.complaintSum / this.sentSum : 0
  }

  /** Forget the window: AWS counts only what happens after a fix. */
  private clear(): void {
    this.sent.fill(0)
    this.bounces.fill(0)
    this.complaints.fill(0)
    this.sentSum = this.bounceSum = this.complaintSum = 0
    this.cur = 0
  }

  /**
   * Bring the status up to date at time `now`. It is evaluated lazily, when mail is sent, when bounces and complaints
   * arrive and when a gauge is read, so there is no timer to leak and nothing to cancel.
   *
   *  - healthy: a rate at or over its review threshold starts a review;
   *  - review: back under both review thresholds is healthy again ("almost healed"); at the end of the period a rate at or
   *    over its pause threshold pauses sending, and anything in between extends the review;
   *  - paused: after `pauseMs` AWS restores sending and the window starts afresh.
   */
  update(now: number, e: Enforcement): Standing {
    if (!e.enforcement) {
      if (this.status !== HEALTHY) this.status = HEALTHY
      return this.status
    }
    if (this.status === PAUSED) {
      if (e.pauseMs > 0 && now >= this.pausedAt + e.pauseMs) {
        this.clear()
        this.status = HEALTHY
      }
      return this.status
    }
    const measured = this.sentSum >= e.minVolume
    const bounce = measured ? this.bounceRate : 0
    const complaint = measured ? this.complaintRate : 0
    const overReview = bounce >= REVIEW_BOUNCE_RATE || complaint >= REVIEW_COMPLAINT_RATE
    if (this.status === HEALTHY) {
      if (overReview) {
        this.status = REVIEW
        this.reviewEndsAt = now + e.reviewPeriodMs
      }
    } else if (!overReview) {
      this.status = HEALTHY
    } else if (now >= this.reviewEndsAt) {
      if (bounce >= PAUSE_BOUNCE_RATE || complaint >= PAUSE_COMPLAINT_RATE) {
        this.status = PAUSED
        this.pausedAt = now
      } else {
        this.reviewEndsAt = now + e.reviewPeriodMs
      }
    }
    return this.status
  }
}
