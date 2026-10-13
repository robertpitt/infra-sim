import type * as Edge from "../../../Edge.ts"
import { type CallFailure, type Message, Timeout } from "../../../Message.ts"
import type { TimerHandle } from "../../../VirtualTime.ts"
import type { Dispatcher, Invocable, Policy } from "../Delivery.ts"

/**
 * One invocation's life, for `Delivery.ts`'s `Dispatcher`: its attempts, the attempt timeout, retries with exponential
 * backoff and full jitter, waits for the target's own rate, and giving up once the retry policy runs out. A plain state
 * machine over world timers: the bus and the Scheduler make one per invocation.
 */

/** One invocation, from its first attempt to its last answer. */
export class Delivery {
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
    d.attemptFailed(failure)
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

// Timer callbacks: module-level functions taking the delivery as their argument, so arming a timer allocates nothing.
/** Make the delivery's next attempt. */
export const attemptNow = (delivery: Delivery): void => delivery.attempt()
const retryNow = (delivery: Delivery): void => delivery.retry()
/** Give the delivery up: its maximum event age has run out. */
export const expireNow = (delivery: Delivery): void => delivery.expire()
const timeOut = (delivery: Delivery): void => delivery.timeOut()
