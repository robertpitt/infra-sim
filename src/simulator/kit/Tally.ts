import { type CallFailure, failureCounter } from "../Message.ts"
import type { Counter, Meter } from "../Telemetry.ts"

/**
 * One thing counted two ways: a windowed counter, which the telemetry turns into a per-second rate each frame, and a
 * running total, which a probe reports. Bumping it is two additions. A tally with no counter is a total only.
 */
export class Tally {
  total = 0
  constructor(private readonly counter: Counter | undefined) {}

  add(n: number): void {
    if (this.counter !== undefined) this.counter.n += n
    this.total += n
  }
}

/** Resolve a counter for each name, once: `const m = counters(meter, ["get", "put"])`, then `m.get.n++`. */
export const counters = <const K extends string>(meter: Meter, names: ReadonlyArray<K>): Record<K, Counter> => {
  const out = {} as Record<K, Counter>
  for (const name of names) out[name] = meter.counter(name)
  return out
}

/** A tally per name, each feeding the meter counter of the same name. With no meter they are totals only. */
export const tallies = <const K extends string>(meter: Meter | undefined, names: ReadonlyArray<K>): Record<K, Tally> => {
  const out = {} as Record<K, Tally>
  for (const name of names) out[name] = new Tally(meter?.counter(name))
  return out
}

/** The running totals of a set of tallies: what a probe reports. */
export const totals = <const K extends string>(of: Record<K, Tally>): Record<K, number> => {
  const out = {} as Record<K, number>
  for (const name in of) out[name] = of[name].total
  return out
}

/**
 * The `fail.<Tag>` counter for a failure (`fail.Throttled`, `fail.Timeout`, ...), resolved from `meter` the first time
 * that kind of failure is seen and remembered after that: one map lookup per failure, nothing per success.
 */
export const failureCounters = (meter: Meter): ((failure: CallFailure) => Counter) => {
  const failures = new Map<string, Counter>()
  return (failure) => {
    const name = failureCounter(failure)
    let counter = failures.get(name)
    if (counter === undefined) failures.set(name, (counter = meter.counter(name)))
    return counter
  }
}
