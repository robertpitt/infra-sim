import { Duration } from "effect"
import type { Link } from "../../Edge.ts"
import type { Message } from "../../Message.ts"
import { THROTTLE_RETRY_FIRST_MS, THROTTLE_RETRY_MAX_MS } from "./limits.ts"
import { type FunctionRuntime, begin } from "./invocation.ts"
import { bump } from "./stats.ts"

/** The links of the two destinations an asynchronous invocation can report to. */
export interface Destinations {
  readonly onFailure: ReadonlyArray<Link>
  readonly onSuccess: ReadonlyArray<Link>
}

/**
 * Asynchronous invocation: the event is accepted at once (202) and Lambda runs and retries it from its own internal
 * queue (`invocation-async-error-handling.html`).
 *
 * - A function error, a timeout included, is retried up to `maxRetries` times, waiting one minute before the first
 *   retry and two before the second.
 * - A throttle (429) or a system error puts the event back on the queue, retried with an interval that doubles from
 *   1 s to at most 5 minutes, for as long as the event is younger than its maximum age.
 * - An event that exhausts its retries, or outlives its maximum age, is discarded to the on-failure destination.
 * - A function with reserved concurrency 0 sends events straight to the on-failure destination without trying
 *   (`invocation-async-retain-records.html`).
 * - An event that succeeds is reported to the on-success destination, if there is one.
 *
 * Retries hold no concurrency while they wait: only attempts do. What an event holds while it waits is the closure
 * below, and it lives no longer than the maximum age (6 hours at most), so the queue cannot grow without bound.
 */
export const runAsync = (fn: FunctionRuntime, destinations: Destinations, message: Message, acceptedAt: number): void => {
  const { fast, stats } = fn
  let throttleRetries = 0
  let functionRetries = 0
  fn.asyncPending++

  /** Send the record to a destination. A destination that refuses it is counted, as CloudWatch's DestinationDeliveryFailures. */
  const report = (links: ReadonlyArray<Link>): void => {
    const link = links[0]
    if (link === undefined) return
    link.send(message, (failure) => {
      if (failure !== undefined) bump(stats.destinationFailures)
    })
  }
  const finish = (): void => void fn.asyncPending--
  const fail = (): void => {
    bump(stats.asyncFailed)
    report(destinations.onFailure)
    finish()
  }
  const succeed = (): void => {
    bump(stats.asyncSucceeded)
    report(destinations.onSuccess)
    finish()
  }

  /** Try again after `delayMs`, unless the event will have outlived its maximum age by then: it is discarded at that moment instead. */
  const retryAfter = (delayMs: number): void => {
    const remaining = Duration.toMillis(fast.settings().async.maxEventAge) - (fast.now() - acceptedAt)
    if (delayMs >= remaining) {
      fast.after(Math.max(0, remaining), fail, undefined)
      return
    }
    bump(stats.asyncRetries)
    fast.after(delayMs, attempt, undefined)
  }

  function attempt(): void {
    begin(fn, message, (outcome) => {
      if (outcome === undefined) return succeed()
      const c = fast.settings()
      if (outcome.kind === "throttled") return retryAfter(Math.min(THROTTLE_RETRY_MAX_MS, THROTTLE_RETRY_FIRST_MS * 2 ** throttleRetries++))
      if (functionRetries >= c.async.maxRetries) return fail()
      retryAfter(Duration.toMillis(functionRetries++ === 0 ? c.async.firstRetryDelay : c.async.secondRetryDelay))
    })
  }

  // Reserved concurrency 0 is how a function is switched off: its events go to the failure destination at once, unretried.
  const standing = fn.concurrency.standing()
  if (standing.reserved && standing.reservation === 0) return fail()
  attempt()
}
