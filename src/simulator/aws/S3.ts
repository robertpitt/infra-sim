import { Effect, Schema } from "effect"
import * as Component from "../Component.ts"
import * as Distribution from "../Distribution.ts"
import * as Edge from "../Edge.ts"
import * as Flow from "../Flow.ts"
import { type Message, Rejected, Throttled } from "../Message.ts"
import * as Setting from "../Setting.ts"
import * as Aws from "./provider.ts"

const D = "https://docs.aws.amazon.com/AmazonS3/latest/userguide/"
const QUOTAS = "https://docs.aws.amazon.com/general/latest/gr/s3.html"

/**
 * Requests per second a single partitioned prefix is guaranteed. S3 says "at least" these and scales a busy prefix on
 * its own (gradually, with 503 Slow Down while it does), with no limit on how many prefixes a bucket has. The
 * simulator takes them as the steady rate of one prefix and spreads load across prefixes by the key, so the number of
 * prefixes is the design choice that matters. PUT, COPY, POST and DELETE share one allowance; GET and HEAD another.
 */
const PREFIX = { read: 5_500, write: 3_500 } as const
/** One PutObject carries at most 5 GB; bigger objects need a multipart upload, which this component does not model. */
const SINGLE_PUT_MAX_BYTES = 5 * 1024 ** 3
const MB = 1024 * 1024
/** What an event notification weighs once it reaches a queue or a function: a small JSON record. Assumed. */
const EVENT_BYTES = 1_024

/** What an event notification destination retries like. AWS documents "at least once" delivery, not the schedule. */
const Destination = Schema.Struct({
  retry: Edge.retryWith({ maxAttempts: 10, backoff: "1 second", backoffFactor: 2, maxBackoff: "20 seconds", jitter: true })
})

export const S3 = Aws.component({
  type: "aws.s3",
  service: "S3",
  title: "S3 bucket",
  description:
    "Object storage. Reads and writes are limited per key prefix (a hot prefix gets 503 Slow Down), take a first-byte delay plus time to move the bytes, and writes publish event notifications.",
  docs: D,
  category: "storage",
  icon: "bucket",
  accent: "#3f8624",
  limits: [
    { label: "Request rate per prefix", value: "3,500 PUT/COPY/POST/DELETE and 5,500 GET/HEAD per second", adjustable: false, source: `${D}optimizing-performance.html`, note: "A floor ('at least'): S3 partitions a busy prefix over time, so the real ceiling grows gradually. Modelled as a fixed per-prefix rate." },
    { label: "Prefixes per bucket", value: "unlimited; throughput scales with the number of prefixes", adjustable: false, source: `${D}optimizing-performance.html` },
    { label: "Over the rate", value: "HTTP 503 Slow Down, which clients retry with backoff", adjustable: false, source: `${D}optimizing-performance-design-patterns.html` },
    { label: "Consistency", value: "strong read-after-write for PUT, overwrite and DELETE; a read after a successful write sees it", adjustable: false, source: `${D}Welcome.html#ConsistencyModel`, note: "Always true here; there is no stale read to model." },
    { label: "Single PUT", value: "5 GB", adjustable: false, source: `${D}upload-objects.html`, note: "Larger objects need multipart upload, which is not modelled; they are rejected." },
    { label: "Object size", value: "48.8 TiB (about 50 TB) with multipart upload", adjustable: false, source: `${D}qfacts.html`, note: "Older docs said 5 TB; the quotas page now says 48.828125 TB." },
    { label: "Multipart parts", value: "10,000 parts of 5 MiB to 5 GiB (the last may be smaller)", adjustable: false, source: `${D}qfacts.html` },
    { label: "Event notifications", value: "at-least-once, typically within seconds, sometimes a minute or longer; to SNS, SQS, Lambda or EventBridge", adjustable: false, source: `${D}EventNotifications.html` },
    { label: "Notification configurations", value: "100 per bucket", adjustable: false, source: QUOTAS },
    { label: "General purpose buckets", value: "10,000 per account", adjustable: true, source: QUOTAS },
    { label: "First-byte latency", value: "roughly 100 to 200 ms for latency-sensitive workloads; median tens of ms for small objects", adjustable: false, source: `${D}optimizing-performance.html`, note: "AWS publishes no distribution; the one here is assumed." },
    { label: "Throughput per connection", value: "not published today", adjustable: false, source: `${D}optimizing-performance-guidelines.html`, note: "AWS advises many parallel connections. The default rate here (about 90 MB/s) is assumed from older guidance." }
  ],
  highlights: [
    { rate: "fail.Throttled", label: "503/s" },
    { gauge: "transferring", label: "transferring" },
    { gauge: "pending", label: "notifying" }
  ],
  config: Schema.Struct({
    prefixes: Setting.int({
      default: 1,
      min: 1,
      max: 100_000,
      label: "Key prefixes",
      help: "How many distinct prefixes the requests spread over. Each prefix gets its own 3,500 write and 5,500 read requests a second. A hot key always lands on one prefix."
    }),
    deleteShare: Setting.ratio({
      default: 0,
      label: "Writes that are deletes",
      help: "Share of write calls that are DELETEs: no body, same per-prefix allowance as PUT, and an object-removed event instead of object-created."
    }),
    readLatency: Setting.latency({
      mean: "40 millis",
      cv: 1,
      label: "First-byte latency (read)",
      help: "Time until the first byte of a GET or HEAD. AWS says roughly 100 to 200 ms for consistent latency and tens of ms median; a spread of about that is an assumption."
    }),
    writeLatency: Setting.latency({
      mean: "70 millis",
      cv: 0.8,
      label: "First-byte latency (write)",
      help: "Time until S3 starts accepting the body of a PUT or answers a DELETE. An assumption: AWS publishes no figure."
    }),
    transferRate: Setting.number({
      default: 90,
      min: 1,
      max: 12_500,
      step: 1,
      unit: "MB/s",
      label: "Transfer rate per request",
      help: "How fast one request moves its bytes, so a large object takes bytes / rate longer. About 90 MB/s per connection is older AWS guidance; AWS now advises parallel connections, and an instance can reach 100 Gb/s (12,500 MB/s)."
    }),
    notificationDelay: Setting.latency({
      mean: "1500 millis",
      cv: 1,
      label: "Event notification delay",
      help: "AWS says events are typically delivered in seconds but can take a minute or longer. The distribution is an assumption."
    })
  }),
  ports: { events: Component.port.many("Event notifications", Destination) },
  state: Schema.Struct({
    prefixes: Schema.Number,
    served: Schema.Struct({ reads: Schema.Number, writes: Schema.Number, deletes: Schema.Number }),
    throttled: Schema.Struct({ reads: Schema.Number, writes: Schema.Number }),
    /** Requests currently moving bytes. */
    transferring: Schema.Number,
    notifications: Schema.Struct({ destinations: Schema.Number, pending: Schema.Number, delivered: Schema.Number, undelivered: Schema.Number })
  }),
  make: (node) =>
    Effect.sync(() => {
      const { fast } = node
      const destinations = node.out("events")
      const served = { reads: 0, writes: 0, deletes: 0 }
      const throttled = { reads: 0, writes: 0 }
      const notifications = { pending: 0, delivered: 0, undelivered: 0 }
      const gets = node.meter.counter("get")
      const puts = node.meter.counter("put")
      const deletes = node.meter.counter("delete")
      const delivered = node.meter.counter("delivered")
      const undelivered = node.meter.counter("undelivered")
      let transferring = 0
      node.meter.gaugeUnsafe("transferring", () => transferring)
      node.meter.gaugeUnsafe("pending", () => notifications.pending)

      // Each destination hears about every change on its own, so a slow one never holds up the others. S3 calls Lambda
      // asynchronously, so deliveries are marked async. The delay is S3's own, before any network hop.
      const notify = (message: Message): void => {
        const c = fast.settings()
        for (const link of destinations) {
          notifications.pending++
          fast.after(Distribution.latencyMs(c.notificationDelay, fast.random), () => {
            link.send({ ...message, bytes: EVENT_BYTES, count: 1, operation: "write", invocation: "async" }, (failure) => {
              notifications.pending--
              if (failure === undefined) {
                notifications.delivered++
                delivered.n++
              } else {
                notifications.undelivered++
                undelivered.n++
              }
            })
          }, undefined)
        }
      }

      return {
        call: (message) => {
          const c = fast.settings()
          const isDelete = message.operation === "write" && c.deleteShare > 0 && fast.random.nextDoubleUnsafe() < c.deleteShare
          const op = message.operation === "read" ? "read" : "write"
          // A DELETE carries no body. A write over 5 GB would need a multipart upload.
          const bytes = isDelete ? 0 : message.bytes
          if (op === "write" && !isDelete && message.bytes / message.count > SINGLE_PUT_MAX_BYTES) {
            return Effect.fail(Rejected({ node: node.id, reason: "EntityTooLarge: a single PUT is limited to 5 GB; use multipart upload" }))
          }

          // Requests land on a prefix by their key. Each prefix has its own allowance, and reads and writes are counted apart.
          const prefixes = c.prefixes
          const index = Math.min(prefixes - 1, Math.floor(message.key * prefixes))
          if (!node.limiter.takeUnsafe(`${node.id}/prefix${index}/${op}`, PREFIX_BUCKET[op], message.count)) {
            op === "read" ? (throttled.reads += message.count) : (throttled.writes += message.count)
            return Effect.fail(Throttled({ node: node.id, reason: "503 Slow Down: reduce your request rate" }))
          }

          // First byte, then the bytes themselves at the rate one request can move them.
          const firstByte = Distribution.latencyMs(op === "read" ? c.readLatency : c.writeLatency, fast.random)
          transferring++
          return Flow.delayed(
            fast,
            firstByte + (bytes / (c.transferRate * MB)) * 1000,
            () => {
              transferring--
              if (op === "read") {
                served.reads += message.count
                gets.n += message.count
              } else if (isDelete) {
                served.deletes += message.count
                deletes.n += message.count
              } else {
                served.writes += message.count
                puts.n += message.count
              }
              // Strongly consistent: the object is visible the moment the call returns. The notification follows later,
              // off the request path.
              if (op === "write" && destinations.length > 0) notify(message)
              return undefined
            },
            () => void transferring--
          )
        },
        probe: Effect.sync(() => ({
          prefixes: fast.settings().prefixes,
          served: { ...served },
          throttled: { ...throttled },
          transferring,
          notifications: { destinations: destinations.length, ...notifications }
        }))
      }
    })
})

const PREFIX_BUCKET = {
  read: { rate: PREFIX.read, burst: PREFIX.read },
  write: { rate: PREFIX.write, burst: PREFIX.write }
} as const
