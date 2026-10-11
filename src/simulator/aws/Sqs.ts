import { Duration, Effect, Schema, SubscriptionRef } from "effect"
import * as Component from "../Component.ts"
import type * as Edge from "../Edge.ts"
import { type Message, Rejected, Throttled } from "../Message.ts"
import * as Setting from "../Setting.ts"
import type { TimerHandle } from "../VirtualTime.ts"
import * as Aws from "./provider.ts"

const D = Aws.docs.sqs
const MAX_MESSAGE = 1_048_576
/** A batch handed to a consumer is cut off at 6 MB (Lambda's payload limit). */
const MAX_BATCH_BYTES = 6 * 1024 * 1024
/** FIFO in normal mode: 300 API calls per second, per action. */
const FIFO_NORMAL_TPS = 300
/** A send or receive batch is at most ten messages. */
const API_BATCH = 10
const ESM_CEILING = 1_250
const SAMPLE = 20

/** What polls a queue and hands messages to a consumer: batching and concurrency. An event source mapping, in Lambda's terms. */
const Consumer = Schema.Struct({
  batchSize: Setting.int({
    default: 10,
    min: 1,
    max: 10_000,
    unit: "messages",
    label: "Batch size",
    help: "Messages per invocation. FIFO queues cap at 10; above 10 a batching window is needed.",
    limit: Setting.hard(`${Aws.docs.lambda}services-sqs-parameters.html`)
  }),
  batchWindow: Setting.duration({
    default: 0,
    min: 0,
    max: "5 minutes",
    label: "Batching window",
    help: "How long to wait for a batch to fill. Standard queues only.",
    limit: Setting.hard(`${Aws.docs.lambda}services-sqs-parameters.html`)
  }),
  maxConcurrency: Setting.int({
    default: 0,
    min: 0,
    max: 1_000,
    unit: "invocations",
    label: "Maximum concurrency",
    help: "Cap on concurrent invocations from this queue. 0 for none (the mapping then scales up to 1,250).",
    limit: Setting.hard(`${Aws.docs.lambda}services-sqs-scaling.html`, "AWS accepts 2 to 1,000.")
  }),
  initialConcurrency: Setting.int({ default: 5, min: 1, max: 1_250, unit: "invocations", label: "Starting concurrency", help: "A standard queue's mapping starts with 5 concurrent batches.", limit: Setting.hard(`${Aws.docs.lambda}services-sqs-scaling.html`) }),
  scaleUpPerMinute: Setting.int({ default: 300, min: 0, max: 10_000, unit: "per minute", label: "Scale-up rate", help: "Invocations added each minute while messages are waiting, up to 1,250.", limit: Setting.hard(`${Aws.docs.lambda}services-sqs-scaling.html`) })
})

interface Entry {
  readonly id: number
  readonly message: Message
  readonly group: string
  /** When this queue accepted it; retention counts from here. */
  readonly enqueuedAt: number
  receives: number
  /** The delivery (batch) that currently owns it. Acks from older deliveries no longer count. */
  receipt: number
  status: "delayed" | "ready" | "hidden" | "gone"
}

interface Group {
  readonly id: string
  /** Waiting messages in order. */
  items: Array<Entry>
  /** Messages in flight. A FIFO group delivers nothing while any are. */
  hidden: number
  /** Whether the group is already waiting in the `available` queue. */
  queued: boolean
}

export const Sqs = Aws.component({
  type: "aws.sqs",
  service: "SQS",
  title: "SQS queue",
  description:
    "Durable queue. Standard (at-least-once, effectively unlimited throughput) or FIFO (ordered per message group, rate-limited). Visibility timeout, redelivery, retention and dead-letter redrive.",
  docs: `${D}quotas.html`,
  category: "messaging",
  icon: "queue",
  accent: "#d9531e",
  limits: [
    { label: "Message size", value: "1 MiB", adjustable: false, source: `${D}quotas-messages.html`, note: "The general reference page still shows 256 KB; the developer guide says 1 MiB." },
    { label: "Receive/send batch", value: "10 messages", adjustable: false, source: `${D}quotas-messages.html` },
    { label: "Long poll wait", value: "20 s maximum", adjustable: false, source: `${D}quotas-queues.html` },
    { label: "FIFO throughput (normal mode)", value: "300 API calls/s per action, 3,000 messages/s with batching", adjustable: false, source: `${D}high-throughput-fifo.html` },
    { label: "Standard queue throughput", value: "Nearly unlimited; AWS publishes no number", adjustable: false, source: `${D}quotas-messages.html` },
    { label: "FIFO deduplication window", value: "5 minutes (not modelled)", adjustable: false, source: `${D}using-messagededuplicationid-property.html` }
  ],
  highlights: [
    { gauge: "depth", label: "waiting" },
    { gauge: "hidden", label: "in flight" },
    { rate: "redelivered", label: "redeliv./s" },
    { gauge: "oldestAgeMs", label: "oldest", format: "ms" }
  ],
  config: Schema.Struct({
    kind: Setting.choice(["standard", "fifo"], { default: "standard", labels: { standard: "Standard", fifo: "FIFO" }, help: "FIFO delivers one message per message group at a time, and is rate-limited." }),
    retention: Setting.duration({ default: "4 days", min: "1 minute", max: "14 days", label: "Message retention", limit: Setting.hard(`${D}quotas-messages.html`) }),
    visibilityTimeout: Setting.duration({
      default: "30 seconds",
      min: 0,
      max: "12 hours",
      label: "Visibility timeout",
      help: "A delivered message stays hidden this long. If it isn't deleted in time it is delivered again. AWS suggests at least six times a Lambda consumer's timeout.",
      limit: Setting.hard(`${D}quotas-messages.html`)
    }),
    delay: Setting.duration({ default: 0, min: 0, max: "15 minutes", label: "Delivery delay", help: "New messages stay invisible this long.", limit: Setting.hard(`${D}sqs-delay-queues.html`) }),
    maxReceives: Setting.int({
      default: 5,
      min: 1,
      max: 1_000,
      label: "Max receives",
      help: "With a dead-letter queue connected: after this many deliveries without a delete, the message moves there. Without one, messages are retried until retention ends.",
      limit: Setting.hard(`${D}sqs-configure-dead-letter-queue.html`)
    }),
    inFlightLimit: Setting.int({
      default: 120_000,
      min: 1,
      max: 10_000_000,
      unit: "messages",
      label: "In-flight limit",
      help: "Messages delivered but not yet deleted. At the limit, consumers receive nothing until it drops.",
      limit: Setting.quota(`${D}quotas-queues.html`)
    }),
    highThroughput: Setting.bool({ default: false, label: "FIFO high throughput", help: "FIFO only. Raises the rate limit to the region's high-throughput quota (set in the account quotas)." })
  }),
  ports: {
    deliver: Component.port.many("Consumers", Consumer),
    dlq: Component.port.one("Dead letter")
  },
  state: Schema.Struct({
    ready: Schema.Number,
    hidden: Schema.Number,
    delayed: Schema.Number,
    oldestAge: Schema.Number,
    totals: Schema.Struct({
      enqueued: Schema.Number,
      deleted: Schema.Number,
      redelivered: Schema.Number,
      deadLettered: Schema.Number,
      expired: Schema.Number,
      duplicates: Schema.Number,
      throttled: Schema.Number
    }),
    /** FIFO: message groups with waiting messages, and how many are blocked behind a message in flight. */
    groups: Schema.Struct({ waiting: Schema.Number, blocked: Schema.Number }),
    sample: Schema.Array(Schema.Struct({ id: Schema.Number, group: Schema.String, receives: Schema.Number, age: Schema.Number, status: Schema.String }))
  }),
  make: (node) =>
    Effect.sync(() => {
      const { fast } = node
      const entries = new Map<number, Entry>()
      const groups = new Map<string, Group>()
      /** Standard queue: messages that can be delivered, in the order they became ready. */
      const standardReady = new Deque<Entry>()
      /** FIFO: groups with waiting messages and nothing in flight. */
      const availableGroups = new Deque<Group>()
      const counts = { ready: 0, hidden: 0, delayed: 0 }
      const totals = { enqueued: 0, deleted: 0, redelivered: 0, deadLettered: 0, expired: 0, duplicates: 0, throttled: 0 }
      const expired = node.meter.counter("expired")
      const deadLettered = node.meter.counter("deadLettered")
      const dlqFailed = node.meter.counter("dlqFailed")
      const redelivered = node.meter.counter("redelivered")
      const nacks = node.meter.counter("nacks")
      const deletedCount = node.meter.counter("deleted")
      const duplicatesCount = node.meter.counter("duplicates")
      let ids = 0
      let receipts = 0
      const isFifo = fast.settings().kind === "fifo"

      const group = (id: string): Group => {
        let g = groups.get(id)
        if (g === undefined) {
          g = { id, items: [], hidden: 0, queued: false }
          groups.set(id, g)
        }
        return g
      }
      /** Offer a FIFO group for delivery if it has waiting messages and nothing in flight. */
      const release = (g: Group): void => {
        if (g.hidden === 0 && g.items.length > 0 && !g.queued) {
          g.queued = true
          availableGroups.push(g)
        }
      }

      /** A message becomes deliverable (new, delay over, or redelivered). `front` puts redeliveries ahead of their group. */
      const makeReady = (ready: ReadonlyArray<Entry>, front: boolean): void => {
        for (const entry of ready) {
          entry.status = "ready"
          counts.ready++
        }
        if (!isFifo) {
          for (const entry of ready) standardReady.push(entry)
        } else {
          const g = group(ready[0]!.group)
          if (front) g.items.unshift(...ready)
          else g.items.push(...ready)
          release(g)
        }
        pump()
      }

      node.meter.gaugeUnsafe("depth", () => counts.ready)
      node.meter.gaugeUnsafe("hidden", () => counts.hidden)
      node.meter.gaugeUnsafe("delayed", () => counts.delayed)
      const oldestAge = (): number => {
        const t = fast.now()
        let oldest = Infinity
        for (const e of entries.values()) if (e.status === "ready" && e.enqueuedAt < oldest) oldest = e.enqueuedAt
        return oldest === Infinity ? 0 : t - oldest
      }
      node.meter.gaugeUnsafe("oldestAgeMs", oldestAge)

      // --- Retention: messages older than the retention period are deleted --------------------------------------
      const sweep = (): void => {
        const retention = Duration.toMillis(fast.settings().retention)
        const t = fast.now()
        for (const e of [...entries.values()]) {
          if (e.status === "hidden" || t - e.enqueuedAt < retention) continue
          if (e.status === "ready") counts.ready--
          else counts.delayed--
          e.status = "gone"
          entries.delete(e.id)
          totals.expired++
          expired.n++
          if (isFifo) {
            const g = groups.get(e.group)
            if (g !== undefined) g.items = g.items.filter((x) => x !== e)
          }
        }
        fast.after(5_000, sweep, undefined)
      }
      fast.after(5_000, sweep, undefined)

      // --- Delivery ----------------------------------------------------------------------------------------------
      /** The visibility timeout lapsed for a delivery: return what is still unacknowledged, or dead-letter it. */
      const lapse = (delivery: Delivery): void => {
        const { maxReceives, kind } = fast.settings()
        const dlq = node.out("dlq")[0]
        const back: Array<Entry> = []
        for (const entry of delivery.batch) {
          if (entry.status !== "hidden" || entry.receipt !== delivery.receipt) continue
          entry.status = "gone"
          counts.hidden--
          if (isFifo) group(entry.group).hidden--
          if (dlq !== undefined && entry.receives >= maxReceives) {
            entries.delete(entry.id)
            totals.deadLettered++
            deadLettered.n++
            // A standard queue's dead-letter queue keeps counting retention from the original enqueue time; FIFO restarts it.
            const forwarded = kind === "standard" ? { ...entry.message, firstEnqueuedAt: entry.enqueuedAt } : { ...entry.message, firstEnqueuedAt: undefined }
            dlq.send(forwarded as Message, (failure) => {
              if (failure !== undefined) dlqFailed.n++
            })
          } else {
            entry.status = "ready"
            back.push(entry)
            totals.redelivered++
            redelivered.n++
          }
        }
        if (back.length > 0) {
          for (const e of back) e.status = "gone"
          makeReady(back, true)
        } else {
          if (isFifo) for (const entry of delivery.batch) release(group(entry.group))
          pump()
        }
      }

      // --- Pollers: an event source mapping's concurrent receivers, as small state machines ----------------------
      // A poller is idle, gathering a batch (holding some messages while it waits for more, up to the batching window), or
      // busy with a delivery. There is no fiber behind any of them: messages are handed to pollers as they become ready.
      const consumers: Array<Consumer_> = node.out("deliver").map((link) => {
        const mapping = SubscriptionRef.getUnsafe(link.config)
        return { link, ramp: mapping.initialConcurrency, target: mapping.initialConcurrency, pollers: [], idle: [], gathering: [] }
      })

      const nextStandard = (): Entry | undefined => {
        for (;;) {
          const e = standardReady.shift()
          if (e === undefined || e.status === "ready") return e
        }
      }

      const hasWork = (): boolean => (isFifo ? availableGroups.length > 0 : standardReady.length > 0)

      /** Move messages into a poller's batch. Returns true if it should be launched now. */
      const fill = (p: Poller, size: number, window: number): boolean => {
        if (isFifo) {
          while (availableGroups.length > 0) {
            const g = availableGroups.shift()!
            g.queued = false
            if (g.hidden > 0 || g.items.length === 0) continue
            p.batch = g.items.splice(0, Math.min(size, API_BATCH)).filter((e) => e.status === "ready")
            return true
          }
          return false
        }
        while (p.batch.length < size && p.bytes < MAX_BATCH_BYTES) {
          const e = nextStandard()
          if (e === undefined) break
          p.batch.push(e)
          p.bytes += e.message.bytes
        }
        return p.batch.length >= size || p.bytes >= MAX_BATCH_BYTES || (p.batch.length > 0 && window <= 0)
      }

      const launch = (consumer: Consumer_, p: Poller): void => {
        p.timer?.cancel()
        p.timer = undefined
        const at = consumer.gathering.indexOf(p)
        if (at >= 0) consumer.gathering.splice(at, 1)
        const batch = p.batch.filter((e) => e.status === "ready")
        p.batch = []
        p.bytes = 0
        if (batch.length === 0) {
          consumer.idle.push(p)
          return
        }
        const c = fast.settings()
        const receipt = ++receipts
        for (const entry of batch) {
          entry.status = "hidden"
          entry.receipt = receipt
          entry.receives++
          counts.ready--
          counts.hidden++
          if (isFifo) group(entry.group).hidden++
        }
        const delivery: Delivery = { batch, receipt, timer: undefined }
        delivery.timer = fast.after(Duration.toMillis(c.visibilityTimeout), lapse, delivery)
        const mapping = SubscriptionRef.getUnsafe(consumer.link.config)
        const first = batch[0]!.message
        let count = 0
        let bytes = 0
        let attempt = 0
        for (const e of batch) {
          count += e.message.count
          bytes += e.message.bytes
          if (e.receives > attempt) attempt = e.receives
        }
        consumer.link.send({ ...first, count, bytes: Math.min(MAX_BATCH_BYTES, bytes), attempt, invocation: "sync" }, (failure) => {
          if (failure === undefined) {
            // Only the delivery that currently owns a message may delete it. A slow consumer that finishes after the
            // visibility timeout already caused a redelivery has done the work twice.
            let deleted = 0
            for (const entry of batch) {
              if (entry.receipt === receipt && entry.status === "hidden") {
                entry.status = "gone"
                entries.delete(entry.id)
                counts.hidden--
                totals.deleted++
                deleted++
                if (isFifo) group(entry.group).hidden--
              } else totals.duplicates++
            }
            deletedCount.n += deleted
            if (deleted < batch.length) duplicatesCount.n += batch.length - deleted
            if (deleted > 0) delivery.timer?.cancel()
            if (isFifo) for (const g of new Set(batch.map((e) => group(e.group)))) release(g)
          } else {
            nacks.n++
            // A throttled consumer makes the mapping back off.
            consumer.ramp = Math.max(mapping.initialConcurrency, consumer.ramp * 0.9)
          }
          consumer.idle.push(p)
          pump()
        })
      }

      let pumping = false
      /** Hand ready messages to idle and gathering pollers until there is nobody to take them or nothing to give. */
      function pump(): void {
        if (pumping) return
        pumping = true
        try {
          const limit = fast.settings().inFlightLimit
          for (const consumer of consumers) {
            const mapping = SubscriptionRef.getUnsafe(consumer.link.config)
            const size = isFifo ? Math.min(mapping.batchSize, API_BATCH) : mapping.batchSize
            const window = isFifo ? 0 : Duration.toMillis(mapping.batchWindow)
            // Pollers already holding part of a batch take new messages first.
            for (const p of [...consumer.gathering]) {
              if (!hasWork()) break
              if (fill(p, size, window)) launch(consumer, p)
            }
            // At the in-flight limit a receive returns nothing, so no idle poller starts a batch.
            while (hasWork() && counts.hidden < limit) {
              const p = consumer.idle.pop()
              if (p === undefined) break
              if (p.index >= consumer.target) {
                p.alive = false // scaled down: retire
                continue
              }
              if (fill(p, size, window)) launch(consumer, p)
              else if (p.batch.length > 0) {
                // Wait for the batch to fill, up to the window.
                consumer.gathering.push(p)
                p.timer = fast.after(window, () => {
                  p.timer = undefined
                  launch(consumer, p)
                  pump()
                }, undefined)
              } else consumer.idle.push(p)
            }
          }
        } finally {
          pumping = false
        }
      }

      // Each consumer edge gets pollers: it starts small and scales up while messages wait, like an event source mapping.
      const ensurePollers = (consumer: Consumer_): void => {
        for (let i = 0; i < consumer.target; i++) {
          let p = consumer.pollers[i]
          if (p === undefined) {
            p = { index: i, alive: false, batch: [], bytes: 0, timer: undefined }
            consumer.pollers[i] = p
          }
          if (!p.alive) {
            p.alive = true
            consumer.idle.push(p)
          }
        }
      }
      for (const consumer of consumers) {
        ensurePollers(consumer)
        const rescale = (): void => {
          const m = SubscriptionRef.getUnsafe(consumer.link.config)
          // Backlog means more waiting than the pollers already running could take in a pass.
          const pressure = counts.ready > consumer.target * m.batchSize
          consumer.ramp = pressure ? consumer.ramp + m.scaleUpPerMinute / 60 : Math.max(m.initialConcurrency, consumer.ramp - Math.max(1, (consumer.ramp - m.initialConcurrency) * 0.1))
          const cap = m.maxConcurrency > 0 ? m.maxConcurrency : ESM_CEILING
          const next = Math.max(1, Math.floor(Math.min(consumer.ramp, cap, ESM_CEILING)))
          if (next !== consumer.target) {
            consumer.target = next
            ensurePollers(consumer)
            pump()
          }
          fast.after(1_000, rescale, undefined)
        }
        fast.after(1_000, rescale, undefined)
      }

      return {
        call: (message) => {
          const c = fast.settings()
          if (message.bytes > MAX_MESSAGE) return Effect.fail(Rejected({ node: node.id, reason: "message over the 1 MiB limit" }))
          if (c.kind === "fifo") {
            const account = fast.account() as Aws.Account
            const rate = c.highThroughput ? account.sqsFifoHighThroughput : FIFO_NORMAL_TPS
            if (!node.limiter.takeUnsafe(`${node.id}/fifo`, { rate, burst: rate }, Math.ceil(message.count / API_BATCH))) {
              totals.throttled++
              return Effect.fail(Throttled({ node: node.id, reason: "FIFO throughput limit" }))
            }
          }
          const t = fast.now()
          const accepted: Array<Entry> = []
          for (let i = 0; i < message.count; i++) {
            const entry: Entry = {
              id: ++ids,
              message: message.count === 1 ? message : { ...message, count: 1, bytes: Math.max(1, Math.round(message.bytes / message.count)) },
              group: message.group ?? "default",
              enqueuedAt: c.kind === "standard" && message.firstEnqueuedAt !== undefined ? message.firstEnqueuedAt : t,
              receives: 0,
              receipt: 0,
              status: "delayed"
            }
            entries.set(entry.id, entry)
            accepted.push(entry)
            totals.enqueued++
          }
          const delay = Duration.toMillis(c.delay)
          if (delay > 0) {
            counts.delayed += accepted.length
            fast.after(delay, () => {
              const waiting = accepted.filter((e) => e.status === "delayed")
              counts.delayed -= waiting.length
              if (waiting.length > 0) makeReady(waiting, false)
            }, undefined)
          } else makeReady(accepted, false)
          return Effect.void
        },
        probe: Effect.sync(() => {
          const t = fast.now()
          const sample = []
          for (const e of entries.values()) {
            if (sample.length >= SAMPLE) break
            sample.push({ id: e.id, group: e.group, receives: e.receives, age: t - e.enqueuedAt, status: e.status })
          }
          let waiting = 0
          let blocked = 0
          for (const g of groups.values()) {
            if (g.items.length > 0) waiting++
            if (g.hidden > 0 && g.items.length > 0) blocked++
          }
          return { ...counts, oldestAge: oldestAge(), totals: { ...totals }, groups: { waiting, blocked }, sample }
        })
      }
    })
})

/** One delivery to a consumer: the messages it carries, and the timer that returns them if nobody deletes them in time. */
interface Delivery {
  readonly batch: ReadonlyArray<Entry>
  readonly receipt: number
  timer: TimerHandle | undefined
}

/** A concurrent receiver of an event source mapping. */
interface Poller {
  readonly index: number
  alive: boolean
  batch: Array<Entry>
  bytes: number
  timer: TimerHandle | undefined
}

/** A consumer edge: the mapping that polls the queue for it, and the pollers it has running. */
interface Consumer_ {
  readonly link: Edge.Link<Edge.Config & typeof Consumer.Type>
  ramp: number
  target: number
  readonly pollers: Array<Poller>
  idle: Array<Poller>
  gathering: Array<Poller>
}

/** A queue with a moving head: cheap to take from the front. */
class Deque<T> {
  private items: Array<T> = []
  private head = 0

  get length(): number {
    return this.items.length - this.head
  }

  push(item: T): void {
    this.items.push(item)
  }

  shift(): T | undefined {
    if (this.head >= this.items.length) return undefined
    const item = this.items[this.head++]
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head)
      this.head = 0
    }
    return item
  }
}
