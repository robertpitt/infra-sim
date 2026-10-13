import { Tally } from "../../../kit/Tally.ts"
import type { Counter, Meter, Sampler } from "../../../Telemetry.ts"

/** What a Lambda function counts, for `Lambda.ts` and the invocation mechanisms beside this file. */

/**
 * Everything a function counts. Counters are handles resolved once, so counting on the hot path is two increments.
 * Names are what the frames report; see README.md, "Metrics and state".
 */
export interface Stats {
  /** Invocation attempts that got in (a throttled attempt is not one). */
  readonly invocations: Tally
  /** On-demand environments created (an Init, or a SnapStart restore). */
  readonly coldStarts: Tally
  /** Attempts refused with 429, for any reason. */
  readonly throttles: Tally
  /** Invocations killed at the function timeout. */
  readonly timeouts: Tally
  /** Invocations that ended in a function error, timeouts included (CloudWatch's `Errors`). */
  readonly errors: Tally
  /** Records a successful invocation returned as batch item failures (the invocation isn't an error). */
  readonly itemFailures: Tally
  /** Asynchronous retries scheduled, after a function error or a throttle. */
  readonly asyncRetries: Tally
  /** Asynchronous events that finished without error. */
  readonly asyncSucceeded: Tally
  /** Asynchronous events given up on: retries used up, too old, or the function was reserved at 0. */
  readonly asyncFailed: Tally
  /** Records that could not be delivered to the on-failure or on-success destination. */
  readonly destinationFailures: Tally
  /** Time from the start of a cold start's Init (or Restore) to the environment being ready, in ms. */
  readonly initDuration: Sampler
  /** Time the handler ran, from the end of the cold start to its return or its timeout, in ms. */
  readonly duration: Sampler
  /**
   * Invocations that ended, in success or a function error (timeouts included): what the error rate divides. Counted as
   * they end, as `errors` is, so the rate stays a share while a timeout storm ends more invocations than start.
   */
  readonly completedInvocations: Counter
  /** Invocations that ran on a provisioned environment (CloudWatch's ProvisionedConcurrencyInvocations). */
  readonly provisionedInvocations: Counter
  /**
   * Invocations of a function with provisioned concurrency that ran on standard concurrency because every provisioned
   * environment was busy (ProvisionedConcurrencySpilloverInvocations).
   */
  readonly spilloverInvocations: Counter
  /** Asynchronous events accepted onto the function's internal queue (AsyncEventsReceived). */
  readonly asyncEventsReceived: Counter
  /** Time from an asynchronous event's acceptance to an invocation of it, retries included, in ms (AsyncEventAge). */
  readonly asyncEventAge: Sampler
}

export const makeStats = (meter: Meter): Stats => {
  // A count both reported as a rate in frames and kept as a running total for the probe.
  const metric = (name: string): Tally => new Tally(meter.counter(name))
  return {
    invocations: metric("invocations"),
    coldStarts: metric("coldStarts"),
    throttles: metric("throttles"),
    timeouts: metric("timeouts"),
    errors: metric("errors"),
    itemFailures: metric("itemFailures"),
    asyncRetries: metric("asyncRetries"),
    asyncSucceeded: metric("asyncSucceeded"),
    asyncFailed: metric("asyncFailed"),
    destinationFailures: metric("destinationFailures"),
    initDuration: meter.sampler("initDuration"),
    duration: meter.sampler("duration"),
    completedInvocations: meter.counter("completedInvocations"),
    provisionedInvocations: meter.counter("provisionedInvocations"),
    spilloverInvocations: meter.counter("spilloverInvocations"),
    asyncEventsReceived: meter.counter("asyncEventsReceived"),
    asyncEventAge: meter.sampler("asyncEventAge")
  }
}
