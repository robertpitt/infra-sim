import { type Context, Duration, Effect, Schema, SubscriptionRef } from "effect"
import * as Distribution from "./Distribution.ts"
import { type EdgeEffect, Faults } from "./Fault.ts"
import { type Call, type CallFailure, failureCounter, isRetryable, type Message, Timeout, Unavailable } from "./Message.ts"
import type { SeededRandom } from "./SeededRandom.ts"
import * as Setting from "./Setting.ts"
import { Telemetry } from "./Telemetry.ts"
import { type TimerHandle, VirtualTime } from "./VirtualTime.ts"

/**
 * Edges are the policy layer. Every edge, whatever its endpoints, gets the same knobs: network latency,
 * timeout, retry with backoff, a routing weight. Components stay free of that plumbing.
 */
export const Config = Schema.Struct({
  weight: Setting.number({
    default: 1,
    min: 0,
    max: 1000,
    step: 0.1,
    help: "Share of traffic this edge gets when the source routes by weight."
  }),
  latency: Setting.latency({
    mean: 1,
    cv: 0.3,
    label: "Network latency",
    help: "One-way; paid on the way there and back. Unless set, it is estimated from where the two nodes run."
  }),
  request: Setting.group(
    {
      operation: Setting.choice(["read", "write"], {
        default: "write",
        help: "What this call does to the receiver. Stores and object stores price and limit reads and writes differently."
      }),
      payload: Setting.int({
        default: 0,
        min: 0,
        max: 1_000_000,
        unit: "KB",
        label: "Payload size",
        help: "Size of what this call carries. 0 keeps the size the sender gave it."
      })
    },
    { label: "Request" }
  ),
  timeout: Setting.duration({
    default: "30 seconds",
    min: "1 millis",
    max: "10 minutes",
    label: "Timeout",
    help: "How long the caller waits before giving up."
  }),
  cancelOnTimeout: Setting.bool({
    default: false,
    label: "Cancel on timeout",
    help: "Off: the callee keeps working after the caller gives up (wasted work, like most real clients). On: the work is cancelled."
  }),
  retry: Setting.group(
    {
      maxAttempts: Setting.int({ default: 1, min: 1, max: 100, label: "Max attempts", help: "1 means no retries." }),
      backoff: Setting.duration({ default: "100 millis", min: 0, max: "1 minute", label: "Initial backoff" }),
      backoffFactor: Setting.number({ default: 2, min: 1, max: 10, step: 0.5, label: "Backoff factor" }),
      maxBackoff: Setting.duration({ default: "10 seconds", min: 0, max: "10 minutes", label: "Max backoff" }),
      jitter: Setting.bool({ default: true, help: "Randomise each wait between zero and its full length." })
    },
    { label: "Retries" }
  )
})
export type Config = typeof Config.Type

/** One wired edge, as seen from the component it leaves. */
export interface Link<C extends Config = Config> {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly config: SubscriptionRef.SubscriptionRef<C>
  /** Routing weight right now. */
  readonly weight: Effect.Effect<number>
  /** Routing weight right now, without an effect. */
  readonly weightUnsafe: () => number
  /** Call the target through this edge's latency, faults, timeout and retry policy. */
  readonly invoke: (message: Message) => Call
  /**
   * The same call as a plain callback: `done` hears the outcome once (`undefined` for success). No fiber, no effect:
   * this is how a source of traffic, or anything that fires and forgets, sends at volume. The returned function
   * abandons the call (the callee keeps going unless the edge is set to cancel on timeout).
   */
  readonly send: (message: Message, done?: (failure: CallFailure | undefined) => void) => () => void
}

/**
 * What an edge calls: the node at its far end, already wrapped with that node's faults and metrics.
 *
 * `start` runs the node's handler for one message and reports the outcome to `done`, exactly once, from inside the
 * world. It hands back a function that cancels the work. It is a callback rather than an `Effect` so the edge can
 * run a whole call (latency, timeout, retries) without building an effect for any of it.
 */
export interface Target {
  readonly start: (message: Message, done: (failure: CallFailure | undefined) => void) => () => void
}

export interface Args<C extends Config> {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly config: SubscriptionRef.SubscriptionRef<C>
  readonly target: Target
  /** This edge's own random stream. */
  readonly random: SeededRandom
}

// ---------------------------------------------------------------------------------------------------------
// One call through an edge
// ---------------------------------------------------------------------------------------------------------

/**
 * Everything an edge does to a call, as a small state machine over world timers.
 *
 * One call is: wait out the latency there, run the target, wait out the latency back; give up if the timeout
 * fires first; if it failed in a way worth retrying, back off and go again. Each of those waits is a timer, so
 * a call costs a few timers and one fiber (the target's), with no `raceFirst`, `Effect.retry` or `Schedule` in
 * sight: those built dozens of effects and several fibers per call, which dominated a busy simulation.
 *
 * By default the callee keeps working after the caller gives up (wasted work, like most real clients), so on a
 * timeout the call is simply abandoned: its late result finds `attempt` has moved on and is ignored.
 */
class Flight<C extends Config> {
  /** Which try this is; a callback from an earlier try (an abandoned callee) sees a different number and ignores itself. */
  attempt = 0
  /** Config as it was when the call began: edits apply to the next call, not mid-flight. */
  config!: C
  retry!: Config["retry"]
  fault!: EdgeEffect
  startedAt = 0
  timeout: TimerHandle | undefined
  step: TimerHandle | undefined
  cancelCallee: (() => void) | undefined
  open = false
  settled = false
  cancelBound: (() => void) | undefined

  constructor(
    readonly edge: EdgeRuntime<C>,
    readonly message: Message,
    readonly done: ((failure: CallFailure | undefined) => void) | undefined
  ) {}

  /** Begin one try. */
  begin(): void {
    const e = this.edge
    this.attempt++
    this.open = true
    this.startedAt = e.world.nowUnsafe()
    e.calls.n++
    e.inflight++
    const f = (this.fault = e.faults.forEdgeUnsafe(e.id))
    this.timeout = e.world.after(Duration.toMillis(this.config.timeout), onTimeout, this)
    // Black hole or packet loss: nothing arrives, nothing replies, the caller waits out its timeout.
    if (f.blackhole || (f.lossRate > 0 && e.random.nextDoubleUnsafe() < f.lossRate)) return
    this.step = e.world.after(Distribution.latencyMs(this.config.latency, e.random) + f.extraMs, onArrive, this)
  }

  /** The request has crossed the network. */
  arrive(): void {
    this.step = undefined
    const e = this.edge
    if (this.fault.outage) return this.end(Unavailable({ node: e.to, reason: "connection refused" }))
    const c = this.config
    // What the call looks like is a property of the connection: what it does, and how much it carries.
    const m = this.message
    const message = m.operation === c.request.operation && c.request.payload === 0
      ? m
      : { ...m, operation: c.request.operation, ...(c.request.payload > 0 ? { bytes: c.request.payload * 1024 } : {}) }
    const attempt = this.attempt
    this.cancelCallee = e.target.start(message, (failure) => this.calleeDone(attempt, failure))
  }

  calleeDone(attempt: number, failure: CallFailure | undefined): void {
    if (attempt !== this.attempt || !this.open) return // abandoned: the caller has moved on
    if (failure !== undefined) return this.end(failure)
    this.step = this.edge.world.after(Distribution.latencyMs(this.config.latency, this.edge.random), onReturn, this)
  }

  /** This try is over, one way or the other. */
  end(failure: CallFailure | undefined): void {
    const e = this.edge
    this.open = false
    this.timeout?.cancel()
    this.step?.cancel()
    this.timeout = this.step = undefined
    e.inflight--
    if (failure === undefined) {
      e.ok.n++
      e.latency.add(e.world.nowUnsafe() - this.startedAt)
      return this.finish(undefined)
    }
    e.fail.n++
    e.failure(failure).n++
    const { retry } = this
    if (isRetryable(failure) && this.attempt < retry.maxAttempts) {
      // Exponential backoff, capped, optionally with full jitter: the usual advice for retrying against a service
      // that may be struggling. Drawn from this edge's own seeded stream.
      const capped = Math.min(Duration.toMillis(retry.backoff) * retry.backoffFactor ** (this.attempt - 1), Duration.toMillis(retry.maxBackoff))
      e.retries.n++
      this.step = e.world.after(retry.jitter ? capped * e.random.nextDoubleUnsafe() : capped, onBackoff, this)
      return
    }
    this.finish(failure)
  }

  finish(failure: CallFailure | undefined): void {
    this.settled = true
    this.done?.(failure)
  }

  /** The caller was interrupted. */
  cancel(): void {
    if (this.settled) return
    this.settled = true
    if (this.open) {
      this.open = false
      this.edge.inflight--
      if (this.config.cancelOnTimeout) this.cancelCallee?.()
    }
    this.timeout?.cancel()
    this.step?.cancel()
  }
}

const onArrive = <C extends Config>(flight: Flight<C>): void => flight.arrive()
const onReturn = <C extends Config>(flight: Flight<C>): void => flight.end(undefined)
const onBackoff = <C extends Config>(flight: Flight<C>): void => flight.begin()
const onTimeout = <C extends Config>(flight: Flight<C>): void => {
  flight.timeout = undefined
  flight.step?.cancel()
  flight.step = undefined
  // Abandon the callee (or cancel it, if so configured) and report the timeout.
  if (flight.config.cancelOnTimeout) flight.cancelCallee?.()
  flight.end(Timeout({ edge: flight.edge.id, after: Duration.toMillis(flight.config.timeout) }))
}

interface EdgeRuntime<C extends Config> {
  readonly id: string
  readonly to: string
  readonly target: Target
  readonly random: SeededRandom
  readonly world: { readonly nowUnsafe: () => number; readonly after: VirtualTime["Service"]["after"] }
  readonly faults: Context.Service.Shape<typeof Faults>
  readonly calls: { n: number }
  readonly ok: { n: number }
  readonly fail: { n: number }
  readonly retries: { n: number }
  readonly latency: { add: (value: number) => void }
  readonly failure: (failure: CallFailure) => { n: number }
  inflight: number
  readonly config: SubscriptionRef.SubscriptionRef<C>
}

export const make = <C extends Config>(args: Args<C>): Effect.Effect<Link<C>, never, Telemetry | Faults | VirtualTime> =>
  Effect.gen(function*() {
    const { id, to, config, target, random } = args
    const telemetry = yield* Telemetry
    const faults = yield* Faults
    const world = yield* VirtualTime
    const meter = telemetry.edge(id)
    const failures = new Map<string, { n: number }>()
    const runtime: EdgeRuntime<C> = {
      id,
      to,
      target,
      random,
      world,
      faults,
      config,
      calls: meter.counter("calls"),
      ok: meter.counter("ok"),
      fail: meter.counter("fail"),
      retries: meter.counter("retries"),
      latency: meter.sampler("latency"),
      failure: (failure) => {
        const name = failureCounter(failure)
        let counter = failures.get(name)
        if (counter === undefined) failures.set(name, (counter = meter.counter(name)))
        return counter
      },
      inflight: 0
    }
    yield* meter.gauge("inflight", Effect.sync(() => runtime.inflight))

    const send = (message: Message, done?: (failure: CallFailure | undefined) => void): (() => void) => {
      const flight = new Flight(runtime, message, done)
      flight.config = SubscriptionRef.getUnsafe(config)
      flight.retry = flight.config.retry
      flight.begin()
      return flight.cancelBound ?? (flight.cancelBound = () => flight.cancel())
    }

    const invoke = (message: Message): Call =>
      Effect.callback<void, CallFailure>((resume) => {
        const cancel = send(message, (failure) => resume(failure === undefined ? Effect.void : Effect.fail(failure)))
        return Effect.sync(cancel)
      })

    return {
      id,
      from: args.from,
      to,
      config,
      weight: Effect.map(SubscriptionRef.get(config), (c) => c.weight),
      weightUnsafe: () => SubscriptionRef.getUnsafe(config).weight,
      invoke,
      send
    }
  })

/** Pick one link by its current weight, drawing from `random`. No effect: for the call path. */
export const pickUnsafe = <C extends Config>(links: ReadonlyArray<Link<C>>, random: { readonly nextDoubleUnsafe: () => number }): Link<C> | undefined => {
  if (links.length === 1) return links[0]
  let total = 0
  for (const l of links) total += Math.max(0, l.weightUnsafe())
  if (total <= 0) return undefined
  let r = random.nextDoubleUnsafe() * total
  for (const l of links) {
    r -= Math.max(0, l.weightUnsafe())
    if (r < 0) return l
  }
  return links[links.length - 1]
}

/** Pick one link by its current weight. */
export const pick = <C extends Config>(links: ReadonlyArray<Link<C>>): Effect.Effect<Link<C> | undefined> =>
  Effect.gen(function*() {
    if (links.length === 1) return links[0]
    const weights = yield* Effect.forEach(links, (l) => l.weight)
    return yield* Distribution.weighted(links, weights)
  })

/**
 * The retry group with different defaults, for ports whose callers have a documented policy of their own
 * (SNS retries a failing SQS or Lambda subscriber for 23 days, for instance).
 */
export const retryWith = (defaults: {
  readonly maxAttempts?: number
  readonly backoff?: Duration.Input
  readonly backoffFactor?: number
  readonly maxBackoff?: Duration.Input
  readonly jitter?: boolean
}) =>
  Setting.group(
    {
      maxAttempts: Setting.int({ default: defaults.maxAttempts ?? 1, min: 1, max: 100, label: "Max attempts", help: "1 means no retries." }),
      backoff: Setting.duration({ default: defaults.backoff ?? "100 millis", min: 0, max: "1 minute", label: "Initial backoff" }),
      backoffFactor: Setting.number({ default: defaults.backoffFactor ?? 2, min: 1, max: 10, step: 0.5, label: "Backoff factor" }),
      maxBackoff: Setting.duration({ default: defaults.maxBackoff ?? "10 seconds", min: 0, max: "10 minutes", label: "Max backoff" }),
      jitter: Setting.bool({ default: defaults.jitter ?? true, help: "Randomise each wait between zero and its full length." })
    },
    { label: "Retries" }
  )
