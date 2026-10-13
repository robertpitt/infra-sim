/**
 * The transport behind `Edge.ts`: the timer state machines that carry one call (`Flight`) or one health check (`Ping`)
 * across an edge, and the `Wire` built from them. This is the per-call hot path, so it is plain synchronous code over
 * world timers; `Edge.wire` gathers the services and hands them in.
 */
import { SubscriptionRef } from "effect"
import * as Distribution from "../Distribution.ts"
import type { Cancel, CallPolicy, Done, Target, Transport, Wire, WireArgs } from "../Edge.ts"
import type { EdgeEffect, Faults } from "../Fault.ts"
import { type CallFailure, isRetryable, type ItemFailures, type Message, Timeout, Unavailable } from "../Message.ts"
import type { HealthAnswer, Unit } from "../Protocol.ts"
import type { SeededRandom } from "../SeededRandom.ts"
import type { Meter } from "../Telemetry.ts"
import type { TimerHandle, VirtualTime } from "../VirtualTime.ts"
import { failureCounters } from "../kit/Tally.ts"

/**
 * Everything transport and policy do to a call, as a small state machine over world timers.
 *
 * One try is: wait out the latency there, run the target, wait out the latency back; give up if the timeout fires
 * first; if it failed in a way worth retrying, back off and go again. Each of those waits is a timer, so a call costs a
 * few timers and one fiber (the target's), with no `raceFirst`, `Effect.retry` or `Schedule` in sight: those built
 * dozens of effects and several fibers per call, which dominated a busy simulation.
 *
 * By default the callee keeps working after the caller gives up (wasted work, like most real clients), so on a timeout
 * the call is simply abandoned: its late result finds `attempt` has moved on and is ignored.
 */
class Flight {
  /** Which try this is; a callback from an earlier try (an abandoned callee) sees a different number and ignores itself. */
  attempt = 0
  /** Transport as it was when the call began: edits apply to the next call, not mid-flight. */
  transport!: Transport
  fault!: EdgeEffect
  startedAt = 0
  timeout: TimerHandle | undefined
  step: TimerHandle | undefined
  cancelCallee: Cancel | undefined
  /** What the callee's success reported about its batch, carried back across the network with the reply. */
  items: ItemFailures | undefined
  open = false
  settled = false
  cancelBound: Cancel | undefined

  constructor(
    readonly wire: WireRuntime,
    readonly message: Message,
    readonly policy: CallPolicy,
    readonly done: Done | undefined,
    /** The unit of a fleet the call is for, if a connector picked one. */
    readonly unit: Unit | undefined,
    /** One-way latency its route adds to the edge's own (crossing zones). */
    readonly extraMs: number
  ) {}

  /** Begin one try. */
  begin(): void {
    const w = this.wire
    this.attempt++
    this.open = true
    this.items = undefined
    this.startedAt = w.world.nowUnsafe()
    w.calls.n++
    w.inflight++
    const f = (this.fault = w.faults.forEdgeUnsafe(w.id))
    if (this.policy.timeoutMs !== Infinity) this.timeout = w.world.after(this.policy.timeoutMs, onTimeout, this)
    // Black hole or packet loss: nothing arrives, nothing replies, the caller waits out its timeout.
    if (f.blackhole || (f.lossRate > 0 && w.random.nextDoubleUnsafe() < f.lossRate)) return
    this.step = w.world.after(Distribution.latencyMs(this.transport.latency, w.random) + f.extraMs + this.extraMs, onArrive, this)
  }

  /** The request has crossed the network. */
  arrive(): void {
    this.step = undefined
    const w = this.wire
    if (this.fault.outage) return this.end(Unavailable({ node: w.to, reason: "connection refused" }))
    const attempt = this.attempt
    this.cancelCallee = w.target.start(this.message, (failure, items) => this.calleeDone(attempt, failure, items), this.unit)
  }

  calleeDone(attempt: number, failure: CallFailure | undefined, items: ItemFailures | undefined): void {
    if (attempt !== this.attempt || !this.open) return // abandoned: the caller has moved on
    if (failure !== undefined) return this.end(failure)
    this.items = items
    this.step = this.wire.world.after(Distribution.latencyMs(this.transport.latency, this.wire.random) + this.extraMs, onReturn, this)
  }

  /** This try is over, one way or the other. */
  end(failure: CallFailure | undefined): void {
    const w = this.wire
    this.open = false
    this.timeout?.cancel()
    this.step?.cancel()
    this.timeout = this.step = undefined
    w.inflight--
    if (failure === undefined) {
      w.ok.n++
      if (this.items !== undefined) w.partial.n++
      w.latency.add(w.world.nowUnsafe() - this.startedAt)
      return this.finish(undefined)
    }
    w.fail.n++
    w.failure(failure).n++
    const p = this.policy
    if (isRetryable(failure) && this.attempt < p.maxAttempts) {
      // Exponential backoff, capped, optionally with full jitter: the usual advice for retrying against a service
      // that may be struggling. Drawn from this edge's own seeded stream.
      const capped = Math.min(p.backoffMs * p.backoffFactor ** (this.attempt - 1), p.maxBackoffMs)
      w.retries.n++
      this.step = w.world.after(p.jitter ? capped * w.random.nextDoubleUnsafe() : capped, onBackoff, this)
      return
    }
    this.finish(failure)
  }

  finish(failure: CallFailure | undefined): void {
    this.settled = true
    this.done?.(failure, failure === undefined ? this.items : undefined)
  }

  /** The caller was interrupted. */
  cancel(): void {
    if (this.settled) return
    this.settled = true
    if (this.open) {
      this.open = false
      this.wire.inflight--
      if (this.policy.cancelOnTimeout) this.cancelCallee?.()
    }
    this.timeout?.cancel()
    this.step?.cancel()
  }
}

/**
 * A health check across an edge: the same transport as a call (latency both ways, the edge's faults), none of its
 * metrics, and an answer from the far end instead of a handler. See `Wire.ping`.
 */
class Ping {
  timeout: TimerHandle | undefined
  step: TimerHandle | undefined
  settled = false
  constructor(
    readonly wire: WireRuntime,
    readonly answer: () => HealthAnswer,
    readonly done: (healthy: boolean) => void,
    readonly transport: Transport,
    readonly fault: EdgeEffect,
    readonly extraMs: number
  ) {}

  arrive(): void {
    this.step = undefined
    // Refused by the edge or by the node (its own, its region's or its zone's outage), or by the unit: a fast failure.
    if (this.fault.outage || this.wire.target.reachable?.() === false) return this.end(false)
    const a = this.answer()
    if (!a.up) return this.end(false)
    this.step = this.wire.world.after(Distribution.latencyMs(this.transport.latency, this.wire.random) + this.extraMs + a.ms, a.healthy ? onPingHealthy : onPingSick, this)
  }

  end(healthy: boolean): void {
    if (this.settled) return
    this.settled = true
    this.timeout?.cancel()
    this.step?.cancel()
    this.done(healthy)
  }

  cancel(): void {
    if (this.settled) return
    this.settled = true
    this.timeout?.cancel()
    this.step?.cancel()
  }
}
const onPingArrive = (ping: Ping): void => ping.arrive()
const onPingHealthy = (ping: Ping): void => ping.end(true)
const onPingTimeout = (ping: Ping): void => {
  ping.timeout = undefined
  ping.end(false)
}
const onPingSick = (ping: Ping): void => ping.end(false)

const onArrive = (flight: Flight): void => flight.arrive()
const onReturn = (flight: Flight): void => flight.end(undefined)
const onBackoff = (flight: Flight): void => flight.begin()
const onTimeout = (flight: Flight): void => {
  flight.timeout = undefined
  flight.step?.cancel()
  flight.step = undefined
  // Abandon the callee (or cancel it, if so configured) and report the timeout.
  if (flight.policy.cancelOnTimeout) flight.cancelCallee?.()
  flight.end(Timeout({ edge: flight.wire.id, after: flight.policy.timeoutMs }))
}

/** What every call across one edge shares: where it goes, the world it waits in, and the edge's counters. */
export interface WireRuntime {
  readonly id: string
  readonly to: string
  readonly target: Target
  readonly random: SeededRandom
  readonly world: { readonly nowUnsafe: () => number; readonly after: VirtualTime["Service"]["after"] }
  readonly faults: Faults["Service"]
  readonly calls: { n: number }
  readonly ok: { n: number }
  /** Successes that named records of their batch as failed. */
  readonly partial: { n: number }
  readonly fail: { n: number }
  readonly retries: { n: number }
  readonly latency: { add: (value: number) => void }
  readonly failure: (failure: CallFailure) => { n: number }
  inflight: number
}

/** The shared state of one edge's calls, with the edge's counters resolved from `meter` (in the order its frames list them). */
export const runtime = (args: WireArgs, meter: Meter, faults: Faults["Service"], world: VirtualTime["Service"]): WireRuntime => ({
  id: args.id,
  to: args.to,
  target: args.target,
  random: args.random,
  world,
  faults,
  calls: meter.counter("calls"),
  ok: meter.counter("ok"),
  partial: meter.counter("partial"),
  fail: meter.counter("fail"),
  retries: meter.counter("retries"),
  latency: meter.sampler("latency"),
  failure: failureCounters(meter),
  inflight: 0
})

/** The wire over `runtime`: each call a `Flight`, each health check a `Ping`, both reading the edge's settings as they begin. */
export const wire = (runtime: WireRuntime, args: WireArgs): Wire => {
  const { id, to, config, random } = args
  const { faults, world } = runtime
  return {
    id,
    from: args.from,
    to,
    inflight: () => runtime.inflight,
    call: (message, policy, done, unit, extraMs = 0) => {
      const flight = new Flight(runtime, message, policy, done, unit, extraMs)
      flight.transport = SubscriptionRef.getUnsafe(config)
      flight.begin()
      return flight.cancelBound ?? (flight.cancelBound = () => flight.cancel())
    },
    ping: (answer, timeoutMs, done, extraMs = 0) => {
      const transport = SubscriptionRef.getUnsafe(config)
      const fault = faults.forEdgeUnsafe(id)
      const ping = new Ping(runtime, answer, done, transport, fault, extraMs)
      ping.timeout = world.after(timeoutMs, onPingTimeout, ping)
      // Black hole or packet loss: the check never arrives, and times out.
      if (!(fault.blackhole || (fault.lossRate > 0 && random.nextDoubleUnsafe() < fault.lossRate))) {
        ping.step = world.after(Distribution.latencyMs(transport.latency, random) + fault.extraMs + extraMs, onPingArrive, ping)
      }
      return () => ping.cancel()
    }
  }
}
