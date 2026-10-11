import { Duration, SubscriptionRef } from "effect"
import type { Fast } from "../../Component.ts"
import type * as Edge from "../../Edge.ts"
import type { CallFailure } from "../../Message.ts"
import type { TimerHandle } from "../../VirtualTime.ts"
import type { Account } from "../account.ts"
import {
  API_BATCH,
  type Consumer,
  ESM_CEILING,
  LONG_POLL_MS,
  MAX_BATCH_BYTES,
  PROVISIONED_CEILING,
  PROVISIONED_INVOKES_PER_POLLER,
  PROVISIONED_SCALE_PER_MINUTE,
  type QueueConfig,
  RESCALE_MS
} from "./config.ts"
import type { Deliveries } from "./delivery.ts"
import type { Tallies } from "./metrics.ts"
import type { QueueStore } from "./store.ts"
import { type FifoRate, fifoRate } from "./throughput.ts"
import type { Delivery, Entry } from "./types.ts"

type ConsumerSettings = Edge.Config & typeof Consumer.Type
export type ConsumerLink = Edge.Link<ConsumerSettings>

export interface MappingEnv {
  readonly store: QueueStore
  readonly fast: Fast<QueueConfig>
  /** FIFO: the queue's limit on ReceiveMessage calls. */
  readonly receiveRate: FifoRate
  readonly tallies: Tallies
  readonly deliveries: Deliveries
  readonly links: ReadonlyArray<ConsumerLink>
}

/** A concurrent receiver of an event source mapping: idle, gathering a batch, or busy with an invocation (or retrying one). */
interface Poller {
  readonly index: number
  readonly mapping: Mapping
  /** Part of the mapping's current pool. Pollers above the target retire when they next go idle, and come back if it grows. */
  alive: boolean
  /** What it has received for the batch in hand. The visibility timeout of each receive is already running. */
  held: Array<Delivery>
  heldCount: number
  heldBytes: number
  /** The batching window while gathering, or the wait before a throttled batch is tried again. */
  timer: TimerHandle | undefined
  /** Position in `mapping.gathering`, while gathering. */
  slot: number
  readonly done: (failure: CallFailure | undefined) => void
}

/** One consumer edge: the event source mapping that polls the queue for it, and the pollers it has running. */
interface Mapping {
  readonly link: ConsumerLink
  /** The concurrency the mapping is working up to (fractional, so a slow ramp accumulates). */
  ramp: number
  /** Pollers it wants right now. */
  target: number
  readonly pollers: Array<Poller>
  readonly idle: Array<Poller>
  readonly gathering: Array<Poller>
  scalingFor: ConsumerSettings | undefined
  scaling: Scaling
}

/** How a mapping scales: where it starts, how fast it adds, and the most it will run. */
interface Scaling {
  readonly initial: number
  readonly perMinute: number
  readonly cap: number
}

const scalingOf = (c: ConsumerSettings): Scaling =>
  c.provisionedMinPollers > 0
    ? {
      // Provisioned mode: dedicated pollers, 10 concurrent invocations each, 1,000 more a minute, never above 100,000.
      // The maximum-concurrency setting can't be combined with it, so it is ignored.
      initial: c.provisionedMinPollers * PROVISIONED_INVOKES_PER_POLLER,
      perMinute: PROVISIONED_SCALE_PER_MINUTE,
      cap: Math.min(Math.max(c.provisionedMaxPollers, c.provisionedMinPollers) * PROVISIONED_INVOKES_PER_POLLER, PROVISIONED_CEILING)
    }
    : {
      initial: c.initialConcurrency,
      perMinute: c.scaleUpPerMinute,
      cap: Math.min(c.maxConcurrency > 0 ? c.maxConcurrency : ESM_CEILING, ESM_CEILING)
    }

/**
 * Lambda's event source mapping for a queue: pollers that receive batches and invoke the consumer, and the rules that
 * decide how many there are.
 *
 * A poller is a small state machine with no fiber behind it. Messages are handed to pollers as they become receivable
 * (`pump`), not by polling on a timer. What the real mapping does that is modelled:
 *
 *  - it starts with 5 concurrent batches and, while messages are still waiting and every poller is busy, adds 300 a
 *    minute up to 1,250 (or the maximum concurrency); when the backlog clears it falls back. Provisioned mode starts
 *    higher and adds faster;
 *  - a batch is received in calls of at most ten, and each receive's visibility timeout starts at once, so a poller
 *    that waits out a batching window is spending its messages' visibility timeout;
 *  - a batch is cut at 6 MB, and a FIFO batch (at most ten) is filled from one group after another;
 *  - on a function error the messages stay hidden until the visibility timeout, and the mapping backs off. On
 *    throttling it keeps the batch and tries again until the visibility timeout runs out, backing off as well;
 *  - on success it deletes the batch.
 *
 * What is not: partial batch responses (the engine's calls carry only success or failure), so one bad record fails the
 * whole batch as it does without `ReportBatchItemFailures`.
 */
export class Pollers {
  private readonly mappings: ReadonlyArray<Mapping>
  private pumping = false
  private rateTimer: TimerHandle | undefined

  constructor(private readonly env: MappingEnv) {
    this.mappings = env.links.map((link) => {
      const scaling = scalingOf(SubscriptionRef.getUnsafe(link.config))
      const initial = Math.max(1, Math.min(scaling.initial, scaling.cap))
      return { link, ramp: scaling.initial, target: initial, pollers: [], idle: [], gathering: [], scalingFor: undefined, scaling }
    })
  }

  /** Start every mapping with its first pollers and begin re-evaluating how many it wants. */
  start(): void {
    for (const m of this.mappings) {
      this.ensure(m)
      this.env.fast.after(RESCALE_MS, this.rescale, m)
    }
  }

  /** Hand receivable messages to idle and gathering pollers until there is nobody to take them or nothing to give. */
  pump = (): void => {
    if (this.pumping) return
    this.pumping = true
    try {
      for (const m of this.mappings) this.serve(m)
    } finally {
      this.pumping = false
    }
  }

  /** Per consumer: how many pollers it wants now, and how many are running a batch or holding one (for the probe). */
  status(): Array<{ concurrency: number; busy: number }> {
    return this.mappings.map((m) => {
      let busy = 0
      for (const p of m.pollers) if (p.alive && (p.heldCount > 0 || p.timer !== undefined)) busy++
      return { concurrency: m.target, busy }
    })
  }

  private serve(m: Mapping): void {
    const { store, fast } = this.env
    const mapping = SubscriptionRef.getUnsafe(m.link.config)
    const limit = fast.settings().inFlightLimit
    // A FIFO batch is at most ten messages, and its mapping has no batching window.
    const size = store.fifo ? Math.min(mapping.batchSize, API_BATCH) : mapping.batchSize
    const window = store.fifo ? 0 : Duration.toMillis(mapping.batchWindow)

    // Pollers already holding part of a batch take new messages first.
    if (m.gathering.length > 0) {
      for (const p of m.gathering.slice()) {
        if (!store.hasWork() || store.counts.hidden >= limit) break
        if (this.fill(p, size, window, limit)) this.launch(p)
      }
    }
    // At the in-flight limit a receive returns nothing, so no idle poller starts a batch.
    while (store.hasWork() && store.counts.hidden < limit) {
      const p = m.idle.pop()
      if (p === undefined) break
      if (p.index >= m.target) {
        p.alive = false
        continue
      }
      if (this.fill(p, size, window, limit)) this.launch(p)
      else if (p.heldCount > 0) {
        // Wait for the batch to fill, up to the window.
        p.slot = m.gathering.length
        m.gathering.push(p)
        p.timer = fast.after(window, this.onWindow, p)
      } else {
        // Nothing came back (every FIFO group is busy, or the receive rate is spent).
        m.idle.push(p)
        break
      }
    }
  }

  /** Receive into the poller until its batch is full or nothing more can be taken. Returns whether to invoke now. */
  private fill(p: Poller, size: number, window: number, limit: number): boolean {
    const { store, deliveries } = this.env
    while (p.heldCount < size && p.heldBytes < MAX_BATCH_BYTES && store.counts.hidden < limit) {
      if (store.fifo && !this.takeReceiveToken()) break
      const room = Math.min(API_BATCH, size - p.heldCount, limit - store.counts.hidden)
      const delivery = deliveries.receive(room, MAX_BATCH_BYTES - p.heldBytes)
      if (delivery === undefined) break
      p.held.push(delivery)
      p.heldCount += delivery.entries.length
      p.heldBytes += delivery.bytes
      // A FIFO batch is one receive (it is at most ten messages and may span groups).
      if (store.fifo) break
    }
    return p.heldCount >= size || p.heldBytes >= MAX_BATCH_BYTES || (p.heldCount > 0 && window <= 0)
  }

  private readonly onWindow = (p: Poller): void => {
    p.timer = undefined
    this.launch(p)
    this.pump()
  }

  /** Invoke the consumer with what the poller holds. */
  private launch(p: Poller): void {
    p.timer?.cancel()
    p.timer = undefined
    const { gathering } = p.mapping
    if (gathering[p.slot] === p) {
      // Swap-remove: O(1), and the order of the pollers still gathering doesn't matter.
      const last = gathering.pop()!
      if (last !== p) {
        gathering[p.slot] = last
        last.slot = p.slot
      }
    }
    this.send(p)
  }

  private send(p: Poller): void {
    // Messages whose visibility timeout lapsed while the poller waited are no longer its to deliver.
    const batch: Array<Entry> = []
    for (const d of p.held) for (const e of d.entries) if (e.status === "hidden" && e.receipt === d.receipt) batch.push(e)
    if (batch.length === 0) return this.release(p)
    let bytes = 0
    let attempt = 0
    for (const e of batch) {
      bytes += e.bytes
      if (e.receives > attempt) attempt = e.receives
    }
    p.mapping.link.send({ ...batch[0]!.message, count: batch.length, bytes: Math.min(MAX_BATCH_BYTES, bytes), attempt, invocation: "sync" }, p.done)
  }

  /** The invocation ended. */
  private outcome(p: Poller, failure: CallFailure | undefined): void {
    const { deliveries, tallies, fast } = this.env
    const m = p.mapping
    if (failure === undefined) {
      for (const d of p.held) deliveries.ack(d)
      this.release(p)
      return this.pump()
    }
    tallies.nacks.add(1)
    // Either way the mapping backs off: it lowers the concurrency it is working up to, but never below where it starts.
    m.ramp = Math.max(m.scaling.initial, m.ramp * 0.9)
    if (failure._tag === "Throttled") {
      // Lambda keeps the batch and retries until the visibility timeout runs out, then lets it go (the lapse returns it).
      p.timer = fast.after(Duration.toMillis(SubscriptionRef.getUnsafe(m.link.config).throttleRetry), this.retry, p)
      return
    }
    // A function error: stop. The messages stay hidden and come back when the visibility timeout lapses.
    this.release(p)
    this.pump()
  }

  private readonly retry = (p: Poller): void => {
    p.timer = undefined
    this.send(p)
    this.pump()
  }

  /** The poller is done with its batch. */
  private release(p: Poller): void {
    p.held = []
    p.heldCount = 0
    p.heldBytes = 0
    p.mapping.idle.push(p)
  }

  /** FIFO receives are limited to 300 a second (or the regional quota in high-throughput mode), like sends. */
  private takeReceiveToken(): boolean {
    const { fast, receiveRate } = this.env
    const rate = fifoRate(fast.settings(), fast.account() as Account)
    if (receiveRate.take(rate, 1)) return true
    // Try again when a token has refilled.
    this.rateTimer ??= fast.after(Math.max(1, Math.ceil(1000 / rate)), this.onRate, undefined)
    return false
  }

  private readonly onRate = (): void => {
    this.rateTimer = undefined
    this.pump()
  }

  /** Create the pollers the mapping wants and bring back any that retired. */
  private ensure(m: Mapping): void {
    for (let i = 0; i < m.target; i++) {
      let p = m.pollers[i]
      if (p === undefined) {
        p = {
          index: i,
          mapping: m,
          alive: false,
          held: [],
          heldCount: 0,
          heldBytes: 0,
          timer: undefined,
          slot: -1,
          done: (failure) => this.outcome(p!, failure)
        }
        m.pollers[i] = p
      }
      if (!p.alive) {
        p.alive = true
        m.idle.push(p)
      }
    }
  }

  /** Once a second: work out how many pollers the mapping wants. */
  private readonly rescale = (m: Mapping): void => {
    const { store, fast, tallies } = this.env
    const mapping = SubscriptionRef.getUnsafe(m.link.config)
    if (m.scalingFor !== mapping) {
      m.scalingFor = mapping
      m.scaling = scalingOf(mapping)
    }
    const s = m.scaling
    // Pressure: messages are waiting and every poller is already busy.
    const pressure = store.counts.ready > 0 && store.hasWork() && m.idle.length === 0
    m.ramp = pressure ? m.ramp + s.perMinute / 60 : Math.max(s.initial, m.ramp - Math.max(1, (m.ramp - s.initial) * 0.1))
    const next = Math.max(1, Math.floor(Math.min(m.ramp, s.cap)))
    if (next !== m.target) {
      m.target = next
      this.ensure(m)
      this.pump()
    }
    // Idle pollers sit in a long poll that ends empty after 20 seconds.
    if (!store.hasWork()) tallies.emptyReceives.add((Math.min(m.idle.length, m.target) * RESCALE_MS) / LONG_POLL_MS)
    fast.after(RESCALE_MS, this.rescale, m)
  }
}
