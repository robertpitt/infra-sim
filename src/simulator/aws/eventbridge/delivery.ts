import { Duration } from "effect"
import { type Tally, tallies, totals } from "../../kit/Tally.ts"
import type { Fast } from "../../Component.ts"
import type * as Edge from "../../Edge.ts"
import { type CallFailure, type Message, Timeout } from "../../Message.ts"
import type { Counter, Meter, Sampler } from "../../Telemetry.ts"
import type { TimerHandle } from "../../VirtualTime.ts"

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
const limitsCache = new WeakMap<object, Limits>()
/** `Limits` from a node's settings, memoised on the settings object (it only changes when someone edits it). */
export const limitsOf = (c: LimitSettings, maxPending: number): Limits => {
  let limits = limitsCache.get(c)
  if (limits === undefined) {
    limits = { backoffFirstMs: Duration.toMillis(c.retryBackoff.initial), backoffMaxMs: Duration.toMillis(c.retryBackoff.max), maxPending }
    limitsCache.set(c, limits)
  }
  return limits
}

/**
 * Outcomes, each a per-second rate (meter counter) and a running total (probe). The READMEs map each to the CloudWatch
 * metric it stands for (`invocations` is `InvocationsCreated`, `delayed` is `ThrottledRules` or `InvocationThrottleCount`...).
 */
export const OUTCOMES = ["invocations", "attempts", "delivered", "retries", "failed", "dropped", "deadLettered", "deadLetterFailed", "expired", "delayed", "overflow"] as const
export type Outcomes = Record<(typeof OUTCOMES)[number], number>

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

  /** An invocation that failed for good. */
  failed(): void {
    this.tally.failed.add(1)
    if (this.source !== undefined) this.source.fail.n++
  }

  get totals(): Outcomes {
    return totals(this.tally)
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

/** One invocation, from its first attempt to its last answer. */
class Delivery {
  /** Which attempt is running; an answer for an earlier one (abandoned on a timeout) is ignored. */
  private attempts = 0
  private retries = 0
  private open = false
  private timer: TimerHandle | undefined
  private cancel: Edge.Cancel | undefined

  constructor(
    private readonly d: Dispatcher,
    private readonly target: Invocable,
    private readonly message: Message,
    private readonly policy: Policy,
    private readonly createdAt: number,
    private readonly deadline: number
  ) {}

  attempt(): void {
    const d = this.d
    const n = ++this.attempts
    this.open = true
    d.tally.attempts.add(1)
    if (n === 1) d.startLatency.add(d.fast.now() - this.createdAt)
    if (this.policy.attemptTimeoutMs !== Infinity) this.timer = d.fast.after(this.policy.attemptTimeoutMs, timeOut, this)
    this.cancel = this.target.link.send(this.message, (failure) => this.answer(n, failure))
  }

  /** The attempt took longer than the target is given (an API destination's 5 s): abandon it and treat it as a timeout. */
  timeOut(): void {
    const cancel = this.cancel
    this.timer = undefined
    this.answer(this.attempts, Timeout({ edge: this.target.link.id, after: this.policy.attemptTimeoutMs }))
    cancel?.()
  }

  private answer(n: number, failure: CallFailure | undefined): void {
    if (n !== this.attempts || !this.open) return
    this.open = false
    this.cancel = undefined
    this.timer?.cancel()
    this.timer = undefined
    const d = this.d
    const now = d.fast.now()
    if (failure === undefined) {
      d.succeeded(now - this.createdAt)
      return this.finish()
    }
    // A client error (a missing resource, no permission, a 4xx from an API destination) is not retried.
    if (failure._tag === "Rejected" || this.retries >= this.policy.maxRetries) return this.giveUp(false)
    const limits = d.limits()
    const ceiling = Math.min(limits.backoffMaxMs, limits.backoffFirstMs * 2 ** this.retries)
    const backoff = d.fast.random.nextDoubleUnsafe() * ceiling
    if (now + backoff >= this.deadline) {
      // The next try would come after the event's maximum age: it waits out its age, then is given up.
      d.fast.after(this.deadline - now, expireNow, this)
      return
    }
    this.retries++
    d.tally.retries.add(1)
    d.fast.after(backoff, retryNow, this)
  }

  /**
   * A retry, once its backoff is over. It queues for the target's own rate limit as a first attempt does: an API
   * destination's `InvocationRateLimitPerSecond` is what reaches the endpoint, retries included. (Retries don't count
   * against the regional invocation quota, whose metric is `InvocationsCreated`.)
   */
  retry(): void {
    const rate = this.policy.targetRate
    if (rate <= 0) return this.attempt()
    const d = this.d
    const now = d.fast.now()
    const wait = this.target.pacer.wait(now, rate)
    if (wait <= 0) {
      this.target.pacer.take(now, rate)
      return this.attempt()
    }
    d.tally.delayed.add(1)
    if (now + wait >= this.deadline) {
      d.fast.after(this.deadline - now, expireNow, this)
      return
    }
    this.target.pacer.take(now, rate)
    d.fast.after(wait, attemptNow, this)
  }

  expire(): void {
    this.giveUp(true)
  }

  private giveUp(aged: boolean): void {
    const d = this.d
    d.failed()
    if (aged) d.tally.expired.add(1)
    d.deadLetter(this.message, this.policy)
    this.finish()
  }

  private finish(): void {
    this.target.pending--
    this.d.pending--
  }
}

const attemptNow = (delivery: Delivery): void => delivery.attempt()
const retryNow = (delivery: Delivery): void => delivery.retry()
const expireNow = (delivery: Delivery): void => delivery.expire()
const timeOut = (delivery: Delivery): void => delivery.timeOut()
