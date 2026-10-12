import { Duration, Effect, Schema } from "effect"
import * as Connector from "../../Connector.ts"
import * as Edge from "../../Edge.ts"
import type { CallFailure, ItemFailures } from "../../Message.ts"
import { batchOf, type Lease, type LeasedRecord, type Pull } from "../../Protocol.ts"
import type { Counter } from "../../Telemetry.ts"
import type { TimerHandle } from "../../VirtualTime.ts"
import { docs } from "../docs.ts"
import {
  Consumer,
  ESM_CEILING,
  LONG_POLL_MS,
  MAX_BATCH_BYTES,
  PROVISIONED_CEILING,
  PROVISIONED_INVOKES_PER_POLLER,
  PROVISIONED_SCALE_PER_MINUTE,
  RESCALE_MS
} from "./config.ts"

type Settings = typeof Consumer.Type

/**
 * How long the mapping waits for one invocation. A synchronous Invoke waits for the function, and a function runs for
 * at most 15 minutes, so the function's own timeout is what ends a slow batch; this only stops a poller waiting forever
 * on a call that can never come back (an edge that is a black hole).
 */
const INVOKE_TIMEOUT_MS = 15 * 60_000 + 30_000
const INVOKE = Edge.within(INVOKE_TIMEOUT_MS)

/** A concurrent receiver: idle, gathering a batch, or busy with an invocation (or retrying one). */
interface Poller {
  readonly index: number
  /** Part of the current pool. Pollers above the target retire when they next go idle, and come back if it grows. */
  alive: boolean
  /** What it has received for the batch in hand. The visibility timeout of each receive is already running. */
  held: Array<Lease>
  heldCount: number
  heldBytes: number
  /** The records of the batch as sent, in order, when the mapping reports batch item failures (positions name them). */
  readonly order: Array<LeasedRecord>
  /** The batching window while gathering, or the wait before a throttled batch is tried again. */
  timer: TimerHandle | undefined
  /** Position in `gathering`, while gathering. */
  slot: number
  readonly done: Edge.Done
}

/** How a mapping scales: where it starts, how fast it adds, and the most it will run. */
interface Scaling {
  readonly initial: number
  readonly perMinute: number
  readonly cap: number
}

const scalingOf = (c: Settings): Scaling =>
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
 * decide how many there are. It is the thing between the queue and the function, so it is the connector on that edge:
 * the queue only offers messages (`Pull`) and the function only handles invocations.
 *
 * A poller is a small state machine with no fiber behind it. Messages are handed to pollers as they become receivable
 * (the queue says when), not by polling on a timer. What the real mapping does that is modelled:
 *
 *  - it starts with 5 concurrent batches and, while messages are still waiting and every poller is busy, adds 300 a
 *    minute up to 1,250 (or the maximum concurrency); when the backlog clears it falls back. Provisioned mode starts
 *    higher and adds faster;
 *  - a batch is received in calls of at most ten, and each receive's visibility timeout starts at once, so a poller
 *    that waits out a batching window is spending its messages' visibility timeout;
 *  - a batch is cut at 6 MB, and a FIFO batch (at most ten) is filled from one group after another;
 *  - it invokes synchronously and waits for the function, however long it runs: the function's timeout ends a slow
 *    batch, not the mapping;
 *  - on a function error the messages stay hidden until the visibility timeout, and the mapping backs off. On
 *    throttling it keeps the batch and tries again until the visibility timeout runs out, backing off as well;
 *  - on success it deletes the batch. With `ReportBatchItemFailures` a success that names failed records (`ItemFailures`)
 *    deletes the rest and leaves those to come back after the visibility timeout, and the mapping doesn't back off;
 *    without it such a reply is ignored and the whole batch is deleted, the failed records with it.
 */
export const EventSourceMapping = Connector.make({
  type: "aws.sqs.event-source-mapping",
  provider: "aws",
  title: "Event source mapping",
  description:
    "Lambda's poller between a queue and its consumer: receives batches, invokes the consumer with each, deletes them on success, and scales its pollers with the backlog.",
  icon: "reload",
  docs: `${docs.lambda}with-sqs.html`,
  // Any consumer: one that isn't a function is modelled as if Lambda's mapping polled for it. A fixed pool of workers
  // is `core.poller`, chosen on the edge.
  from: { protocol: "pull", component: "aws.sqs", port: "deliver" },
  // Lambda's poller: a fleet (an ECS service, an Auto Scaling group) drains a queue with workers of its own (core.poller).
  to: { protocol: "invoke", fleets: false },
  config: Consumer,
  state: Schema.Struct({
    /** Concurrent batches the mapping is running at now. */
    concurrency: Schema.Number,
    /** Pollers running a batch or holding one. */
    busy: Schema.Number
  }),
  make: (ctx) =>
    Effect.sync(() => {
      const mapping = new Mapping(ctx.source, ctx.sink, ctx.fast, {
        itemFailures: ctx.meter.counter("itemFailures"),
        itemFailuresIgnored: ctx.meter.counter("itemFailuresIgnored")
      })
      // On the edge's meter, beside transport's own counts, so a chart of the edge shows the mapping scaling.
      ctx.meter.gaugeUnsafe("concurrency", () => mapping.status().concurrency)
      ctx.meter.gaugeUnsafe("busy", () => mapping.status().busy)
      return mapping.start()
    })
})

class Mapping {
  /** The concurrency the mapping is working up to (fractional, so a slow ramp accumulates). */
  private ramp: number
  /** Pollers it wants right now. */
  private target: number
  private readonly pollers: Array<Poller> = []
  private readonly idle: Array<Poller> = []
  private readonly gathering: Array<Poller> = []
  private scalingFor: Settings
  private scaling: Scaling
  private pumping = false

  constructor(
    private readonly source: Pull,
    private readonly sink: Edge.Wire,
    private readonly fast: Connector.Context<Settings>["fast"],
    private readonly counts: {
      /** Records a function reported failed, left to come back. */
      readonly itemFailures: Counter
      /** Records a function reported failed while the mapping doesn't act on reports: deleted all the same. */
      readonly itemFailuresIgnored: Counter
    }
  ) {
    this.scalingFor = fast.settings()
    this.scaling = scalingOf(this.scalingFor)
    this.ramp = this.scaling.initial
    this.target = Math.max(1, Math.min(this.scaling.initial, this.scaling.cap))
  }

  /** Start with the first pollers, begin re-evaluating how many it wants, and listen for messages. */
  start(): Connector.Instance<{ concurrency: number; busy: number }> {
    this.ensure()
    this.fast.after(RESCALE_MS, this.rescale, undefined)
    this.source.ready(this.pump)
    this.fast.after(0, this.pump, undefined)
    return { probe: Effect.sync(() => this.status()) }
  }

  status(): { concurrency: number; busy: number } {
    let busy = 0
    for (const p of this.pollers) if (p.alive && (p.heldCount > 0 || p.timer !== undefined)) busy++
    return { concurrency: this.target, busy }
  }

  /** Hand receivable messages to idle and gathering pollers until there is nobody to take them or nothing to give. */
  private readonly pump = (): void => {
    if (this.pumping) return
    this.pumping = true
    try {
      this.serve()
    } finally {
      this.pumping = false
    }
  }

  private serve(): void {
    const { source } = this
    const mapping = this.fast.settings()
    // A FIFO batch is at most ten messages, and its mapping has no batching window.
    const ordered = source.traits.ordered
    const size = ordered ? Math.min(mapping.batchSize, source.traits.maxTake ?? Infinity) : mapping.batchSize
    const window = ordered ? 0 : Duration.toMillis(mapping.batchWindow)

    // Pollers already holding part of a batch take new messages first.
    if (this.gathering.length > 0) {
      for (const p of this.gathering.slice()) {
        if (!source.available()) break
        if (this.fill(p, size, window)) this.launch(p)
      }
    }
    // A receive that would return nothing (empty, at the in-flight limit, every FIFO group busy) starts no batch.
    while (source.available()) {
      const p = this.idle.pop()
      if (p === undefined) break
      if (p.index >= this.target) {
        p.alive = false
        continue
      }
      if (this.fill(p, size, window)) this.launch(p)
      else if (p.heldCount > 0) {
        // Wait for the batch to fill, up to the window.
        p.slot = this.gathering.length
        this.gathering.push(p)
        p.timer = this.fast.after(window, this.onWindow, p)
      } else {
        // Nothing came back (every FIFO group is busy, or the receive rate is spent).
        this.idle.push(p)
        break
      }
    }
  }

  /** Receive into the poller until its batch is full or nothing more can be taken. Returns whether to invoke now. */
  private fill(p: Poller, size: number, window: number): boolean {
    const { source } = this
    while (p.heldCount < size && p.heldBytes < MAX_BATCH_BYTES) {
      const lease = source.take(size - p.heldCount, MAX_BATCH_BYTES - p.heldBytes)
      if (lease === undefined) break
      p.held.push(lease)
      p.heldCount += lease.count
      p.heldBytes += lease.bytes
      // A FIFO batch is one receive (it is at most ten messages and may span groups).
      if (source.traits.ordered) break
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
    const { gathering } = this
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
    p.order.length = 0
    const batch = batchOf(p.held, MAX_BATCH_BYTES, this.fast.settings().reportBatchItemFailures ? p.order : undefined)
    if (batch === undefined) return this.release(p)
    this.sink.call(batch, INVOKE, p.done)
  }

  /** The invocation ended. */
  private outcome(p: Poller, failure: CallFailure | undefined, items: ItemFailures | undefined): void {
    if (failure === undefined) {
      if (items === undefined) for (const lease of p.held) lease.ack()
      else if (this.fast.settings().reportBatchItemFailures && p.order.length > 0) {
        const keep = this.failedRecords(p.order, items.failed)
        this.counts.itemFailures.n += keep.size
        for (const lease of p.held) lease.ack(keep)
      } else {
        // The function returned normally, so as far as the mapping knows the whole batch worked.
        this.counts.itemFailuresIgnored.n += items.failed.length
        for (const lease of p.held) lease.ack()
      }
      this.release(p)
      return this.pump()
    }
    // Either way the mapping backs off: it lowers the concurrency it is working up to, but never below where it starts.
    this.ramp = Math.max(this.scaling.initial, this.ramp * 0.9)
    if (failure._tag === "Throttled") {
      // Lambda keeps the batch and retries until the visibility timeout runs out, then lets it go (the lapse returns it).
      p.timer = this.fast.after(Duration.toMillis(this.fast.settings().throttleRetry), this.retry, p)
      return
    }
    // A function error: stop. The messages stay hidden and come back when the visibility timeout lapses.
    this.release(p)
    this.pump()
  }

  /**
   * The records a reply named, by position in the batch as sent. From a FIFO queue, a failed record's later messages in the
   * same group are kept too: AWS asks a FIFO handler to stop at the first failure and report the rest of the group, so
   * the group's order holds.
   */
  private failedRecords(order: ReadonlyArray<LeasedRecord>, failed: ReadonlyArray<number>): Set<LeasedRecord> {
    const keep = new Set<LeasedRecord>()
    for (const i of failed) {
      const record = order[i]
      if (record !== undefined) keep.add(record)
    }
    if (!this.source.traits.ordered || keep.size === 0) return keep
    const stopped = new Set<string>()
    for (const record of order) {
      const group = record.message.group ?? "default"
      if (keep.has(record)) stopped.add(group)
      else if (stopped.has(group)) keep.add(record)
    }
    return keep
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
    this.idle.push(p)
  }

  /** Create the pollers the mapping wants and bring back any that retired. */
  private ensure(): void {
    for (let i = 0; i < this.target; i++) {
      let p = this.pollers[i]
      if (p === undefined) {
        const created: Poller = {
          index: i,
          alive: false,
          held: [],
          heldCount: 0,
          heldBytes: 0,
          order: [],
          timer: undefined,
          slot: -1,
          done: (failure, items) => this.outcome(created, failure, items)
        }
        this.pollers[i] = p = created
      }
      if (!p.alive) {
        p.alive = true
        this.idle.push(p)
      }
    }
  }

  /** Once a second: work out how many pollers the mapping wants. */
  private readonly rescale = (): void => {
    const { source, fast } = this
    const mapping = fast.settings()
    if (this.scalingFor !== mapping) {
      this.scalingFor = mapping
      this.scaling = scalingOf(mapping)
    }
    const s = this.scaling
    // Pressure: messages are waiting and every poller is already busy.
    const pressure = source.backlog() > 0 && this.idle.length === 0
    this.ramp = pressure ? this.ramp + s.perMinute / 60 : Math.max(s.initial, this.ramp - Math.max(1, (this.ramp - s.initial) * 0.1))
    const next = Math.max(1, Math.floor(Math.min(this.ramp, s.cap)))
    if (next !== this.target) {
      this.target = next
      this.ensure()
      this.pump()
    }
    // Idle pollers sit in a long poll that ends empty after 20 seconds.
    if (source.backlog() === 0) source.idle((Math.min(this.idle.length, this.target) * RESCALE_MS) / LONG_POLL_MS)
    fast.after(RESCALE_MS, this.rescale, undefined)
  }
}
