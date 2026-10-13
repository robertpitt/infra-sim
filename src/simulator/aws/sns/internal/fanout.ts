import { Duration, SubscriptionRef } from "effect"
import * as Flow from "../../../Flow.ts"
import { passes } from "../../../kit/Shape.ts"
import { type Tally, tallies, totals } from "../../../kit/Tally.ts"
import type { Fast } from "../../../Component.ts"
import * as Distribution from "../../../Distribution.ts"
import type * as Edge from "../../../Edge.ts"
import type { CallFailure, Message } from "../../../Message.ts"
import type { Meter } from "../../../Telemetry.ts"
import { ENVELOPE_BYTES, type SubscriptionEdge, type TopicConfig } from "./config.ts"

/**
 * Delivering a published message to every subscription.
 *
 * Each subscription is independent: its own filter, its own retries, its own lanes, its own backlog. A subscriber that
 * is slow or down holds up nothing but its own deliveries (and, on a FIFO topic, the messages of the same group behind
 * the one it is stuck on). The topic has already acknowledged the publisher by the time any of this runs.
 */

/** One subscription: the edge to the subscriber and what is waiting on it. */
class Subscription {
  /** Deliveries admitted and not finished: sending, retrying, or queued behind a FIFO group or the throttle. */
  pending = 0
  /** Earliest virtual time the throttle lets the next delivery start. */
  nextAt = 0
  /** FIFO: a lane per message group, so a group's messages reach this subscriber one at a time, in order. */
  readonly lanes = new Flow.Lanes()

  constructor(readonly link: Edge.Link<SubscriptionEdge>) {}
}

/**
 * What happened to deliveries since the simulation began, for the probe. The per-second rates come from the meter's
 * counters of the same names, which reset every frame.
 */
const TALLIES = ["delivered", "undelivered", "filteredOut", "overflow", "redriven", "redriveFailed"] as const
export type Totals = Record<(typeof TALLIES)[number], number>

/** One message on its way to one subscriber, from admission to the subscriber's answer. */
class Delivery {
  private release: () => void = noop

  constructor(
    private readonly fan: FanOut,
    private readonly sub: Subscription,
    /** What the subscriber is sent: asynchronous, with the envelope when raw message delivery is off. */
    private readonly message: Message,
    private readonly count: number,
    private readonly deadLetter: boolean,
    private readonly maxReceivesPerSecond: number
  ) {}

  /** The lane (or nothing, on a standard topic) lets this delivery go. */
  readonly run = (release: () => void): void => {
    this.release = release
    const fast = this.fan.fast
    const c = fast.settings()
    const now = fast.now()
    let wait = Duration.toMillis(c.deliveryLatency.mean) > 0 ? Distribution.latencyMs(c.deliveryLatency, fast.random) : 0
    if (this.maxReceivesPerSecond > 0) {
      // Held-back deliveries are re-queued without using up retries, so the throttle is a spacing of first attempts.
      const at = Math.max(now + wait, this.sub.nextAt)
      this.sub.nextAt = at + (1000 * this.count) / this.maxReceivesPerSecond
      wait = at - now
    }
    if (wait > 0) fast.after(wait, sendNow, this)
    else this.send()
  }

  send(): void {
    this.sub.link.send(this.message, this.finish)
  }

  /** The edge has the answer, after any retries. A failure here is final: SNS has stopped trying. */
  private readonly finish = (failure: CallFailure | undefined): void => {
    this.sub.pending--
    this.fan.pending--
    this.fan.record(failure === undefined ? "delivered" : "undelivered", this.count)
    if (failure !== undefined && this.deadLetter) this.fan.redrive(this.message, this.count)
    this.release()
  }
}

const sendNow = (delivery: Delivery): void => delivery.send()
const noop = (): void => {}

export class FanOut {
  private readonly subscriptions: ReadonlyArray<Subscription>
  readonly tally: Record<keyof Totals, Tally>
  /** Deliveries admitted and not yet answered, across every subscription: queued behind a group or the throttle included. */
  pending = 0

  constructor(
    readonly fast: Fast<TopicConfig>,
    meter: Meter,
    links: ReadonlyArray<Edge.Link<SubscriptionEdge>>,
    /** The dead-letter port's edges: at most one. */
    private readonly deadLetters: ReadonlyArray<Edge.Link<Edge.Config>>
  ) {
    this.subscriptions = links.map((link) => new Subscription(link))
    this.tally = tallies(meter, TALLIES)
  }

  get totals(): Totals {
    return totals(this.tally)
  }

  record(what: keyof Totals, n: number): void {
    this.tally[what].add(n)
  }

  /**
   * Hand a published message to every subscription. `group` is the FIFO message group, or `undefined` on a standard
   * topic, which has no order to keep.
   */
  publish(message: Message, count: number, group: string | undefined): void {
    const fast = this.fast
    const limit = fast.settings().maxPendingPerSubscription
    for (const sub of this.subscriptions) {
      const edge = SubscriptionRef.getUnsafe(sub.link.config)
      // The filter policy is evaluated by SNS before anything is queued: a filtered-out message costs nothing later and
      // never waits behind a FIFO group.
      if (!passes(fast.random, edge.filterMatch)) {
        this.record("filteredOut", count)
        continue
      }
      if (sub.pending >= limit) {
        // AWS would keep it for up to 23 days; the simulator cannot hold an unbounded backlog (see `maxPendingPerSubscription`).
        this.record("overflow", count)
        this.record("undelivered", count)
        continue
      }
      sub.pending++
      this.pending++
      const outgoing: Message = edge.rawMessageDelivery
        ? { ...message, invocation: "async" }
        : { ...message, invocation: "async", bytes: message.bytes + ENVELOPE_BYTES }
      const delivery = new Delivery(this, sub, outgoing, count, edge.deadLetterQueue, edge.maxReceivesPerSecond)
      if (group === undefined) delivery.run(noop)
      else sub.lanes.run(group, delivery.run)
    }
  }

  /** Move a message SNS has given up on to the dead-letter queue, if the topic has one wired. */
  redrive(message: Message, count: number): void {
    const target = this.deadLetters[0]
    if (target === undefined) {
      this.record("redriveFailed", count)
      return
    }
    target.send(message, (failure) => this.record(failure === undefined ? "redriven" : "redriveFailed", count))
  }

  /** FIFO message groups with something in flight or waiting, summed over the subscriptions. */
  openGroups(): number {
    let open = 0
    for (const sub of this.subscriptions) open += sub.lanes.open
    return open
  }

  /** What each subscriber has waiting on it. */
  backlog(): ReadonlyArray<{ readonly node: string; readonly pending: number }> {
    return this.subscriptions.map((sub) => ({ node: sub.link.to, pending: sub.pending }))
  }

  get subscribers(): number {
    return this.subscriptions.length
  }
}
