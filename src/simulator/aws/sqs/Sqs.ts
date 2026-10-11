import { Duration, Effect, Schema } from "effect"
import * as Component from "../../Component.ts"
import { Rejected, Throttled } from "../../Message.ts"
import * as Aws from "../provider.ts"
import {
  API_BATCH,
  Consumer,
  MAX_MESSAGE_BYTES,
  Queue,
  SWEEP_MS
} from "./config.ts"
import { DedupWindow } from "./dedup.ts"
import { Deliveries } from "./delivery.ts"
import { type ConsumerLink, Pollers } from "./mapping.ts"
import { makeTallies } from "./metrics.ts"
import { Redrive } from "./redrive.ts"
import { QueueStore } from "./store.ts"
import { FifoRate, fifoRate, takePartition } from "./throughput.ts"
import type { Entry } from "./types.ts"

const D = Aws.docs.sqs
/** The probe lists this many messages. */
const SAMPLE = 20

export const Sqs = Aws.component({
  type: "aws.sqs",
  service: "SQS",
  title: "SQS queue",
  description:
    "Durable queue. Standard (at-least-once, effectively unlimited throughput) or FIFO (ordered per message group, rate-limited, optionally deduplicated). Visibility timeout, redelivery, retention, dead-letter queues and redrive, and the Lambda event source mapping that polls it.",
  docs: `${D}quotas.html`,
  category: "messaging",
  icon: "queue",
  accent: "#d9531e",
  limits: [
    { label: "Message size", value: "1 MiB", adjustable: false, source: `${D}quotas-messages.html`, note: "The general reference page still shows 256 KB; the developer guide says 1 MiB." },
    { label: "Send/receive/delete batch", value: "10 messages", adjustable: false, source: `${D}quotas-messages.html` },
    { label: "Long poll wait", value: "20 s maximum", adjustable: false, source: `${D}quotas-queues.html` },
    { label: "FIFO throughput (normal mode)", value: "300 API calls/s per action, 3,000 messages/s with batching", adjustable: false, source: `${D}quotas-messages.html` },
    { label: "FIFO throughput (high-throughput mode)", value: "the region's quota, set in the account quotas; one message group is held to one partition's 300 calls/s", adjustable: true, source: `${D}quotas-messages.html` },
    { label: "Standard queue throughput", value: "Nearly unlimited; AWS publishes no number", adjustable: false, source: `${D}quotas-messages.html` },
    { label: "FIFO deduplication window", value: "5 minutes", adjustable: false, source: `${D}using-messagededuplicationid-property.html` },
    { label: "Visibility timeout", value: "up to 12 hours from the first receive (changing it per message isn't modelled)", adjustable: false, source: `${D}sqs-visibility-timeout.html` },
    { label: "Redrive velocity", value: "up to 500 messages/s (custom)", adjustable: false, source: `${D}sqs-configure-dead-letter-queue-redrive.html` }
  ],
  highlights: [
    { gauge: "depth", label: "waiting" },
    { gauge: "hidden", label: "in flight" },
    { rate: "redelivered", label: "redeliv./s" },
    { gauge: "oldestAgeMs", label: "oldest", format: "ms" }
  ],
  config: Queue,
  ports: {
    deliver: Component.port.many("Consumers", Consumer),
    dlq: Component.port.one("Dead letter"),
    redrive: Component.port.one("Redrive")
  },
  state: Schema.Struct({
    ready: Schema.Number,
    hidden: Schema.Number,
    delayed: Schema.Number,
    oldestAge: Schema.Number,
    totals: Schema.Struct({
      enqueued: Schema.Number,
      sent: Schema.Number,
      received: Schema.Number,
      deleted: Schema.Number,
      redelivered: Schema.Number,
      deadLettered: Schema.Number,
      expired: Schema.Number,
      duplicates: Schema.Number,
      deduplicated: Schema.Number,
      redriven: Schema.Number,
      throttled: Schema.Number
    }),
    /** FIFO: message groups with waiting messages, how many are blocked behind a message in flight, and how many have one in flight. */
    groups: Schema.Struct({ waiting: Schema.Number, blocked: Schema.Number, inflight: Schema.Number }),
    /** One per consumer: the concurrency its event source mapping is running at now, and how much of it is in use. */
    consumers: Schema.Array(Schema.Struct({ concurrency: Schema.Number, busy: Schema.Number })),
    /** Messages whose move to the dead-letter queue was refused and is being retried. */
    parked: Schema.Number,
    sample: Schema.Array(Schema.Struct({ id: Schema.Number, group: Schema.String, receives: Schema.Number, age: Schema.Number, status: Schema.String }))
  }),
  make: (node) =>
    Effect.gen(function*() {
      const { fast } = node
      // The type is fixed when a queue is created: a standard queue can't become a FIFO one, so this is read once.
      const fifo = fast.settings().kind === "fifo"
      /**
       * Messages a queue sends to another queue itself (dead-letter moves, redrive), by id. The receiving queue treats
       * them as internal: they don't count as sent, aren't throttled by the FIFO API limit and aren't deduplicated, because
       * in AWS they never go through the API. Shared by every queue in the placement.
       */
      const transit = yield* node.shared("sqs/transit", Effect.sync(() => new Set<number>()))

      const store = new QueueStore(fifo)
      const tallies = makeTallies(node.meter)
      const dedup = new DedupWindow()
      const sendRate = new FifoRate(`${node.id}/fifo`, node.limiter)
      const receiveRate = new FifoRate(`${node.id}/fifo-receive`, node.limiter)

      const deliveries = new Deliveries({
        store,
        fast,
        tallies,
        dlq: () => node.out("dlq")[0],
        transit,
        wake: () => pollers.pump()
      })
      const pollers = new Pollers({ store, fast, receiveRate, tallies, deliveries, links: node.out("deliver") as ReadonlyArray<ConsumerLink> })
      const redrive = new Redrive({ store, fast, tallies, deliveries, destination: () => node.out("redrive")[0], transit })

      // The gauges, named after the CloudWatch metric each stands in for.
      node.meter.gaugeUnsafe("depth", () => store.counts.ready) // ApproximateNumberOfMessagesVisible
      node.meter.gaugeUnsafe("hidden", () => store.counts.hidden) // ApproximateNumberOfMessagesNotVisible
      node.meter.gaugeUnsafe("delayed", () => store.counts.delayed) // ApproximateNumberOfMessagesDelayed
      node.meter.gaugeUnsafe("oldestAgeMs", () => store.oldestAgeMs(fast.now())) // ApproximateAgeOfOldestMessage
      if (fifo) node.meter.gaugeUnsafe("groupsInflight", () => store.inflightGroups) // ApproximateNumberOfGroupsWithInflightMessages

      // Retention: a message is deleted once it has been in the queue as long as the retention period, whatever its state.
      const sweep = (): void => {
        let expired = 0
        store.index.sweep(fast.now() - Duration.toMillis(fast.settings().retention), (entry) => {
          store.remove(entry)
          expired++
        })
        if (expired > 0) {
          tallies.expired.add(expired)
          pollers.pump() // a FIFO group whose in-flight message just expired can be received from again
        }
        fast.after(SWEEP_MS, sweep, undefined)
      }
      fast.after(SWEEP_MS, sweep, undefined)

      pollers.start()
      redrive.start()

      /** The delay is over for these messages. */
      const activate = (entries: ReadonlyArray<Entry>): void => {
        for (const entry of entries) store.activate(entry)
        pollers.pump()
      }

      return {
        call: (message) => {
          const c = fast.settings()
          const internal = transit.size > 0 && transit.delete(message.id)
          if (message.bytes > MAX_MESSAGE_BYTES) return Effect.fail(Rejected({ node: node.id, reason: "message over the 1 MiB limit" }))
          // A call with no records (or a nonsensical count) sends nothing.
          const records = message.count > 0 ? message.count : 0
          if (records === 0) return Effect.void
          const now = fast.now()

          if (fifo && !internal) {
            const calls = Math.ceil(records / API_BATCH)
            if (!sendRate.take(fifoRate(c, fast.account() as Aws.Account), calls)) {
              tallies.throttled.add(records)
              return Effect.fail(Throttled({ node: node.id, reason: "FIFO throughput limit" }))
            }
            // A group lives on one partition, which takes 300 calls a second. Messages with no group aren't spread over
            // groups, so they have no partition of their own to hold to.
            if (c.highThroughput && message.group !== undefined) {
              const g = store.group(message.group)
              const allowed = takePartition(g, calls, now)
              store.dropIfEmpty(g)
              if (!allowed) {
                tallies.throttled.add(records)
                return Effect.fail(Throttled({ node: node.id, reason: "FIFO message group limit" }))
              }
            }
            if (c.deduplication && dedup.isDuplicate(message.id, now)) {
              // Acknowledged, but not enqueued again.
              tallies.deduplicated.add(records)
              return Effect.void
            }
          }

          // A message a standard queue's redrive policy moved here keeps counting retention from its original enqueue time.
          const enqueuedAt = !fifo && message.firstEnqueuedAt !== undefined ? message.firstEnqueuedAt : now
          const bytes = Math.max(1, Math.round(message.bytes / records))
          const delay = internal ? 0 : Duration.toMillis(c.delay)
          if (delay > 0) {
            const waiting: Array<Entry> = []
            for (let i = 0; i < records; i++) waiting.push(store.admit(message, bytes, enqueuedAt, true))
            fast.after(delay, activate, waiting)
          } else {
            for (let i = 0; i < records; i++) store.admit(message, bytes, enqueuedAt, false)
            pollers.pump()
          }
          tallies.enqueued.add(records)
          if (!internal) tallies.sent.add(records)
          return Effect.void
        },
        probe: Effect.sync(() => {
          const now = fast.now()
          const totals = {
            enqueued: tallies.enqueued.total,
            sent: tallies.sent.total,
            received: tallies.received.total,
            deleted: tallies.deleted.total,
            redelivered: tallies.redelivered.total,
            deadLettered: tallies.deadLettered.total,
            expired: tallies.expired.total,
            duplicates: tallies.duplicates.total,
            deduplicated: tallies.deduplicated.total,
            redriven: tallies.redriven.total,
            throttled: tallies.throttled.total
          }
          const { waiting, blocked } = store.groupStats()
          return {
            ...store.counts,
            oldestAge: store.oldestAgeMs(now),
            totals,
            groups: { waiting, blocked, inflight: store.inflightGroups },
            consumers: pollers.status(),
            parked: deliveries.parkedCount,
            sample: store.index.first(SAMPLE).map((e) => ({ id: e.id, group: e.group?.id ?? e.message.group ?? "default", receives: e.receives, age: now - e.enqueuedAt, status: e.status }))
          }
        })
      }
    })
})
