import { type Context, Duration, Effect, Schema, SubscriptionRef } from "effect"
import * as Distribution from "./Distribution.ts"
import { type EdgeEffect, Faults } from "./Fault.ts"
import { type Call, type CallFailure, failureCounter, isRetryable, type ItemFailures, type Message, Timeout, Unavailable } from "./Message.ts"
import type { SeededRandom } from "./SeededRandom.ts"
import * as Setting from "./Setting.ts"
import { Telemetry } from "./Telemetry.ts"
import { type TimerHandle, VirtualTime } from "./VirtualTime.ts"

/**
 * Edges, in two layers.
 *
 *  - **Transport** is what every hop between two nodes costs, whatever sits on the edge: network latency there and back,
 *    and the edge's faults (outage, black hole, loss, added latency). A `Wire` runs one try of a call through it.
 *  - **Call policy** is what the caller does about a try: how long it waits (timeout), whether it gives up on the callee
 *    or abandons it, and whether it tries again (retries with backoff). The plain link (`core.link`) is transport plus
 *    the policy in its settings; other connectors bring their own (Lambda's event source mapping waits for the function
 *    and never retries the call itself, because the queue redelivers).
 *
 * A connector (see `Connector.ts`) asks its wire for tries and never sees latency, so transport is the same everywhere.
 */

// ---------------------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------------------

const weight = Setting.number({
  default: 1,
  min: 0,
  max: 1000,
  step: 0.1,
  help: "Share of traffic this edge gets when the source routes by weight."
})
const latency = Setting.latency({
  mean: 1,
  cv: 0.3,
  label: "Network latency",
  help: "One-way; paid on the way there and back. Unless set, it is estimated from where the two nodes run."
})
const request = Setting.group(
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
)
const timeout = Setting.duration({
  default: "30 seconds",
  min: "1 millis",
  max: "10 minutes",
  label: "Timeout",
  help: "How long the caller waits before giving up."
})
const cancelOnTimeout = Setting.bool({
  default: false,
  label: "Cancel on timeout",
  help: "Off: the callee keeps working after the caller gives up (wasted work, like most real clients). On: the work is cancelled."
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
const retry = retryWith({})

/** What every hop costs, on every edge. */
export const Transport = Schema.Struct({ latency })
export type Transport = typeof Transport.Type

/** The plain link's settings: routing weight, what the call carries, and the caller's timeout and retries. */
export const Policy = Schema.Struct({ weight, request, timeout, cancelOnTimeout, retry })
export type Policy = typeof Policy.Type

/** A plain link's whole edge: transport and policy together. What a component's links carry, besides its port's own settings. */
export const Config = Schema.Struct({ weight, latency, request, timeout, cancelOnTimeout, retry })
export type Config = typeof Config.Type

// ---------------------------------------------------------------------------------------------------------
// What components see
// ---------------------------------------------------------------------------------------------------------

/**
 * Hears how a call ended, once: `undefined` for success, with `items` when the callee succeeded except for some records
 * of the batch (see `ItemFailures`).
 */
export type Done = (failure: CallFailure | undefined, items?: ItemFailures) => void
/** Abandons a call in flight. Safe to call after it has finished. */
export type Cancel = () => void

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
  /** Call the target through this edge: its connector, transport and faults. */
  readonly invoke: (message: Message) => Call
  /**
   * The same call as a plain callback: `done` hears the outcome once (`undefined` for success). No fiber, no effect:
   * this is how a source of traffic, or anything that fires and forgets, sends at volume. The returned function
   * abandons the call (the callee keeps going unless the edge is set to cancel on timeout).
   */
  readonly send: (message: Message, done?: Done) => Cancel
}

/** The face of an edge a component calls through, from whatever its connector does with a message. */
export const link = <C extends Config>(args: {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly config: SubscriptionRef.SubscriptionRef<C>
  readonly send: (message: Message, done?: Done) => Cancel
}): Link<C> => {
  const { config, send } = args
  // Only a plain link has a weight; anything else on an invoke port counts as 1.
  const weightOf = (c: C): number => (c as { readonly weight?: number }).weight ?? 1
  return {
    id: args.id,
    from: args.from,
    to: args.to,
    config,
    weight: Effect.map(SubscriptionRef.get(config), weightOf),
    weightUnsafe: () => weightOf(SubscriptionRef.getUnsafe(config)),
    invoke: (message) =>
      Effect.callback<ItemFailures | void, CallFailure>((resume) => {
        const cancel = send(message, (failure, items) => resume(failure !== undefined ? Effect.fail(failure) : items === undefined ? Effect.void : Effect.succeed(items)))
        return Effect.sync(cancel)
      }),
    send
  }
}

/**
 * What an edge calls: the node at its far end, already wrapped with that node's faults and metrics.
 *
 * `start` runs the node's handler for one message and reports the outcome to `done`, exactly once, from inside the
 * world. It hands back a function that cancels the work. It is a callback rather than an `Effect` so the edge can
 * run a whole call (latency, timeout, retries) without building an effect for any of it.
 */
export interface Target {
  readonly start: (message: Message, done: Done) => Cancel
}

// ---------------------------------------------------------------------------------------------------------
// Call policy
// ---------------------------------------------------------------------------------------------------------

/** What a caller does about each try, in plain numbers (milliseconds). */
export interface CallPolicy {
  /** How long one try may take before the caller gives up on it. `Infinity` waits for as long as it takes. */
  readonly timeoutMs: number
  /** On a timeout, cancel the callee's work instead of abandoning it. */
  readonly cancelOnTimeout: boolean
  /** 1 means no retries. */
  readonly maxAttempts: number
  readonly backoffMs: number
  readonly backoffFactor: number
  readonly maxBackoffMs: number
  readonly jitter: boolean
}

/** One try, waited out for as long as it takes. */
export const once: CallPolicy = { timeoutMs: Infinity, cancelOnTimeout: false, maxAttempts: 1, backoffMs: 0, backoffFactor: 1, maxBackoffMs: 0, jitter: false }

/** One try, given up on after `ms`. */
export const within = (ms: number): CallPolicy => ({ ...once, timeoutMs: ms })

const policies = new WeakMap<object, CallPolicy>()

/** The call policy a plain link's settings describe. Memoised on the settings, which only change when someone edits them. */
export const policyOf = (c: Pick<Policy, "timeout" | "cancelOnTimeout" | "retry">): CallPolicy => {
  let p = policies.get(c)
  if (p === undefined) {
    p = {
      timeoutMs: Duration.toMillis(c.timeout),
      cancelOnTimeout: c.cancelOnTimeout,
      maxAttempts: c.retry.maxAttempts,
      backoffMs: Duration.toMillis(c.retry.backoff),
      backoffFactor: c.retry.backoffFactor,
      maxBackoffMs: Duration.toMillis(c.retry.maxBackoff),
      jitter: c.retry.jitter
    }
    policies.set(c, p)
  }
  return p
}

// ---------------------------------------------------------------------------------------------------------
// Transport: one call through a wire
// ---------------------------------------------------------------------------------------------------------

/**
 * One edge's transport. Every call any connector makes across the edge goes through `call`, which is what keeps latency,
 * edge faults and the edge's metrics (`calls`, `ok`, `fail`, `fail.<Tag>`, `retries`, `latency`, `inflight`) the same
 * whatever the connector is.
 */
export interface Wire {
  readonly id: string
  readonly from: string
  readonly to: string
  /** Tries in flight right now. */
  readonly inflight: () => number
  /** Call the far end under `policy`: tries through transport, with the policy's timeout and retries. */
  readonly call: (message: Message, policy: CallPolicy, done?: Done) => Cancel
}

export interface WireArgs {
  readonly id: string
  readonly from: string
  readonly to: string
  /** The edge's settings. Transport reads `latency` from them. */
  readonly config: SubscriptionRef.SubscriptionRef<Transport>
  readonly target: Target
  /** This edge's own random stream. */
  readonly random: SeededRandom
}

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
    readonly done: Done | undefined
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
    this.step = w.world.after(Distribution.latencyMs(this.transport.latency, w.random) + f.extraMs, onArrive, this)
  }

  /** The request has crossed the network. */
  arrive(): void {
    this.step = undefined
    const w = this.wire
    if (this.fault.outage) return this.end(Unavailable({ node: w.to, reason: "connection refused" }))
    const attempt = this.attempt
    this.cancelCallee = w.target.start(this.message, (failure, items) => this.calleeDone(attempt, failure, items))
  }

  calleeDone(attempt: number, failure: CallFailure | undefined, items: ItemFailures | undefined): void {
    if (attempt !== this.attempt || !this.open) return // abandoned: the caller has moved on
    if (failure !== undefined) return this.end(failure)
    this.items = items
    this.step = this.wire.world.after(Distribution.latencyMs(this.transport.latency, this.wire.random), onReturn, this)
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

interface WireRuntime {
  readonly id: string
  readonly to: string
  readonly target: Target
  readonly random: SeededRandom
  readonly world: { readonly nowUnsafe: () => number; readonly after: VirtualTime["Service"]["after"] }
  readonly faults: Context.Service.Shape<typeof Faults>
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

/** The transport of one edge, recording into the edge's meter. */
export const wire = (args: WireArgs): Effect.Effect<Wire, never, Telemetry | Faults | VirtualTime> =>
  Effect.gen(function*() {
    const { id, to, config, target, random } = args
    const telemetry = yield* Telemetry
    const faults = yield* Faults
    const world = yield* VirtualTime
    const meter = telemetry.edge(id)
    const failures = new Map<string, { n: number }>()
    const runtime: WireRuntime = {
      id,
      to,
      target,
      random,
      world,
      faults,
      calls: meter.counter("calls"),
      ok: meter.counter("ok"),
      partial: meter.counter("partial"),
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

    return {
      id,
      from: args.from,
      to,
      inflight: () => runtime.inflight,
      call: (message, policy, done) => {
        const flight = new Flight(runtime, message, policy, done)
        flight.transport = SubscriptionRef.getUnsafe(config)
        flight.begin()
        return flight.cancelBound ?? (flight.cancelBound = () => flight.cancel())
      }
    }
  })

// ---------------------------------------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------------------------------------

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
