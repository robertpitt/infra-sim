import type { Counter, Meter, Sampler } from "../../Telemetry.ts"

/** A count that is both reported as a rate in frames (`rate.n` is reset each window) and kept as a running total for the probe. */
export interface Metric {
  total: number
  readonly rate: Counter
}

export const bump = (m: Metric, n = 1): void => {
  m.total += n
  m.rate.n += n
}

/**
 * Everything a function counts. Counters are handles resolved once, so counting on the hot path is two increments.
 * Names are what the frames report; see README.md, "Metrics and state".
 */
export interface Stats {
  /** Invocation attempts that got in (a throttled attempt is not one). */
  readonly invocations: Metric
  /** On-demand environments created (an Init, or a SnapStart restore). */
  readonly coldStarts: Metric
  /** Attempts refused with 429, for any reason. */
  readonly throttles: Metric
  /** Invocations killed at the function timeout. */
  readonly timeouts: Metric
  /** Invocations that ended in a function error, timeouts included (CloudWatch's `Errors`). */
  readonly errors: Metric
  /** Records a successful invocation returned as batch item failures (the invocation isn't an error). */
  readonly itemFailures: Metric
  /** Asynchronous retries scheduled, after a function error or a throttle. */
  readonly asyncRetries: Metric
  /** Asynchronous events that finished without error. */
  readonly asyncSucceeded: Metric
  /** Asynchronous events given up on: retries used up, too old, or the function was reserved at 0. */
  readonly asyncFailed: Metric
  /** Records that could not be delivered to the on-failure or on-success destination. */
  readonly destinationFailures: Metric
  /** Time from the start of a cold start's Init (or Restore) to the environment being ready, in ms. */
  readonly initDuration: Sampler
  /** Time the handler ran, from the end of the cold start to its return or its timeout, in ms. */
  readonly duration: Sampler
}

export const makeStats = (meter: Meter): Stats => {
  const metric = (name: string): Metric => ({ total: 0, rate: meter.counter(name) })
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
    duration: meter.sampler("duration")
  }
}
