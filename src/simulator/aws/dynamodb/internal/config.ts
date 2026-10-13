import { Schema } from "effect"
import * as Edge from "../../../Edge.ts"
import * as Component from "../../../Component.ts"
import * as Setting from "../../../Setting.ts"
import { docs } from "../../internal/docs.ts"
import { KiB, MiB } from "../../internal/units.ts"

/**
 * Everything that is a number from AWS or a setting of the DynamoDB component: constants with their sources, the
 * settings schema, and the per-edge settings of the component's output ports. Behaviour lives in the other modules.
 */

const D = docs.dynamodb
const LAMBDA = "https://docs.aws.amazon.com/lambda/latest/dg/"

/** The AWS pages every number here comes from, so the README, the limits list and the settings cite one source. */
export const SOURCES = {
  quotas: `${D}ServiceQuotas.html`,
  constraints: `${D}Constraints.html`,
  onDemand: `${D}on-demand-capacity-mode.html`,
  maxThroughput: `${D}on-demand-capacity-mode-max-throughput.html`,
  warm: `${D}warm-throughput.html`,
  burst: `${D}burst-adaptive-capacity.html`,
  partitionKey: `${D}bp-partition-key-design.html`,
  readWrite: `${D}read-write-operations.html`,
  gsi: `${D}GSI.html`,
  gsiThrottling: `${D}gsi-throttling.html`,
  lsi: `${D}LSI.html`,
  streams: `${D}Streams.html`,
  ttl: `${D}TTL.html`,
  ttlStreams: `${D}time-to-live-ttl-streams.html`,
  globalTables: `${D}V2globaltables_HowItWorks.html`,
  transactions: `${D}transaction-apis.html`,
  errors: `${D}Programming.Errors.html`,
  throttling: `${D}TroubleshootingThrottling.html`,
  lambdaStreams: `${LAMBDA}with-ddb.html`,
  lambdaParams: `${LAMBDA}services-ddb-params.html`,
  lambdaErrors: `${LAMBDA}services-dynamodb-errors.html`
} as const

/** Item size limit, attribute names and values included. (Constraints) */
export const ITEM_MAX_BYTES = 400 * KiB
/** Read units cover 4 KB, write units 1 KB, each rounded up per item. (read-write-operations) */
export const READ_UNIT_BYTES = 4 * KiB
export const WRITE_UNIT_BYTES = 1 * KiB
/** One partition serves at most this many units a second, however big the table is. (bp-partition-key-design) */
export const PARTITION = { read: 3_000, write: 1_000 } as const
/** A new on-demand table, or index, sustains this much; it then accommodates twice its previous peak. (on-demand-capacity-mode) */
export const ON_DEMAND_BASELINE = { read: 12_000, write: 4_000 } as const
/** A transaction holds at most 100 items and 4 MB. (Constraints) */
export const TRANSACTION_MAX_ITEMS = 100
export const TRANSACTION_MAX_BYTES = 4 * MiB
/** Local secondary indexes per table. Not adjustable. (ServiceQuotas) */
export const MAX_LOCAL_INDEXES = 5
/** Stream records are kept 24 hours, then trimmed. (Streams) */
export const STREAM_RETENTION_MS = 24 * 60 * 60 * 1000
/** Lambda polls each shard four times a second when it is idle. (with-ddb) */
export const STREAM_POLL_MS = 250
/** A Lambda batch stops growing at its 6 MB payload limit. (with-ddb) */
export const STREAM_BATCH_MAX_BYTES = 6 * MiB
/** Stream records carry the keys at least; this is what a keys-only record weighs. Assumed: a few key attributes. */
export const KEYS_ONLY_BYTES = 128
/** Sent in `group` on a message that is a replicated write, so the receiving replica doesn't replicate it back. */
export const REPLICATED_GROUP = "dynamodb:replicated"

const Hard = Setting.hard
const Quota = Setting.quota

/** Settings of one DynamoDB table. The names of the first block are stable: designs and the importer use them. */
export const Config = Schema.Struct({
  mode: Setting.choice(["provisioned", "on-demand"], { default: "provisioned", labels: { provisioned: "Provisioned", "on-demand": "On-demand" } }),
  readCapacity: Setting.int({
    default: 100,
    min: 1,
    max: 10_000_000,
    unit: "RCU",
    label: "Provisioned read capacity",
    help: "Provisioned mode. Capped by the per-table and per-account quotas.",
    limit: Quota(SOURCES.quotas)
  }),
  writeCapacity: Setting.int({ default: 100, min: 1, max: 10_000_000, unit: "WCU", label: "Provisioned write capacity", limit: Quota(SOURCES.quotas) }),
  partitions: Setting.int({
    default: 0,
    min: 0,
    max: 10_000,
    label: "Partitions",
    help: "0 derives it from capacity. AWS doesn't publish how many partitions a table has or when it splits, so this is a modelling choice."
  }),
  readConsistency: Setting.choice(["eventual", "strong", "transactional"], {
    default: "eventual",
    help: "Eventually consistent reads cost half a unit per 4 KB, strongly consistent one, transactional two."
  }),
  writeMode: Setting.choice(["standard", "transactional"], {
    default: "standard",
    help: "Transactional writes cost twice as much, and a transaction holds at most 100 items and 4 MB."
  }),
  burstSeconds: Setting.int({
    default: 300,
    min: 0,
    max: 300,
    unit: "s",
    label: "Burst capacity",
    help: "Seconds of unused capacity banked for bursts. AWS retains up to 300 s and says this may change; how it refills is not published.",
    limit: Hard(SOURCES.burst)
  }),
  latency: Setting.latency({ mean: "5 millis", cv: 0.5, label: "Request latency", help: "AWS says 'single-digit milliseconds' and publishes no percentiles; an assumption." }),

  conditionFailureRate: Setting.ratio({
    default: 0,
    label: "Condition failure rate",
    help: "Share of writes whose condition expression is false. AWS still charges the write capacity; nothing changes (no index or stream write) and the call fails with ConditionalCheckFailedException, which retrying cannot fix."
  }),

  onDemand: Setting.group(
    {
      maxReadUnits: Setting.int({
        default: 0,
        min: 0,
        max: 10_000_000,
        unit: "RRU/s",
        label: "Maximum read throughput",
        help: "On-demand only. Throttles reads above this with ThrottlingException. 0 is no maximum (the per-table quota applies). AWS applies it best effort and burst capacity can exceed it briefly.",
        limit: Quota(SOURCES.maxThroughput)
      }),
      maxWriteUnits: Setting.int({
        default: 0,
        min: 0,
        max: 10_000_000,
        unit: "WRU/s",
        label: "Maximum write throughput",
        help: "On-demand only. Throttles writes above this with ThrottlingException. 0 is no maximum.",
        limit: Quota(SOURCES.maxThroughput)
      }),
      warmReadUnits: Setting.int({
        default: 0,
        min: 0,
        max: 10_000_000,
        unit: "RRU/s",
        label: "Pre-warmed reads",
        help: "Warm throughput raised ahead of a launch: reads per second the table absorbs instantly. 0 keeps AWS's default for a new table (12,000). Capped by the per-table quota.",
        limit: Quota(SOURCES.warm)
      }),
      warmWriteUnits: Setting.int({
        default: 0,
        min: 0,
        max: 10_000_000,
        unit: "WRU/s",
        label: "Pre-warmed writes",
        help: "Warm throughput for writes. 0 keeps AWS's default for a new table (4,000).",
        limit: Quota(SOURCES.warm)
      }),
      scaleInterval: Setting.duration({
        default: "30 minutes",
        min: "1 second",
        max: "24 hours",
        label: "Scale-out interval",
        help: "How long DynamoDB needs to double the capacity a table can absorb beyond twice its previous peak. AWS says throttling can occur if you exceed double your previous peak within 30 minutes; it does not publish a fixed step, so treat this as the documented guidance."
      })
    },
    { label: "On-demand scaling", help: "Only used in on-demand mode." }
  ),

  gsi: Setting.group(
    {
      count: Setting.int({
        default: 0,
        min: 0,
        max: 100,
        label: "Global secondary indexes",
        help: "How many GSIs the table has (all alike). Capped by the per-table index quota (20). Each write to the table also writes to every index and is throttled if any index can't absorb it.",
        limit: Quota(SOURCES.quotas)
      }),
      readCapacity: Setting.int({
        default: 0,
        min: 0,
        max: 10_000_000,
        unit: "RCU",
        label: "Read capacity per index",
        help: "Provisioned mode: each index has its own capacity. 0 gives each index the table's read capacity.",
        limit: Quota(SOURCES.quotas)
      }),
      writeCapacity: Setting.int({
        default: 0,
        min: 0,
        max: 10_000_000,
        unit: "WCU",
        label: "Write capacity per index",
        help: "Provisioned mode: each index has its own capacity, and AWS advises at least the table's. Below it, the table is throttled. 0 gives each index the table's write capacity.",
        limit: Quota(SOURCES.quotas)
      }),
      maxReadUnits: Setting.int({ default: 0, min: 0, max: 10_000_000, unit: "RRU/s", label: "Maximum read throughput per index", help: "On-demand only. 0 is no maximum.", limit: Quota(SOURCES.maxThroughput) }),
      maxWriteUnits: Setting.int({ default: 0, min: 0, max: 10_000_000, unit: "WRU/s", label: "Maximum write throughput per index", help: "On-demand only. 0 is no maximum.", limit: Quota(SOURCES.maxThroughput) }),
      entryBytes: Setting.int({
        default: 0,
        min: 0,
        max: 409_600,
        unit: "bytes",
        label: "Index entry size",
        help: "What one index entry weighs: 0 projects the whole item (ALL). For KEYS_ONLY or INCLUDE give the size of the keys plus projected attributes. Write units are charged per KB of it, read units per 4 KB."
      }),
      writeShare: Setting.ratio({
        default: 1,
        label: "Writes that touch an index",
        help: "Share of table writes that add, change or remove an entry in each index. A write that leaves the index key and projected attributes alone, or an item without the index key (a sparse index), costs the index nothing."
      }),
      keyChangeShare: Setting.ratio({
        default: 0,
        label: "Writes that change the index key",
        help: "Share of indexed writes that move an entry (change the index key). AWS charges two index writes for them: one delete and one put."
      }),
      readShare: Setting.ratio({
        default: 0,
        label: "Reads that query an index",
        help: "Share of reads that are Queries on an index instead of the table. They use the index's read capacity, are always eventually consistent, and are spread over the indexes evenly."
      }),
      keyValues: Setting.int({
        default: 0,
        min: 0,
        max: 1_000_000,
        label: "Distinct index key values",
        help: "0 spreads index entries the way the table's keys are spread. A small number (a 'status' key with 3 values) concentrates them on that many index partitions, which throttle at 1,000 writes a second each and push back on the table. A hot table key stays hot on the index."
      })
    },
    { label: "Global secondary indexes" }
  ),

  lsi: Setting.group(
    {
      count: Setting.int({
        default: 0,
        min: 0,
        max: MAX_LOCAL_INDEXES,
        label: "Local secondary indexes",
        help: "Up to 5, fixed at table creation. They share the table's capacity: each write also costs the table the index writes. The 10 GB item collection limit is documentation only here.",
        limit: Hard(SOURCES.quotas)
      }),
      entryBytes: Setting.int({ default: 0, min: 0, max: 409_600, unit: "bytes", label: "Index entry size", help: "0 projects the whole item (ALL). Otherwise the size of the keys plus projected attributes." }),
      writeShare: Setting.ratio({ default: 1, label: "Writes that touch an index", help: "Share of table writes that add, change or remove an entry in each local index." })
    },
    { label: "Local secondary indexes" }
  ),

  ttl: Setting.group(
    {
      expiresPerSecond: Setting.number({
        default: 0,
        min: 0,
        max: 1_000_000,
        step: 1,
        unit: "items/s",
        label: "Items expiring per second",
        help: "Items deleted by Time to Live. They use no write capacity on the table (AWS), but are removed from every index (index write capacity), appear in the stream, and replicate to replicas, which pay for them. AWS deletes 'within a few days' of expiry; here it is the steady rate."
      }),
      itemBytes: Setting.int({ default: 1_024, min: 1, max: ITEM_MAX_BYTES, unit: "bytes", label: "Expiring item size", help: "Assumed average size of an expiring item, which sets the size of its stream record and index writes." })
    },
    { label: "Time to Live", help: "Items expire without a request." }
  ),

  stream: Setting.group(
    {
      view: Setting.choice(["off", "keys", "new", "old", "new-and-old"], {
        default: "new-and-old",
        labels: { off: "Off", keys: "Keys only", new: "New image", old: "Old image", "new-and-old": "New and old images" },
        help: "What a stream record carries (StreamViewType). Records are produced while consumers are wired to the stream port and this isn't off; it sets the record's size."
      }),
      propagation: Setting.latency({
        mean: "100 millis",
        cv: 0.5,
        label: "Stream delay",
        help: "From a write returning to its stream record being readable. AWS says 'near-real time' and publishes no figure; an assumption."
      })
    },
    { label: "DynamoDB Streams" }
  ),

  replication: Setting.group(
    {
      lag: Setting.latency({
        mean: "800 millis",
        cv: 0.6,
        label: "Replication lag",
        help: "From a write to it reaching a replica, on top of the edge's network latency. AWS says typically a second or less; the distribution is an assumption."
      })
    },
    { label: "Global tables", help: "Applies when replicas are wired to the replicas port." }
  )
})

export type Config = typeof Config.Type

/**
 * Per-edge settings of the stream port: how a consumer reads the stream. They are the event source mapping of a Lambda
 * function (the Lambda component doesn't model that yet, so the port does the polling and calls the function itself).
 */
export const StreamConsumer = Schema.Struct({
  batchSize: Setting.int({ default: 100, min: 1, max: 10_000, label: "Batch size", help: "Records per invocation. Default 100, at most 10,000.", limit: Hard(SOURCES.lambdaParams) }),
  batchWindow: Setting.duration({
    default: 0,
    min: 0,
    max: "5 minutes",
    label: "Batching window",
    help: "Wait up to this long for a full batch before invoking. 0 invokes as soon as records are available.",
    limit: Hard(SOURCES.lambdaParams)
  }),
  parallelization: Setting.int({
    default: 1,
    min: 1,
    max: 10,
    label: "Concurrent batches per shard",
    help: "ParallelizationFactor: batches of one shard processed at the same time (records of one item stay in order).",
    limit: Hard(SOURCES.lambdaParams)
  }),
  maxRecordAge: Setting.int({
    default: -1,
    min: -1,
    max: 604_800,
    unit: "s",
    label: "Maximum record age",
    help: "Records older than this are discarded instead of retried. -1 retries until the stream drops them (24 hours): a bad record blocks its shard that long.",
    limit: Hard(SOURCES.lambdaParams)
  }),
  maxRetries: Setting.int({
    default: -1,
    min: -1,
    max: 10_000,
    label: "Maximum retries",
    help: "Retries of a failing batch before its records are discarded. -1 retries until the record expires.",
    limit: Hard(SOURCES.lambdaParams)
  }),
  bisectOnError: Setting.bool({ default: false, label: "Split failing batches", help: "A failing batch is split in two to isolate a bad record. Splitting doesn't use up retries." }),
  retryBackoff: Setting.duration({
    default: "1 second",
    min: 0,
    max: "5 minutes",
    label: "Retry backoff",
    help: "Wait before retrying a failed batch, doubling each time up to the cap below. AWS doesn't publish the schedule; an assumption."
  }),
  maxRetryBackoff: Setting.duration({ default: "1 minute", min: 0, max: "1 hour", label: "Retry backoff cap", help: "An assumption: AWS doesn't publish it." }),
  timeout: Setting.duration({
    default: "5 minutes",
    min: "1 millis",
    max: "10 minutes",
    label: "Timeout",
    help: "How long the poller waits for the function before it gives up on the invocation and retries the batch."
  })
})

/** Replication to another region retries until it lands: AWS replicates every change eventually. */
export const Replica = Schema.Struct({
  retry: Edge.retryWith({ maxAttempts: 10, backoff: "1 second", backoffFactor: 2, maxBackoff: "30 seconds", jitter: true })
})

/** Records a consumer gave up on (the event source mapping's on-failure destination). */
export const Discard = Schema.Struct({
  retry: Edge.retryWith({ maxAttempts: 3, backoff: "1 second", backoffFactor: 2, maxBackoff: "10 seconds", jitter: true })
})

export const ports = {
  out: Component.port.many("Next"),
  stream: Component.port.many("DynamoDB Stream", StreamConsumer),
  replicas: Component.port.replication("Global table replicas", Replica),
  discarded: Component.port.many("Discarded stream records", Discard)
}
