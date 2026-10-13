import { Duration, Schema } from "effect"
import { type Tally, tallies, totals } from "../../kit/Tally.ts"
import type { Fast } from "../../Component.ts"
import { dist, gauge, type Panel } from "../../Dashboard.ts"
import type * as Edge from "../../Edge.ts"
import type { CallFailure, Message } from "../../Message.ts"
import type { Counter, Meter, Sampler } from "../../Telemetry.ts"
import { memoByIdentity } from "../../internal/memo.ts"
import { attemptNow, Delivery, expireNow } from "./internal/delivery.ts"

/**
 * Invoking targets the way EventBridge does, for event bus rules and for Scheduler schedules alike: asynchronously,
 * held to a rate that delays rather than refuses, retried with exponential backoff and jitter until the retry policy
 * runs out (a number of retries, or an age), and then dead-lettered to an SQS queue or dropped.
 *
 * The caller (a publisher, or the schedule) is never waiting on any of this.
 */

/**
 * A rate limit that delays instead of refusing: EventBridge's invocation quotas say that once the limit is reached
 * invocations "still happen but they are delayed" (eb-quota.html; scheduler-quotas.html says the same).
 *
 * A token bucket that may go into debt: each invocation takes a token, and one that finds none waits until the
 * bucket has refilled past it. Invocations go in the order they were taken, at the rate, whatever the backlog.
 * The burst is one second's worth, an assumption (AWS gives only the rate).
 */
export class Pacer {
  private tokens = Number.NaN
  private at = 0

  private refill(now: number, rate: number): void {
    const burst = rate < 1 ? 1 : rate
    if (Number.isNaN(this.tokens)) this.tokens = burst
    else if (now > this.at) this.tokens = Math.min(burst, this.tokens + ((now - this.at) * rate) / 1000)
    else if (this.tokens > burst) this.tokens = burst
    if (now > this.at) this.at = now
  }

  /** How long one more invocation would wait now, in milliseconds. Takes nothing. */
  wait(now: number, rate: number): number {
    this.refill(now, rate)
    return this.tokens >= 1 ? 0 : ((1 - this.tokens) * 1000) / rate
  }

  /** Take one invocation's token. Returns how long that invocation must wait, in milliseconds. */
  take(now: number, rate: number): number {
    const wait = this.wait(now, rate)
    this.tokens -= 1
    return wait
  }
}

/** What happens to one invocation's retries, read from the target's settings when the invocation is created. */
export interface Policy {
  /** `MaximumRetryAttempts`: retries after the first attempt. */
  readonly maxRetries: number
  /** `MaximumEventAgeInSeconds`, in milliseconds, counted from when the invocation was created. */
  readonly maxEventAgeMs: number
  /** Whether a finally failed invocation goes to the dead-letter queue. */
  readonly deadLetter: boolean
  /** The target's own rate limit (an API destination's), in invocations a second; 0 for none. */
  readonly targetRate: number
  /** How long one attempt may take before it is given up as timed out; `Infinity` leaves it to the edge's timeout. */
  readonly attemptTimeoutMs: number
}

/** How the dispatcher spaces retries and bounds what it holds; read from the node's settings. */
export interface Limits {
  readonly backoffFirstMs: number
  readonly backoffMaxMs: number
  /** Invocations a target may have pending (delayed or retrying) before more are dropped as overflow. */
  readonly maxPending: number
}

/** Settings in the shape `Limits` is read from (`retryBackoff` and a pending bound). */
export interface LimitSettings {
  readonly retryBackoff: { readonly initial: Duration.Duration; readonly max: Duration.Duration }
}
/** `Limits` from a node's settings, memoised on the settings object (it only changes when someone edits it). */
export const limitsOf = memoByIdentity((c: LimitSettings, maxPending: number): Limits => ({
  backoffFirstMs: Duration.toMillis(c.retryBackoff.initial),
  backoffMaxMs: Duration.toMillis(c.retryBackoff.max),
  maxPending
}))

/**
 * Outcomes, each a per-second rate (meter counter) and a running total (probe). The READMEs map each to the CloudWatch
 * metric it stands for (`invocations` is `InvocationsCreated`, `delayed` is `ThrottledRules` or `InvocationThrottleCount`...).
 */
export const OUTCOMES = ["invocations", "attempts", "delivered", "retries", "failed", "dropped", "deadLettered", "deadLetterFailed", "expired", "delayed", "overflow"] as const
export type Outcomes = Record<(typeof OUTCOMES)[number], number>

/** The dispatcher's part of a node's state schema: what `Dispatcher.probe` reports, in the order nodes show it. */
export const DeliveryState = {
  pending: Schema.Number,
  invocations: Schema.Number,
  attempts: Schema.Number,
  delivered: Schema.Number,
  retries: Schema.Number,
  failed: Schema.Number,
  dropped: Schema.Number,
  deadLettered: Schema.Number,
  deadLetterFailed: Schema.Number,
  expired: Schema.Number,
  delayed: Schema.Number,
  overflow: Schema.Number,
  /** How long a new invocation would wait for the region's invocation quota, in ms. */
  quotaWait: Schema.Number
}

/** What the dispatcher needs of a target: the edge to call, and what is pending on it. */
export interface Invocable {
  pending: number
  readonly pacer: Pacer
  readonly link: Pick<Edge.Link, "id" | "send">
}

/** A target: the edge to it and what is pending on it. */
export class Target<C extends Edge.Config = Edge.Config> implements Invocable {
  /** Invocations created and not finished: delayed, in flight or waiting to retry. */
  pending = 0
  /** The target's own rate limit, used when its policy has one. */
  readonly pacer = new Pacer()

  constructor(readonly link: Edge.Link<C>) {}
}

/**
 * What a source of traffic records, so that the system's view (what its sources see, alarms on their errors) includes
 * it: `sent`, `ok`, `fail` and `latency`, as a client records them.
 */
interface SourceMetrics {
  readonly sent: Counter
  readonly ok: Counter
  readonly fail: Counter
  readonly latency: Sampler
}

/** One node's invocations: the bus's, or a schedule's. */
export class Dispatcher {
  /** Invocations created and not finished, across every target. */
  pending = 0
  readonly tally: Record<keyof Outcomes, Tally>
  readonly startLatency: Sampler
  private readonly successLatency: Sampler
  /**
   * Attempts the target answered with an error (Scheduler's TargetErrorCount), and of those, the ones it throttled
   * (TargetErrorThrottledCount). Rates only: an attempt that fails is usually retried, so these are not outcomes.
   */
  private readonly targetErrors: Counter
  private readonly targetThrottled: Counter
  private readonly source: SourceMetrics | undefined

  constructor(
    readonly fast: Fast<unknown>,
    meter: Meter,
    /** The dead-letter port's edges: at most one. */
    readonly deadLetters: ReadonlyArray<Edge.Link>,
    /** The regional invocation quota, shared by every node of the service in the placement. */
    private readonly regional: Pacer,
    /** That quota's rate right now (the account quotas are live). */
    private readonly regionalRate: () => number,
    readonly limits: () => Limits,
    /** The node is a source (a schedule): its invocations are also what it has sent, and their outcomes its own. */
    asSource = false
  ) {
    this.tally = tallies(meter, OUTCOMES)
    this.startLatency = meter.sampler("startLatency")
    this.successLatency = meter.sampler("successLatency")
    this.targetErrors = meter.counter("targetErrors")
    this.targetThrottled = meter.counter("targetThrottled")
    this.source = asSource ? { sent: meter.counter("sent"), ok: meter.counter("ok"), fail: meter.counter("fail"), latency: meter.sampler("latency") } : undefined
  }

  private created(): void {
    this.tally.invocations.add(1)
    if (this.source !== undefined) this.source.sent.n++
  }

  /** An invocation the target accepted, `ms` after it was created. */
  succeeded(ms: number): void {
    this.tally.delivered.add(1)
    this.successLatency.add(ms)
    if (this.source !== undefined) {
      this.source.ok.n++
      this.source.latency.add(ms)
    }
  }

  /** An attempt the target answered with an error (it may yet be retried). */
  attemptFailed(failure: CallFailure): void {
    this.targetErrors.n++
    if (failure._tag === "Throttled") this.targetThrottled.n++
  }

  /** An invocation that failed for good. */
  failed(): void {
    this.tally.failed.add(1)
    if (this.source !== undefined) this.source.fail.n++
  }

  get totals(): Outcomes {
    return totals(this.tally)
  }

  /** The outcomes' totals, what is pending and the quota's wait: the node's `DeliveryState`. */
  probe(): Outcomes & { readonly pending: number; readonly quotaWait: number } {
    return { ...this.totals, pending: this.pending, quotaWait: this.quotaWait() }
  }

  /** How long a new invocation would wait for the regional quota now, in milliseconds. */
  quotaWait(): number {
    return this.regional.wait(this.fast.now(), this.regionalRate())
  }

  /**
   * Create one invocation of `target` with `message`. It waits for the rate limits, then `latencyMs` (the service's
   * own processing), then is attempted and retried by `policy`.
   */
  dispatch(target: Invocable, message: Message, policy: Policy, latencyMs: number): void {
    const tally = this.tally
    this.created()
    if (target.pending >= this.limits().maxPending) {
      // AWS would hold it for up to a day; the simulator bounds what it remembers (see `maxPending`).
      tally.overflow.add(1)
      this.failed()
      tally.dropped.add(1)
      return
    }
    target.pending++
    this.pending++
    const fast = this.fast
    const now = fast.now()
    const deadline = now + policy.maxEventAgeMs
    const rate = this.regionalRate()
    let wait = this.regional.wait(now, rate)
    if (policy.targetRate > 0) wait = Math.max(wait, target.pacer.wait(now, policy.targetRate))
    const delivery = new Delivery(this, target, message, policy, now, deadline)
    if (wait > 0) {
      tally.delayed.add(1)
      // Behind the rate limits for longer than it may live: it is never attempted, and ends when its age runs out.
      if (now + wait >= deadline) {
        fast.after(deadline - now, expireNow, delivery)
        return
      }
    }
    this.regional.take(now, rate)
    if (policy.targetRate > 0) target.pacer.take(now, policy.targetRate)
    const start = wait + latencyMs
    if (start > 0) fast.after(start, attemptNow, delivery)
    else delivery.attempt()
  }

  /** A finally failed invocation: to the dead-letter queue if the policy has one, otherwise dropped. */
  deadLetter(message: Message, policy: Policy): void {
    const tally = this.tally
    if (!policy.deadLetter) {
      tally.dropped.add(1)
      return
    }
    const dlq = this.deadLetters[0]
    if (dlq === undefined) {
      tally.deadLetterFailed.add(1)
      return
    }
    dlq.send(message, (failure) => (failure === undefined ? tally.deadLettered : tally.deadLetterFailed).add(1))
  }
}

// ---- Dashboard ---------------------------------------------------------------------------------------------------

/** Dashboard panels over the dispatcher's metrics, shared by the event bus and the Scheduler; each says its own help. */
export const panels = {
  /** The `quotaWait` gauge. */
  quotaWait: (help: string): Panel => ({
    id: "quota-wait",
    title: "Invocation quota wait",
    unit: "ms",
    help,
    lines: [{ label: "wait", metric: gauge("quotaWait"), tone: "warn" }]
  }),
  /** The `pending` gauge. */
  pending: (help: string): Panel => ({
    id: "pending",
    title: "Pending invocations",
    unit: "count",
    help,
    lines: [{ label: "pending", metric: gauge("pending"), tone: "accent" }]
  }),
  /** From an invocation's creation to its first attempt, and to the attempt that succeeded. */
  latency: (title: string, help: string, cloudwatch?: ReadonlyArray<string>): Panel => ({
    id: "latency",
    title,
    unit: "ms",
    ...(cloudwatch === undefined ? {} : { cloudwatch }),
    help,
    lines: [
      { label: "start p50", metric: dist("startLatency", "p50"), tone: "primary" },
      { label: "start p95", metric: dist("startLatency", "p95"), tone: "warn" },
      { label: "success p95", metric: dist("successLatency", "p95"), tone: "bad" }
    ]
  })
}
