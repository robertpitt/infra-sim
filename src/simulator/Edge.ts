import { Duration, Effect, Schema, SubscriptionRef } from "effect"
import * as Distribution from "./Distribution.ts"
import { Faults } from "./Fault.ts"
import type { Call, CallFailure, ItemFailures, Message } from "./Message.ts"
import type { HealthAnswer, Unit } from "./Protocol.ts"
import type { SeededRandom } from "./SeededRandom.ts"
import * as Setting from "./Setting.ts"
import { Telemetry } from "./Telemetry.ts"
import { VirtualTime } from "./VirtualTime.ts"
import * as internal from "./internal/edge.ts"
import { memoByIdentity } from "./internal/memo.ts"

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
    operation: Setting.choice(["write", "read", "caller"], {
      default: "write",
      labels: { write: "Write", read: "Read", caller: "What the caller asked (read or write)" },
      help: "What this call does to the receiver. Stores and object stores price and limit reads and writes differently. A hop that only passes calls on (a firewall, a load balancer, a cache in front of a store) keeps the caller's with \"caller\"."
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
  /** What the node at the far end offers beyond calls (its `Instance.offer`), if anything. Ask when needed: it is made after the caller. */
  readonly offer: () => unknown
}

/** The face of an edge a component calls through, from whatever its connector does with a message. */
export const link = <C extends Config>(args: {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly config: SubscriptionRef.SubscriptionRef<C>
  readonly send: (message: Message, done?: Done) => Cancel
  readonly offer?: () => unknown
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
    send,
    offer: args.offer ?? noOffer
  }
}

const noOffer = (): unknown => undefined

/**
 * What an edge calls: the node at its far end, already wrapped with that node's faults and metrics.
 *
 * `start` runs the node's handler for one message and reports the outcome to `done`, exactly once, from inside the
 * world. It hands back a function that cancels the work. It is a callback rather than an `Effect` so the edge can
 * run a whole call (latency, timeout, retries) without building an effect for any of it.
 */
export interface Target {
  /**
   * `unit`, when given, is the unit of a fleet the call is addressed to (picked by a connector that speaks `fleet`); the
   * node runs it with its fleet's `serve` rather than its handler.
   */
  readonly start: (message: Message, done: Done, unit?: Unit) => Cancel
  /**
   * Whether the node answers at all right now (its own, its region's and its zone's outages): what a health check that
   * crosses this edge finds before asking a unit.
   */
  readonly reachable?: () => boolean
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

/** The call policy a plain link's settings describe. Memoised on the settings, which only change when someone edits them. */
export const policyOf: (c: Pick<Policy, "timeout" | "cancelOnTimeout" | "retry">) => CallPolicy = memoByIdentity((c) => ({
  timeoutMs: Duration.toMillis(c.timeout),
  cancelOnTimeout: c.cancelOnTimeout,
  maxAttempts: c.retry.maxAttempts,
  backoffMs: Duration.toMillis(c.retry.backoff),
  backoffFactor: c.retry.backoffFactor,
  maxBackoffMs: Duration.toMillis(c.retry.maxBackoff),
  jitter: c.retry.jitter
}))

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
  /**
   * Call the far end under `policy`: tries through transport, with the policy's timeout and retries. A connector that
   * picks units of a fleet passes the `unit` the call is for, and any `extraMs` of one-way latency its route adds (crossing
   * zones); every try goes to that unit.
   */
  readonly call: (message: Message, policy: CallPolicy, done?: Done, unit?: Unit, extraMs?: number) => Cancel
  /**
   * A health check across the edge: latency there, `answer` asked on arrival, latency back (plus what the answer adds),
   * given up after `timeoutMs`. `done` hears `true` only for a healthy answer in time. It goes through the edge's faults
   * (an outage refuses it, a black hole or loss lets it time out) but counts in none of the edge's metrics, as a load
   * balancer's health checks aren't requests. The returned function abandons it.
   */
  readonly ping: (answer: () => HealthAnswer, timeoutMs: number, done: (healthy: boolean) => void, extraMs?: number) => Cancel
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

/** The transport of one edge, recording into the edge's meter. */
export const wire = (args: WireArgs): Effect.Effect<Wire, never, Telemetry | Faults | VirtualTime> =>
  Effect.gen(function*() {
    const meter = (yield* Telemetry).edge(args.id)
    const runtime = internal.runtime(args, meter, yield* Faults, yield* VirtualTime)
    yield* meter.gauge("inflight", Effect.sync(() => runtime.inflight))
    return internal.wire(runtime, args)
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
