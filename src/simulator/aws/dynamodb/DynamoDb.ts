import { Effect, Schema } from "effect"
import * as Aws from "../internal/provider.ts"
import { Config, ports, SOURCES } from "./internal/config.ts"
import { dashboard } from "./internal/dashboard.ts"
import { Ledger } from "./internal/ledger.ts"
import { makeRuntime } from "./internal/runtime.ts"

const SCALING_NOTE = "Throttling can occur beyond double the previous peak within 30 minutes."

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
  dashboard,
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
      const ledger = yield* node.shared<Ledger>("dynamodb", Effect.sync(() => new Ledger()))
      // Register now so tables are served in creation order.
      ledger.claim(node.id, 0, 0)
      const { stop, ...instance } = makeRuntime(node, ledger)
      yield* Effect.addFinalizer(() => Effect.sync(stop))
      return instance
    })
})
