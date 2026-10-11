import { Duration, Effect, SubscriptionRef } from "effect"
import * as Distribution from "../../Distribution.ts"
import * as Flow from "../../Flow.ts"
import type { Message } from "../../Message.ts"
import { Outbox } from "../../kit/Outbox.ts"
import * as Refuse from "../../kit/Refuse.ts"
import { chance, mix, passes, records } from "../../kit/Shape.ts"
import { counters, tallies, totals } from "../../kit/Tally.ts"
import * as Aws from "../provider.ts"
import { ARCHIVE_CLASSES, config, ports, state } from "./config.ts"
import { carriesBody, isUpload, type Kind, newPlan, plan as planTransfer, tooLarge } from "./transfer.ts"
import { D, DIRECTORY_RATE, EVENT_BYTES, MAX_OBJECT_BYTES, MiB, PREFIX_RATE, QUOTAS } from "./limits.ts"
import { PrefixTable, prefixIndex } from "./prefixes.ts"

/**
 * The most separate notification messages one call fans out into. S3 sends one event per object; a message that
 * stands for thousands of requests (a batch) is sent as this many messages carrying the events between them, so one
 * call can never arm an unbounded number of timers.
 */
const MAX_EVENT_MESSAGES = 100

/**
 * Replicas carry this message group so the destination can tell them from a client's writes: S3 does not replicate a
 * replica again (that needs Batch Replication), which keeps two buckets replicating to each other from looping.
 */
const REPLICA_GROUP = "s3:replica"

const ARCHIVED = new Set<string>(ARCHIVE_CLASSES)

/** Bytes a second at `gbps` gigabits a second, per millisecond. */
const bytesPerMsAt = (gbps: number): number => (gbps * 1e9) / 8 / 1000

export const S3 = Aws.component({
  type: "aws.s3",
  service: "S3",
  title: "S3 bucket",
  description:
    "Object storage. Reads and writes are limited per key prefix (a hot prefix gets 503 Slow Down), take a first-byte delay plus time to move the bytes, and writes publish event notifications and can replicate to another bucket.",
  docs: D,
  category: "storage",
  icon: "bucket",
  accent: "#3f8624",
  limits: [
    { label: "Request rate per prefix", value: `${PREFIX_RATE.write.toLocaleString("en-US")} PUT/COPY/POST/DELETE and ${PREFIX_RATE.read.toLocaleString("en-US")} GET/HEAD per second`, adjustable: false, source: `${D}optimizing-performance.html`, note: "A floor ('at least'): S3 scales a busy prefix gradually. Held at the floor unless Prefix scale-up is on." },
    { label: "Prefixes per bucket", value: "unlimited; throughput scales with the number of prefixes", adjustable: false, source: `${D}optimizing-performance.html` },
    { label: "Over the rate", value: "HTTP 503 Slow Down, which SDKs retry with exponential backoff", adjustable: false, source: `${D}optimizing-performance-design-patterns.html`, note: "A Throttled failure. 500 InternalError is a Failed one: inject it with the Errors fault." },
    { label: "Directory bucket request rate", value: `${DIRECTORY_RATE.write.toLocaleString("en-US")} PUT and ${DIRECTORY_RATE.read.toLocaleString("en-US")} GET per second per bucket`, adjustable: false, source: `${D}s3-express-optimizing-performance-design-patterns.html`, note: "S3 Express One Zone. Directories scale instantly, so there is no per-prefix rate." },
    { label: "Consistency", value: "strong read-after-write for PUT, overwrite, DELETE and LIST; bucket configuration is eventually consistent", adjustable: false, source: `${D}Welcome.html#ConsistencyModel`, note: "Always true here; there is no stale read to model." },
    { label: "Single PUT or COPY", value: "5 GB", adjustable: false, source: `${D}upload-objects.html`, note: "Larger needs multipart upload; refused unless Multipart transfers is on." },
    { label: "Object size", value: "48.8 TiB (10,000 parts of 5 GiB)", adjustable: false, source: `${D}qfacts.html`, note: `${(MAX_OBJECT_BYTES / MiB / 1024 / 1024).toFixed(1)} TiB. Older docs said 5 TB; the quotas page now says 48.828125 TB.` },
    { label: "Multipart parts", value: "10,000 parts of 5 MiB to 5 GiB (the last may be smaller)", adjustable: false, source: `${D}qfacts.html` },
    { label: "Event notifications", value: "at least once, typically within seconds, sometimes a minute or longer; to SNS, SQS (not FIFO), Lambda or EventBridge", adjustable: false, source: `${D}EventNotifications.html` },
    { label: "Notification configurations", value: "100 per bucket", adjustable: false, source: QUOTAS, note: "Not enforced: the simulator does not count the destinations of a bucket." },
    { label: "General purpose buckets", value: "10,000 per account", adjustable: true, source: QUOTAS, note: "An account quota; the design audit warns when a region holds more." },
    { label: "Replication Time Control", value: "99.9% of objects within 15 minutes; 1 Gb/s transfer quota", adjustable: true, source: `${D}replication-time-control.html`, note: "The replication overview page says 99.99%; the RTC page itself says 99.9%." },
    { label: "Glacier restores", value: "Expedited 1-5 min, Standard 3-5 h (Deep Archive within 12 h), Bulk 5-12 h (Deep Archive within 48 h)", adjustable: false, source: `${D}restoring-objects-retrieval-options.html`, note: "Documented, not simulated: a restored share of reads is a setting instead." },
    { label: "First-byte latency", value: "roughly 100 to 200 ms for latency-sensitive workloads; median tens of ms for small objects", adjustable: false, source: `${D}optimizing-performance.html`, note: "AWS publishes no distribution; the one here is assumed." },
    { label: "Throughput per connection", value: "not published today", adjustable: false, source: `${D}optimizing-performance-guidelines.html`, note: "AWS advises many parallel connections. The default rate here (about 90 MB/s) is assumed from older guidance." }
  ],
  highlights: [
    { rate: "fail.Throttled", label: "503/s" },
    { gauge: "transferring", label: "transferring" },
    { gauge: "pending", label: "notifying" }
  ],
  config,
  ports,
  state,
  make: (node) =>
    Effect.gen(function*() {
      const { fast } = node
      const events = node.out("events")
      const replicas = node.out("replication")
      // Replication Time Control moves data through one pipe per account and region, shared by every bucket in it.
      const pipe = yield* node.shared("s3.replication", Effect.sync(() => ({ busyUntil: 0 })))
      const table = new PrefixTable(node.id)
      const scratch = newPlan()

      const served = tallies(undefined, ["reads", "writes", "deletes", "heads", "lists", "copies", "deleteMarkers", "multipartParts"])
      const throttled = tallies(undefined, ["reads", "writes"])
      const refused = tallies(undefined, ["archived", "tooLarge"])
      let transferring = 0

      // CloudWatch's request metrics, by their names: AllRequests is `requests`, GetRequests `get`, and so on. The
      // per-kind counters count requests that were served; `requests` counts every request, refused ones too.
      const m = counters(node.meter, ["requests", "get", "head", "list", "put", "post", "copy", "delete", "deleteMarkers", "bytesDownloaded", "bytesUploaded", "4xxErrors", "5xxErrors"])
      const firstByteLatency = node.meter.sampler("firstByteLatency")
      const totalRequestLatency = node.meter.sampler("totalRequestLatency")
      // Each destination hears about every change on its own, so a slow one never holds up the others.
      const notifications = new Outbox(fast, tallies(node.meter, ["delivered"]).delivered, tallies(node.meter, ["undelivered"]).undelivered)
      const replication = new Outbox(fast, tallies(node.meter, ["replicated"]).replicated, tallies(node.meter, ["replicationFailed"]).replicationFailed)
      const replicationLag = node.meter.sampler("replicationLag")

      node.meter.gaugeUnsafe("transferring", () => transferring)
      node.meter.gaugeUnsafe("pending", () => notifications.pending)
      node.meter.gaugeUnsafe("replicating", () => replication.pending)
      // The highest rate one prefix is allowed: the guarantee, or what scale-up has reached.
      const floorOf = (read: boolean): number => {
        const rate = fast.settings().bucketType === "directory" ? DIRECTORY_RATE : PREFIX_RATE
        return read ? rate.read : rate.write
      }
      node.meter.gaugeUnsafe("readCeiling", () => Math.max(floorOf(true), table.highest(true)))
      node.meter.gaugeUnsafe("writeCeiling", () => Math.max(floorOf(false), table.highest(false)))

      // Failures are values with no per-call content: build each once.
      const slowDown = Refuse.throttled(node.id, "503 Slow Down: reduce your request rate")
      const archivedObject = Refuse.rejected(node.id, "403 InvalidObjectState: the object is archived; restore it before reading")
      const entityTooLarge = Refuse.rejected(node.id, "400 EntityTooLarge: a single PUT is limited to 5 GB; use multipart upload (and an object is at most 48.8 TiB)")

      /** One event per object created (`created`) or removed, to every destination subscribed to that kind. */
      const notify = (message: Message, objects: number, created: boolean): void => {
        const c = fast.settings()
        // An S3 notification has no message group, whatever the client's request had.
        const { group: _group, firstEnqueuedAt: _enqueued, ...base } = message
        const messages = Math.min(objects, MAX_EVENT_MESSAGES)
        const each = Math.floor(objects / messages)
        const extra = objects - each * messages
        for (const link of events) {
          const subscription = SubscriptionRef.getUnsafe(link.config)
          if (subscription.eventTypes !== "all" && (subscription.eventTypes === "created") !== created) continue
          for (let i = 0; i < messages; i++) {
            if (!passes(fast.random, subscription.filter)) continue
            const event: Message = { ...base, bytes: EVENT_BYTES, count: each + (i < extra ? 1 : 0), operation: "write", invocation: "async" }
            // S3 calls Lambda asynchronously. The delay is S3's own, before any network hop.
            notifications.send(link, event, Distribution.latencyMs(c.notificationDelay, fast.random))
            // At-least-once: some are delivered twice, each copy on its own delay.
            if (chance(fast.random, c.duplicateRate)) notifications.send(link, event, Distribution.latencyMs(c.notificationDelay, fast.random))
          }
        }
      }

      /**
       * Copy a new object to every replication destination, after the replication delay. With Replication Time Control
       * the bytes also queue through the account's RTC pipe, so a region replicating more than its quota falls behind.
       */
      const replicate = (message: Message, bytes: number): void => {
        if (replicas.length === 0 || message.group === REPLICA_GROUP) return
        const c = fast.settings()
        for (const link of replicas) {
          if (!passes(fast.random, SubscriptionRef.getUnsafe(link.config).filter)) continue
          const now = fast.now()
          let lag = Distribution.latencyMs(c.replicationDelay, fast.random)
          if (c.replicationTimeControl) {
            const rate = bytesPerMsAt((fast.account() as Aws.Account).s3ReplicationTransferRate)
            const start = pipe.busyUntil > now ? pipe.busyUntil : now
            pipe.busyUntil = start + bytes / rate
            lag = Math.max(lag, pipe.busyUntil - now)
          }
          const replica: Message = { ...message, bytes, operation: "write", invocation: "async", group: REPLICA_GROUP }
          replication.send(link, replica, lag, 1, (failure) => failure === undefined && replicationLag.add(fast.now() - now))
        }
      }

      return {
        call: (message) => {
          const c = fast.settings()
          const count = records(message)
          const reading = message.operation === "read"

          // The engine says only read or write, so the mix of request kinds is a setting of the bucket. A draw is made
          // only when there is a mix to draw from, so a bucket with none consumes no randomness.
          const kind: Kind = reading
            ? mix(fast.random, "get", "list", c.listShare, "head", c.headShare)
            : mix(fast.random, "put", "delete", c.deleteShare, "copy", c.copyShare)
          // HEAD, LIST and DELETE carry no body.
          const body = carriesBody(kind) && message.bytes > 0 ? message.bytes : 0

          m.requests.n += count
          if (tooLarge(kind, body, count, c.multipart.enabled)) {
            refused.tooLarge.add(count)
            m["4xxErrors"].n += count
            return entityTooLarge
          }

          const directory = c.bucketType === "directory"
          const speedUp = directory ? c.directoryLatencyFactor : 1
          const perConnection = (c.transferRate * MiB) / 1000
          const latency = kind === "list" ? c.listLatency : reading ? c.readLatency : c.writeLatency
          planTransfer(scratch, kind, count, body, c.multipart, perConnection, c.multipart.enabled ? Duration.toMillis(latency.mean) / speedUp : 0)

          // Requests land on a prefix by their key. Each prefix has its own allowance, and reads and writes are counted apart.
          const floor = reading ? (directory ? DIRECTORY_RATE.read : PREFIX_RATE.read) : (directory ? DIRECTORY_RATE.write : PREFIX_RATE.write)
          const allowance = table.get(directory ? 0 : prefixIndex(message.key, c.prefixes), reading, floor, c.prefixScaling)
          if (!node.limiter.takeUnsafe(allowance.key, allowance.bucket, scratch.tokens)) {
            throttled[reading ? "reads" : "writes"].add(count)
            m["5xxErrors"].n += count
            table.refuse(allowance, fast.now(), c.prefixScaling)
            return slowDown
          }

          // An archived object cannot be read until it is restored. HEAD and LIST still work.
          if (kind === "get" && ARCHIVED.has(c.storageClass) && !(c.restoredShare > 0 && fast.random.nextDoubleUnsafe() < c.restoredShare)) {
            refused.archived.add(count)
            m["4xxErrors"].n += count
            return archivedObject
          }

          // First byte, then the bytes themselves at the rate the connections can move them.
          const firstByte = Distribution.latencyMs(latency, fast.random) / speedUp
          const before = scratch.beforeMs
          const total = before + firstByte + scratch.afterMs
          // The plan is scratch space reused by the next call, so take what the completion needs now.
          const parts = scratch.parts
          const controls = scratch.posts
          transferring++
          return Flow.delayed(
            fast,
            total,
            () => {
              transferring--
              firstByteLatency.add(firstByte + before)
              totalRequestLatency.add(total)
              const requestsSent = parts > 0 ? parts : count
              switch (kind) {
                case "get":
                  served.reads.add(count)
                  m.get.n += requestsSent
                  m.bytesDownloaded.n += body
                  break
                case "head":
                  served.reads.add(count)
                  served.heads.add(count)
                  m.head.n += count
                  break
                case "list":
                  served.reads.add(count)
                  served.lists.add(count)
                  m.list.n += count
                  break
                case "put":
                  served.writes.add(count)
                  m.put.n += requestsSent
                  m.bytesUploaded.n += body
                  break
                case "copy":
                  // CloudWatch counts a copy as a PUT on the destination.
                  served.writes.add(count)
                  served.copies.add(count)
                  m.copy.n += count
                  m.put.n += requestsSent
                  break
                case "delete":
                  served.deletes.add(count)
                  m.delete.n += count
                  if (c.versioning) {
                    served.deleteMarkers.add(count)
                    m.deleteMarkers.n += count
                  }
                  break
              }
              if (parts > 0) {
                served.multipartParts.add(parts)
                m.post.n += controls
              }
              // Strongly consistent: the object is visible the moment the call returns. Notifications and replicas
              // follow later, off the request path.
              if (!reading) {
                if (events.length > 0) notify(message, count, kind !== "delete")
                if (isUpload(kind)) replicate(message, body)
              }
              return undefined
            },
            () => void transferring--
          )
        },
        probe: Effect.sync(() => {
          const c = fast.settings()
          return {
            bucketType: c.bucketType,
            prefixes: c.bucketType === "directory" ? 1 : c.prefixes,
            served: totals(served),
            throttled: totals(throttled),
            refused: totals(refused),
            transferring,
            scaled: { prefixes: table.scaled.size, readCeiling: Math.max(floorOf(true), table.highest(true)), writeCeiling: Math.max(floorOf(false), table.highest(false)) },
            notifications: { destinations: events.length, pending: notifications.pending, delivered: notifications.delivered.total, undelivered: notifications.undelivered.total },
            replication: { destinations: replicas.length, pending: replication.pending, delivered: replication.delivered.total, undelivered: replication.undelivered.total }
          }
        })
      }
    })
})
