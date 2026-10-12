import { Effect, Schema } from "effect"
import * as Distribution from "../../Distribution.ts"
import * as Flow from "../../Flow.ts"
import type { Bucket } from "../../Limiter.ts"
import { type Call, type CallFailure, type Message, Rejected, Throttled } from "../../Message.ts"
import * as Aws from "../provider.ts"
import { buildCapacity, type Capacity, indexCount, type Resource, Scalers } from "./capacity.ts"
import {
  Config,
  ITEM_MAX_BYTES,
  KEYS_ONLY_BYTES,
  PARTITION,
  ports,
  REPLICATED_GROUP,
  SOURCES,
  TRANSACTION_MAX_BYTES,
  TRANSACTION_MAX_ITEMS
} from "./config.ts"
import { Ledger } from "./ledger.ts"
import { indexKeyOf, PartitionKeys, partitionOf } from "./partitions.ts"
import { Stream } from "./streams.ts"
import { entryBytes, indexReadUnits, indexWriteUnits, readUnits, writeUnits } from "./units.ts"

const SCALING_NOTE = "Throttling can occur beyond double the previous peak within 30 minutes."

/** What a stream record weighs for each view type, given the item it is about. A change is taken to carry both images. */
const recordBytes = (view: Config["stream"]["view"], itemBytes: number): number =>
  view === "keys" ? KEYS_ONLY_BYTES : view === "new-and-old" ? 2 * itemBytes : itemBytes

/** The two ceilings every partition has, as buckets: a partition holds one second of its maximum. */
const PARTITION_BUCKET = {
  read: { rate: PARTITION.read, burst: PARTITION.read },
  write: { rate: PARTITION.write, burst: PARTITION.write }
} as const

/** Whether a take of `tokens` from `bucket` would succeed, without taking: mirrors the limiter's own rule for oversized takes. */
const need = (tokens: number, bucket: Bucket): number => (tokens > bucket.burst ? Math.max(1, bucket.burst) : tokens)

export const DynamoDb = Aws.component({
  type: "aws.dynamodb",
  service: "DynamoDB",
  title: "DynamoDB table",
  description:
    "Key-value store with provisioned or on-demand throughput. Capacity units by item size, a hard per-partition limit (hot keys), banked burst capacity, on-demand scaling, global secondary indexes that push back on writes, a change stream and TTL.",
  docs: `${Aws.docs.dynamodb}ServiceQuotas.html`,
  category: "storage",
  icon: "table",
  accent: "#2e73b8",
  limits: [
    { label: "Per-partition throughput", value: "3,000 read units and 1,000 write units per second", adjustable: false, source: SOURCES.partitionKey },
    { label: "Item size", value: "400 KB", adjustable: false, source: SOURCES.constraints },
    { label: "Batch operations", value: "100 items per BatchGetItem, 25 per BatchWriteItem, 16 MB", adjustable: false, source: SOURCES.constraints, note: "A message with more records than that stands for several batch calls; capacity is charged per item either way." },
    { label: "Transactions", value: "100 items and 4 MB; every item costs twice (prepare and commit), even if the transaction is cancelled", adjustable: false, source: SOURCES.transactions, note: "A transactional message over 100 items or 4 MB is rejected." },
    { label: "New on-demand table", value: "12,000 reads and 4,000 writes per second, then up to 2x the previous peak", adjustable: false, source: SOURCES.onDemand, note: SCALING_NOTE },
    { label: "Per-table and per-account throughput", value: "40,000 per table or index; 80,000 provisioned per account, indexes included", adjustable: true, source: SOURCES.quotas, note: "Set in the account quotas." },
    { label: "Secondary indexes", value: "20 global (quota) and 5 local per table", adjustable: true, source: SOURCES.quotas },
    { label: "Stream retention", value: "24 hours; each record once, in order per item", adjustable: false, source: SOURCES.streams },
    { label: "Stream readers", value: "at most 2 readers per shard", adjustable: false, source: SOURCES.streams, note: "More may be throttled; not enforced here." },
    { label: "Partition count and split timing", value: "Not published by AWS; modelled from capacity unless you set it", adjustable: false, source: SOURCES.partitionKey }
  ],
  highlights: [
    { rate: "fail.Throttled", label: "throttled/s" },
    { gauge: "readTokens", label: "read burst" },
    { gauge: "writeTokens", label: "write burst" }
  ],
  config: Config,
  ports,
  state: Schema.Struct({
    mode: Schema.String,
    /** Throughput the table can serve right now, in units per second. On-demand it is what it has scaled out to. */
    readCapacity: Schema.Number,
    writeCapacity: Schema.Number,
    partitions: Schema.Number,
    readTokens: Schema.Number,
    writeTokens: Schema.Number,
    served: Schema.Struct({ reads: Schema.Number, writes: Schema.Number }),
    throttled: Schema.Struct({ reads: Schema.Number, writes: Schema.Number, partition: Schema.Number, index: Schema.Number }),
    /** Capacity units consumed, by the table itself. */
    consumed: Schema.Struct({ reads: Schema.Number, writes: Schema.Number }),
    /** Highest per-second consumption ever. On-demand capacity follows it (and never forgets it). */
    peak: Schema.Struct({ reads: Schema.Number, writes: Schema.Number }),
    /** Writes that failed their condition (they still cost capacity). */
    conditionFailed: Schema.Number,
    /** The error the most recent throttled request got, for telling the throttles apart: empty if none yet. */
    lastThrottle: Schema.String,
    indexes: Schema.Struct({
      count: Schema.Number,
      readCapacity: Schema.Number,
      writeCapacity: Schema.Number,
      /** Fewest write tokens in any index: how close the closest index is to pushing back on the table. */
      writeTokens: Schema.Number,
      consumedWrites: Schema.Number,
      consumedReads: Schema.Number
    }),
    /** `deferred`: expired items waiting for an index with room for their deletes. */
    ttl: Schema.Struct({ deleted: Schema.Number, deferred: Schema.Number }),
    stream: Schema.Struct({
      active: Schema.Boolean,
      consumers: Schema.Number,
      shards: Schema.Number,
      /** Segments (100 ms of one shard's records) still held: a handful while consumers keep up. */
      segments: Schema.Number,
      appended: Schema.Number,
      delivered: Schema.Number,
      /** Records waiting to be read by the slowest consumer. */
      backlog: Schema.Number,
      /** Records in batches that keep failing: a blocked shard. */
      blocked: Schema.Number,
      /** Age in ms of the oldest record not yet processed. */
      iteratorAge: Schema.Number,
      discarded: Schema.Number,
      expired: Schema.Number
    }),
    replication: Schema.Struct({ replicas: Schema.Number, sent: Schema.Number, failed: Schema.Number, inFlight: Schema.Number })
  }),
  make: (node) =>
    Effect.gen(function*() {
      const { fast, limiter } = node
      const ledger = yield* node.shared<Ledger>("dynamodb", Effect.sync(() => new Ledger()))
      // Register now so tables are served in creation order.
      ledger.claim(node.id, 0, 0)
      const scalers = new Scalers()

      const consumers = node.out("stream")
      const replicas = node.out("replicas")

      const served = { reads: 0, writes: 0 }
      const throttled = { reads: 0, writes: 0, partition: 0, index: 0 }
      const consumed = { reads: 0, writes: 0, indexReads: 0, indexWrites: 0 }
      const ttl = { deleted: 0, deferred: 0, carry: 0 }
      const replication = { sent: 0, failed: 0, inFlight: 0 }
      let conditionFailed = 0
      let lastThrottle = ""

      const consumedRead = node.meter.counter("consumedRead")
      const consumedWrite = node.meter.counter("consumedWrite")
      const consumedIndexRead = node.meter.counter("consumedIndexRead")
      const consumedIndexWrite = node.meter.counter("consumedIndexWrite")
      const throttledPartition = node.meter.counter("throttledPartition")
      const throttledIndex = node.meter.counter("throttledIndex")
      const conditionFailures = node.meter.counter("conditionFailed")
      const ttlDeleted = node.meter.counter("ttlDeleted")
      const replicated = node.meter.counter("replicated")
      const replicationFailed = node.meter.counter("replicationFailed")
      const replicationLag = node.meter.sampler("replicationLag")

      const stream = new Stream({
        fast,
        consumers,
        discards: node.out("discarded"),
        counters: {
          appended: node.meter.counter("streamAppended"),
          delivered: node.meter.counter("streamDelivered"),
          batches: node.meter.counter("streamBatches"),
          failedBatches: node.meter.counter("streamFailedBatches"),
          discarded: node.meter.counter("streamDiscarded"),
          expired: node.meter.counter("streamExpired")
        }
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => stream.cancelAll()))
      const streamDelay = (): number => Distribution.latencyMs(fast.settings().stream.propagation, fast.random)

      const readKey = `${node.id}/table/read`
      const writeKey = `${node.id}/table/write`
      const tableKeys = new PartitionKeys(`${node.id}/table`)
      const indexKeys: Array<PartitionKeys> = []
      const keysOfIndex = (i: number): PartitionKeys => indexKeys[i] ?? (indexKeys[i] = new PartitionKeys(`${node.id}/gsi${i}`))
      const indexBucketKey = (i: number, op: "read" | "write"): string => `${node.id}/gsi${i}/${op}`

      /**
       * What the table and its indexes can do right now. Worked out once per change of settings, account quotas, the set
       * of tables or an on-demand ceiling, not once per request.
       */
      let memo: { c: Config; account: Aws.Account; version: number; changes: number; value: Capacity } | undefined
      const capacity = (now: number): Capacity => {
        const c = fast.settings()
        const account = fast.account() as Aws.Account
        if (c.mode === "on-demand") {
          // Intervals and seconds pass whether or not anything is called: bring the ceilings up to date.
          scalers.table.read.touch(now)
          scalers.table.write.touch(now)
          for (let i = indexCount(c, account) - 1; i >= 0; i--) {
            const s = scalers.index(i)
            s.read.touch(now)
            s.write.touch(now)
          }
        }
        if (memo !== undefined && memo.c === c && memo.account === account && memo.version === ledger.version && memo.changes === scalers.changes.n) return memo.value
        const value = buildCapacity({ id: node.id, c, account, ledger, scalers, now })
        // Building may have changed the ledger or a scaler, so remember where it ended up.
        memo = { c, account, version: ledger.version, changes: scalers.changes.n, value }
        return value
      }

      const lowestIndexWriteTokens = (cap: Capacity): number => {
        let lowest = Infinity
        for (let i = 0; i < cap.indexes.length; i++) lowest = Math.min(lowest, limiter.levelUnsafe(indexBucketKey(i, "write"), cap.indexes[i]!.write.bucket))
        return lowest === Infinity ? 0 : lowest
      }

      node.meter.gaugeUnsafe("readTokens", () => limiter.levelUnsafe(readKey, capacity(fast.now()).table.read.bucket))
      node.meter.gaugeUnsafe("writeTokens", () => limiter.levelUnsafe(writeKey, capacity(fast.now()).table.write.bucket))
      node.meter.gaugeUnsafe("readCapacity", () => capacity(fast.now()).table.read.rate)
      node.meter.gaugeUnsafe("writeCapacity", () => capacity(fast.now()).table.write.rate)
      node.meter.gaugeUnsafe("indexWriteTokens", () => lowestIndexWriteTokens(capacity(fast.now())))
      node.meter.gaugeUnsafe("streamBacklog", () => stream.backlog())
      node.meter.gaugeUnsafe("streamBlocked", () => stream.blocked())
      node.meter.gaugeUnsafe("iteratorAge", () => stream.iteratorAge(fast.now()))
      node.meter.gaugeUnsafe("replicating", () => replication.inFlight)

      /** Would a take succeed? Checked before anything is taken, so a request refused by any limit costs nothing. */
      const fits = (key: string, bucket: Bucket, tokens: number): boolean => limiter.levelUnsafe(key, bucket) >= need(tokens, bucket)
      /**
       * A request's units on a table's or index's partitions: all on the key's partition, or, for a batch whose records have
       * keys of their own (`Message.spread`), that share spread evenly over every partition and the rest on the key's. Checks
       * them all, or takes them all.
       */
      const onPartitions = (keys: PartitionKeys, op: "read" | "write", partitions: number, hot: number, units: number, spread: number, take: boolean): boolean => {
        const bucket = PARTITION_BUCKET[op]
        if (spread <= 0 || partitions <= 1) {
          if (take) limiter.takeUnsafe(keys.of(op, hot), bucket, units)
          return take || fits(keys.of(op, hot), bucket, units)
        }
        const each = (units * spread) / partitions
        const own = units - units * spread
        for (let p = 0; p < partitions; p++) {
          const share = p === hot ? each + own : each
          if (take) limiter.takeUnsafe(keys.of(op, p), bucket, share)
          else if (!fits(keys.of(op, p), bucket, share)) return false
        }
        return true
      }

      const refuse = (reason: string, isRead: boolean, count: number, source: "table" | "partition" | "index"): Call => {
        if (isRead) throttled.reads += count
        else throttled.writes += count
        if (source === "partition") {
          throttled.partition += count
          throttledPartition.n += count
        } else if (source === "index") {
          throttled.index += count
          throttledIndex.n += count
        }
        lastThrottle = reason
        return Effect.fail(Throttled({ node: node.id, reason }))
      }
      const reject = (reason: string): Call => Effect.fail(Rejected({ node: node.id, reason }))
      const conditionFailure: CallFailure = Rejected({ node: node.id, reason: "ConditionalCheckFailedException: the conditional request failed" })
      const failCondition = (): CallFailure => conditionFailure

      // ---- global tables ---------------------------------------------------------------------------------------

      /** Send one replicated write to a replica. It is an ordinary write there, charged as replicated write units. */
      const replicate = ({ link, message, from }: { link: (typeof replicas)[number]; message: Message; from: number }): void => {
        replication.inFlight++
        link.send(message, (failure) => {
          replication.inFlight--
          if (failure === undefined) {
            replication.sent++
            replicated.n += message.count
            replicationLag.add(fast.now() - from)
          } else {
            replication.failed++
            replicationFailed.n += message.count
          }
        })
      }
      /** After the lag, every replica gets the write; `group` marks it so the replica doesn't send it back. */
      const replicateTo = (count: number, bytes: number, key: number, born: number): void => {
        const c = fast.settings()
        for (const link of replicas) {
          const message = { ...fast.mint({ count, bytes, key, group: REPLICATED_GROUP, invocation: "async", operation: "write" }), bornAt: born }
          fast.after(Distribution.latencyMs(c.replication.lag, fast.random), replicate, { link, message, from: fast.now() })
        }
      }

      // ---- time to live ----------------------------------------------------------------------------------------

      /**
       * Items expire at a steady rate. TTL deletes use no write capacity on the table (ttl), but they leave every index
       * (which costs index write capacity), go into the stream as service deletes and replicate to the replicas.
       * An index that has no capacity for them makes them wait: AWS deletes "within a few days", not on a schedule.
       */
      const expire = (): void => {
        const c = fast.settings()
        ttl.carry += c.ttl.expiresPerSecond
        const items = Math.floor(ttl.carry)
        if (items < 1) return
        const now = fast.now()
        const cap = capacity(now)
        // Each index must take a write per deleted item; the ones it has room for go now, the rest wait for the next second.
        const unit = indexWriteUnits(entryBytes(c.gsi.entryBytes, c.ttl.itemBytes), 1, c.gsi.writeShare, 0)
        let doable = items
        if (unit > 0) {
          for (let i = 0; i < cap.indexes.length; i++) {
            doable = Math.min(doable, Math.floor(limiter.levelUnsafe(indexBucketKey(i, "write"), cap.indexes[i]!.write.bucket) / unit))
          }
        }
        ttl.deferred = items - doable
        if (doable < 1) return
        ttl.carry -= doable
        const done = doable
        for (let i = 0; i < cap.indexes.length; i++) {
          const units = unit * done
          limiter.takeUnsafe(indexBucketKey(i, "write"), cap.indexes[i]!.write.bucket, units)
          scalers.index(i).write.record(now, units)
          consumed.indexWrites += units
          consumedIndexWrite.n += units
        }
        ttl.deleted += done
        ttlDeleted.n += done
        const bytes = done * c.ttl.itemBytes
        if (stream.consumers > 0 && c.stream.view !== "off") {
          // Spread over a few shards: deletions don't concentrate on one partition.
          const shards = Math.max(1, Math.min(cap.table.partitions, 16, done))
          for (let s = 0; s < shards; s++) {
            const share = Math.floor(done / shards) + (s < done % shards ? 1 : 0)
            if (share > 0) stream.append(Math.floor((s / shards) * cap.table.partitions), share, share * recordBytes(c.stream.view, c.ttl.itemBytes), now, streamDelay)
          }
        }
        if (replicas.length > 0) replicateTo(done, bytes, fast.random.nextDoubleUnsafe(), now)
      }
      const tick = (): void => {
        if (fast.settings().ttl.expiresPerSecond > 0) expire()
        fast.after(1_000, tick, undefined)
      }
      fast.after(1_000, tick, undefined)

      // ---- requests --------------------------------------------------------------------------------------------

      /** A Query on a global secondary index: it uses the index's read capacity and partition, never the table's. */
      const readIndex = (c: Config, cap: Capacity, i: number, key: number, entry: number, count: number, now: number): Call => {
        const index: Resource = cap.indexes[i]!
        const units = indexReadUnits(entry, count)
        const part = partitionOf(indexKeyOf(key, i, c.gsi.keyValues), index.partitions)
        const partitionKey = keysOfIndex(i).of("read", part)
        const bucketKey = indexBucketKey(i, "read")
        if (!fits(partitionKey, PARTITION_BUCKET.read, units)) return refuse(index.read.keyRange, true, count, "index")
        if (!fits(bucketKey, index.read.bucket, units)) return refuse(index.read.throttle, true, count, "index")
        limiter.takeUnsafe(partitionKey, PARTITION_BUCKET.read, units)
        limiter.takeUnsafe(bucketKey, index.read.bucket, units)
        scalers.index(i).read.record(now, units)
        consumed.indexReads += units
        consumedIndexRead.n += units
        served.reads += count
        return Flow.wait(fast, Distribution.latencyMs(c.latency, fast.random))
      }

      return {
        call: (message) => {
          const c = fast.settings()
          const count = message.count
          if (count < 1) return Effect.void
          const now = fast.now()
          const isRead = message.operation === "read"
          const isReplica = !isRead && message.group === REPLICATED_GROUP
          const itemBytes = message.bytes / count
          if (itemBytes > ITEM_MAX_BYTES) return reject("ValidationException: item size has exceeded the maximum allowed size of 400 KB")
          // A replicated write is applied as a plain write: it is neither a transaction nor conditional there.
          const transactional = isRead ? c.readConsistency === "transactional" : c.writeMode === "transactional" && !isReplica
          if (transactional && (count > TRANSACTION_MAX_ITEMS || message.bytes > TRANSACTION_MAX_BYTES)) {
            return reject("ValidationException: a transaction holds at most 100 items and 4 MB")
          }

          const cap = capacity(now)
          const table = cap.table

          // ---- a read that goes to an index instead of the table
          if (isRead && cap.indexes.length > 0 && c.gsi.readShare > 0) {
            const u = fast.random.nextDoubleUnsafe()
            if (u < c.gsi.readShare) return readIndex(c, cap, Math.floor((u / c.gsi.readShare) * cap.indexes.length), message.key, entryBytes(c.gsi.entryBytes, itemBytes), count, now)
          }

          // ---- the table's own units
          const op = isRead ? "read" : "write"
          const direction = isRead ? table.read : table.write
          const failsCondition = !isRead && !isReplica && c.conditionFailureRate > 0 && fast.random.nextDoubleUnsafe() < c.conditionFailureRate
          let units = isRead ? readUnits(itemBytes, count, c.readConsistency) : writeUnits(itemBytes, count, transactional)
          // Local secondary indexes share the table's capacity: each write also writes to them. A failed condition changes nothing.
          if (!isRead && !failsCondition && c.lsi.count > 0) units += indexWriteUnits(entryBytes(c.lsi.entryBytes, itemBytes), count * c.lsi.count, c.lsi.writeShare, 0)

          // A request that any limit refuses takes nothing from the others: all are checked first, then all are taken.
          const partition = partitionOf(message.key, table.partitions)
          const spread = count > 1 ? (message.spread ?? 1) : 0
          const bucketKey = isRead ? readKey : writeKey
          if (!onPartitions(tableKeys, op, table.partitions, partition, units, spread, false)) return refuse(direction.keyRange, isRead, count, "partition")
          if (!fits(bucketKey, direction.bucket, units)) return refuse(direction.throttle, isRead, count, "table")

          // ---- a write also writes to every global secondary index, and is throttled if any of them can't take it
          let perIndex = 0
          if (!isRead && !failsCondition && cap.indexes.length > 0) {
            perIndex = indexWriteUnits(entryBytes(c.gsi.entryBytes, itemBytes), count, c.gsi.writeShare, c.gsi.keyChangeShare)
            if (perIndex > 0) {
              for (let i = 0; i < cap.indexes.length; i++) {
                const index = cap.indexes[i]!
                const part = partitionOf(indexKeyOf(message.key, i, c.gsi.keyValues), index.partitions)
                if (!onPartitions(keysOfIndex(i), "write", index.partitions, part, perIndex, spread, false)) return refuse(index.write.keyRange, false, count, "index")
                if (!fits(indexBucketKey(i, "write"), index.write.bucket, perIndex)) return refuse(index.write.throttle, false, count, "index")
              }
              for (let i = 0; i < cap.indexes.length; i++) {
                const index = cap.indexes[i]!
                const part = partitionOf(indexKeyOf(message.key, i, c.gsi.keyValues), index.partitions)
                onPartitions(keysOfIndex(i), "write", index.partitions, part, perIndex, spread, true)
                limiter.takeUnsafe(indexBucketKey(i, "write"), index.write.bucket, perIndex)
                scalers.index(i).write.record(now, perIndex)
              }
              consumed.indexWrites += perIndex * cap.indexes.length
              consumedIndexWrite.n += perIndex * cap.indexes.length
            }
          }
          onPartitions(tableKeys, op, table.partitions, partition, units, spread, true)
          limiter.takeUnsafe(bucketKey, direction.bucket, units)

          if (isRead) {
            scalers.table.read.record(now, units)
            consumed.reads += units
            consumedRead.n += units
            served.reads += count
          } else {
            scalers.table.write.record(now, units)
            consumed.writes += units
            consumedWrite.n += units
            served.writes += count
            if (!failsCondition) {
              // The write has happened: its change is on the stream and on its way to the replicas.
              if (stream.consumers > 0 && c.stream.view !== "off") stream.append(partition, count, count * recordBytes(c.stream.view, itemBytes), message.bornAt, streamDelay)
              if (replicas.length > 0 && !isReplica) replicateTo(count, message.bytes, message.key, message.bornAt)
            }
          }
          const wait = Distribution.latencyMs(c.latency, fast.random)
          if (!failsCondition) return Flow.wait(fast, wait)
          conditionFailed++
          conditionFailures.n++
          return Flow.delayed(fast, wait, failCondition)
        },
        probe: Effect.sync(() => {
          const now = fast.now()
          const c = fast.settings()
          const cap = capacity(now)
          return {
            mode: c.mode,
            readCapacity: cap.table.read.rate,
            writeCapacity: cap.table.write.rate,
            partitions: cap.table.partitions,
            readTokens: limiter.levelUnsafe(readKey, cap.table.read.bucket),
            writeTokens: limiter.levelUnsafe(writeKey, cap.table.write.bucket),
            served: { ...served },
            throttled: { ...throttled },
            consumed: { reads: consumed.reads, writes: consumed.writes },
            peak: { reads: scalers.table.read.peak, writes: scalers.table.write.peak },
            conditionFailed,
            lastThrottle,
            indexes: {
              count: cap.indexes.length,
              readCapacity: cap.indexes[0]?.read.rate ?? 0,
              writeCapacity: cap.indexes[0]?.write.rate ?? 0,
              writeTokens: lowestIndexWriteTokens(cap),
              consumedWrites: consumed.indexWrites,
              consumedReads: consumed.indexReads
            },
            ttl: { deleted: ttl.deleted, deferred: ttl.deferred },
            stream: {
              active: stream.consumers > 0 && c.stream.view !== "off",
              consumers: stream.consumers,
              shards: stream.shardCount,
              segments: stream.segmentCount(),
              appended: stream.totals.appended,
              delivered: stream.totals.delivered,
              backlog: stream.backlog(),
              blocked: stream.blocked(),
              iteratorAge: stream.iteratorAge(now),
              discarded: stream.totals.discarded,
              expired: stream.totals.expired
            },
            replication: { replicas: replicas.length, sent: replication.sent, failed: replication.failed, inFlight: replication.inFlight }
          }
        })
      }

    })
})
