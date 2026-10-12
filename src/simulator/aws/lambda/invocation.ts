import { Duration } from "effect"
import type { Fast } from "../../Component.ts"
import * as Distribution from "../../Distribution.ts"
import type { Link } from "../../Edge.ts"
import * as Flow from "../../Flow.ts"
import type { Limiter } from "../../Limiter.ts"
import { type CallFailure, Failed, type ItemFailures, itemFailures, type Message, Throttled } from "../../Message.ts"
import type { TimerHandle } from "../../VirtualTime.ts"
import type { Concurrency, Region } from "./concurrency.ts"
import type { Settings } from "./config.ts"
import type { Environments } from "./environments.ts"
import { INIT_LIMIT_MS, ONE_VCPU_MB, REQUESTS_PER_CONCURRENCY, SCALE_UP } from "./limits.ts"
import type { Provisioned } from "./provisioned.ts"
import { bump, type Stats } from "./stats.ts"

/**
 * What went wrong in one invocation attempt, kept apart because the two kinds are treated differently: a throttle
 * means the function never ran (a synchronous caller gets a 429, an asynchronous event is retried until it is too
 * old), a function error means it ran and failed (a synchronous caller gets the error, an asynchronous event is
 * retried a limited number of times).
 */
export type Attempt = { readonly kind: "throttled"; readonly failure: CallFailure } | { readonly kind: "function"; readonly failure: CallFailure }
/** How an attempt ended: `undefined` for success, with `items` when the function returned batch item failures. */
export type Outcome = (attempt: Attempt | undefined, items?: ItemFailures) => void

/** Everything one function's invocations share. */
export interface FunctionRuntime {
  readonly id: string
  readonly fast: Fast<Settings>
  readonly limiter: Limiter
  readonly region: Region
  readonly concurrency: Concurrency
  readonly environments: Environments
  readonly provisioned: Provisioned
  readonly stats: Stats
  /** The function's downstream links (its `out` port). */
  readonly out: ReadonlyArray<Link>
  /** Executions of this function running right now, cold starting ones included. */
  inUse: number
  /** Asynchronous events accepted and not yet finished, waiting for a retry included. */
  asyncPending: number
}

/** Why a function failed, in words a caller can read. */
export const describe = (failure: CallFailure): string => ("reason" in failure ? `${failure._tag}: ${failure.reason}` : failure._tag)

/** What the function sends on is its own call, not the batch it was handed: a plain message again. */
const unbatched = (m: Message): Message => {
  if (m.batched === undefined) return m
  const { batched: _, ...plain } = m
  return plain
}

/**
 * After its own work, the handler calls whatever is wired downstream. A batch is handled a record at a time, ten at
 * once, unless the function is set to make one call for the whole batch.
 */
const downstream = (fn: FunctionRuntime, message: Message, c: Settings, done: Flow.Done): Flow.Cancel => {
  const { out, fast } = fn
  const m = unbatched(message)
  if (m.count > 1 && c.batchCalls === "each") {
    const each = recordOf(m, Math.max(1, Math.round(m.bytes / m.count)))
    return Flow.forEach(m.count, 10, (_, d) => Flow.fanOut(c.fanOut, out, fast.random, keyed(each, m, fast), d), done)
  }
  return Flow.fanOut(c.fanOut, out, fast.random, m, done)
}

/** One record of a batch, as a call of its own. */
const recordOf = (m: Message, bytes: number): Message => {
  const { spread: _, ...record } = m
  return { ...record, count: 1, bytes }
}

/**
 * A record's own key: the batch's shared key for its share of the batch (`1 - spread`), a key of its own for the rest,
 * so a function writing a record at a time spreads over a table's partitions as its records do. A batch whose records
 * all share the key needs no copy.
 */
const keyed = (record: Message, batch: Message, fast: Pick<Fast<unknown>, "random">): Message => {
  const spread = batch.spread ?? 1
  if (spread <= 0 || fast.random.nextDoubleUnsafe() >= spread) return record
  return { ...record, key: fast.random.nextDoubleUnsafe() }
}

/**
 * The same for a handler that reports batch item failures: the records in `failed` already failed in the handler, and a
 * record whose downstream call fails joins them instead of failing the invocation. `done` always hears success, with the
 * failed records if there are any.
 */
const downstreamReporting = (fn: FunctionRuntime, message: Message, c: Settings, failed: ReadonlyArray<number>, done: Flow.Done): Flow.Cancel => {
  const { out, fast } = fn
  const finish = (all: ReadonlyArray<number>): void => done(undefined, all.length === 0 ? undefined : itemFailures(all))
  const rest: Array<number> = []
  for (let i = 0, f = 0; i < message.count; i++) {
    if (failed[f] === i) f++
    else rest.push(i)
  }
  if (rest.length === 0 || c.fanOut === "none") {
    finish(failed)
    return Flow.noCancel
  }
  const plain = unbatched(message)
  const each = Math.max(1, Math.round(plain.bytes / plain.count))
  if (c.batchCalls === "each") {
    const record = recordOf(plain, each)
    return Flow.forEachSettled(rest, 10, (_, d) => Flow.fanOut(c.fanOut, out, fast.random, keyed(record, plain, fast), d), (bad) =>
      finish(bad.length === 0 ? failed : [...failed, ...bad].sort((a, b) => a - b)))
  }
  // One call for what is left of the batch: if it fails, every record in it failed.
  return Flow.fanOut(c.fanOut, out, fast.random, { ...plain, count: rest.length, bytes: each * rest.length }, (failure) =>
    finish(failure === undefined ? failed : Array.from({ length: message.count }, (_, i) => i)))
}

/**
 * One invocation attempt: admit it against the limits, find an environment (provisioned, warm or new), run the handler
 * under the timeout, call downstream, and give everything back. Returns the function that abandons it.
 *
 * Whatever an attempt took, it gives back exactly once, whichever way it ends: it returns normally, times out, or the
 * caller cancels it. `finished` guards that: every ending path sets it first, every timer is cancelled when the thing
 * it guards is done, and `settle` is the only place counters go back down.
 */
export const begin = (fn: FunctionRuntime, message: Message, done: Outcome): Flow.Cancel => {
  const { fast, stats, region, environments, provisioned } = fn
  const c = fast.settings()
  const cap = fn.concurrency.standing()
  const now = fast.now()
  const ttl = Duration.toMillis(c.coldStart.idleTtl)
  const lifetime = Duration.toMillis(c.coldStart.maxLifetime)

  const throttle = (reason: string): Flow.Cancel => {
    bump(stats.throttles)
    done({ kind: "throttled", failure: Throttled({ node: fn.id, reason }) })
    return Flow.noCancel
  }

  // --- Admission: everything that can say no is decided before anything is taken ------------------------------------
  // Each unit of concurrency allows 10 synchronous requests a second; asynchronous events are limited only by concurrency.
  if (c.rpsLimit && message.invocation === "sync") {
    const rate = REQUESTS_PER_CONCURRENCY * cap.limit
    if (!fn.limiter.takeUnsafe(`${fn.id}/rate`, { rate, burst: rate })) return throttle("429 TooManyRequestsException: request rate over 10 per second per unit of concurrency")
  }
  const usesProvisioned = provisioned.free > 0
  if (cap.reserved) {
    if (fn.inUse >= cap.reservation) return throttle("429 TooManyRequestsException: ReservedFunctionConcurrentInvocationLimitExceeded")
  } else if (!usesProvisioned && region.unreservedInUse >= cap.pool) {
    return throttle("429 TooManyRequestsException: ConcurrentInvocationLimitExceeded")
  }
  // An on-demand environment: reuse an idle one, or create one if the function's scale-up allowance has a token.
  let born = -1
  if (!usesProvisioned) {
    born = environments.take(now, ttl, lifetime)
    if (born < 0 && !fn.limiter.takeUnsafe(`${fn.id}/scale`, SCALE_UP)) return throttle("429 TooManyRequestsException: concurrency scaling rate exceeded")
  }

  // --- Admitted: take what the attempt holds ------------------------------------------------------------------------
  bump(stats.invocations)
  fn.inUse++
  if (usesProvisioned) {
    provisioned.take()
    stats.provisionedInvocations.n++
  } else {
    // A function with provisioned environments that are all busy spills over onto standard concurrency.
    if (provisioned.allocated > 0) stats.spilloverInvocations.n++
    if (!cap.reserved) region.unreservedInUse++
  }

  let finished = false
  let haveEnvironment = born >= 0
  let timeout: TimerHandle | undefined
  let step: TimerHandle | undefined
  let cancelWork: Flow.Cancel = Flow.noCancel
  let handler = c
  let startedAt = now

  /** Give back what the attempt held. `reset` discards the environment (a timeout resets it) instead of keeping it warm. */
  const settle = (reset: boolean): void => {
    fn.inUse--
    if (usesProvisioned) {
      // A reset provisioned environment is re-initialised in the background, so its slot comes back after an Init.
      if (reset) fast.after(Distribution.latencyMs(handler.coldStart.init, fast.random), () => provisioned.give(), undefined)
      else provisioned.give()
      return
    }
    if (!cap.reserved) region.unreservedInUse--
    if (!haveEnvironment) return
    if (reset) environments.discard()
    else environments.release(fast.now(), born, lifetime)
  }
  const complete = (failure: CallFailure | undefined, items?: ItemFailures): void => {
    if (finished) return
    finished = true
    timeout?.cancel()
    // The handler ran if the attempt had an environment: a provisioned one, or an on-demand one (a SnapStart restore that
    // overran never got one).
    if (usesProvisioned || haveEnvironment) stats.duration.add(fast.now() - startedAt)
    stats.completedInvocations.n++
    settle(false)
    if (failure === undefined) {
      if (items !== undefined) bump(stats.itemFailures, items.failed.length)
      return done(undefined, items)
    }
    bump(stats.errors)
    done({ kind: "function", failure })
  }
  /** The function ran out of time: its work is abandoned and its environment thrown away, so the next call is cold. */
  const timedOut = (): void => {
    if (finished) return
    finished = true
    step?.cancel()
    cancelWork()
    bump(stats.timeouts)
    bump(stats.errors)
    stats.completedInvocations.n++
    stats.duration.add(fast.now() - startedAt)
    settle(true)
    done({ kind: "function", failure: Failed({ node: fn.id, reason: "task timed out" }) })
  }

  const afterWork = (): void => {
    if (finished) return
    const p = handler.errorRate
    if (handler.batch.errors === "report" && message.batched === true) {
      // The handler catches each record's error and returns the ones that failed: the invocation itself succeeds.
      const failed: Array<number> = []
      if (p > 0) for (let i = 0; i < message.count; i++) if (fast.random.nextDoubleUnsafe() < p) failed.push(i)
      cancelWork = downstreamReporting(fn, message, fast.settings(), failed, complete)
      return
    }
    if (p > 0) {
      // Rolled per record when asked to: any failing record fails the whole batch.
      const records = handler.batch.errors === "record" ? Math.max(1, message.count) : 1
      const chance = records === 1 ? p : 1 - (1 - p) ** records
      if (fast.random.nextDoubleUnsafe() < chance) return complete(Failed({ node: fn.id, reason: "unhandled error" }))
    }
    cancelWork = downstream(fn, message, fast.settings(), complete)
  }

  /**
   * The invoke phase. The timeout covers the handler, not the cold start before it; `repeatedInit` is the exception:
   * an Init that overran its 10 s limit is re-run here, inside the invocation, so it spends the function timeout too.
   */
  const run = (repeatedInit: number): void => {
    const t = (handler = fast.settings())
    startedAt = fast.now()
    timeout = fast.after(Duration.toMillis(t.timeout), timedOut, undefined)
    const cpuScale = 1 + t.cpuBound * (Math.max(1, ONE_VCPU_MB / t.memory) - 1)
    const records = t.batch.duration === "record" ? Math.max(1, message.count) : 1
    step = fast.after(repeatedInit + Distribution.latencyMs(t.duration, fast.random) * cpuScale * records, afterWork, undefined)
  }

  /** A cold start has produced an environment, which the attempt now holds. */
  const ready = (initMs: number, repeatedInit: number): void => {
    if (finished) return
    environments.created()
    born = fast.now()
    haveEnvironment = true
    stats.initDuration.add(initMs)
    run(repeatedInit)
  }

  if (usesProvisioned || born >= 0) run(0)
  else {
    bump(stats.coldStarts)
    // SnapStart resumes from a snapshot instead of running Init, but AWS doesn't support it with provisioned concurrency.
    if (c.coldStart.snapStart && c.provisioned === 0) {
      const restore = Distribution.latencyMs(c.coldStart.restore, fast.random)
      step = fast.after(Math.min(restore, INIT_LIMIT_MS), () => {
        if (finished) return
        // The Restore phase is limited to 10 s too; past it the invocation fails (SnapStartTimeoutException).
        if (restore > INIT_LIMIT_MS) return complete(Failed({ node: fn.id, reason: "SnapStartTimeoutException: restore took over 10 s" }))
        ready(restore, 0)
      }, undefined)
    } else {
      const init = Distribution.latencyMs(c.coldStart.init, fast.random)
      // Init is limited to 10 s. Past it Lambda re-runs it in the first invocation, under the function timeout.
      step = fast.after(Math.min(init, INIT_LIMIT_MS), () => ready(init, init > INIT_LIMIT_MS ? init : 0), undefined)
    }
  }

  // The caller gave up on this attempt: stop the work and put the environment back.
  return () => {
    if (finished) return
    finished = true
    timeout?.cancel()
    step?.cancel()
    cancelWork()
    settle(false)
  }
}
