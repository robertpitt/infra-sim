import { Schema } from "effect"
import * as Edge from "../../Edge.ts"
import * as Setting from "../../Setting.ts"
import { docs } from "../docs.ts"

const K = docs.kinesis
const API = docs.kinesisApi
const L = docs.lambda

/** The pages the numbers below come from (the README lists each number with its page). */
export const SOURCES = {
  limits: `${K}service-sizes-and-limits.html`,
  modes: `${K}how-do-i-size-a-stream.html`,
  largeRecords: `${K}large-records.html`,
  retention: `${K}kinesis-extended-retention.html`,
  efo: `${K}enhanced-consumers.html`,
  monitoring: `${K}monitoring-with-cloudwatch.html`,
  putRecords: `${API}API_PutRecords.html`,
  getRecords: `${API}API_GetRecords.html`,
  updateShardCount: `${API}API_UpdateShardCount.html`,
  quotas: "https://docs.aws.amazon.com/general/latest/gr/ak.html",
  lambda: `${L}with-kinesis.html`,
  lambdaParams: `${L}services-kinesis-parameters.html`,
  lambdaApi: "https://docs.aws.amazon.com/lambda/latest/api/API_CreateEventSourceMapping.html",
  lambdaErrors: `${L}kinesis-on-failure-destination.html`,
  lambdaItemFailures: `${L}services-kinesis-batchfailurereporting.html`
} as const

export const KiB = 1024
export const MiB = 1024 * KiB

// ---------------------------------------------------------------------------------------------------------
// Published numbers (hard limits unless said otherwise). The docs write "1 MB" and "1 MiB" for the same shard limit
// on different pages; MiB is used throughout.
// ---------------------------------------------------------------------------------------------------------

/** A shard takes writes of up to 1 MiB a second and 1,000 records a second (limits page, PutRecords). */
export const SHARD_WRITE_BYTES = MiB
export const SHARD_WRITE_RECORDS = 1_000
/** A shard serves 2 MiB a second and five GetRecords calls a second, shared by every standard consumer (limits page). */
export const SHARD_READ_BYTES = 2 * MiB
export const SHARD_READ_CALLS = 5
/** One GetRecords call returns at most 10,000 records and 10 MiB (GetRecords). */
export const GET_RECORDS_MAX_RECORDS = 10_000
export const GET_RECORDS_MAX_BYTES = 10 * MiB
/** A throttled GetRecords: "subsequent calls made within the next 1 second throw", so a reader waits a second (GetRecords). */
export const READ_THROTTLE_WAIT_MS = 1_000
/** PutRecords takes at most 500 records and 10 MiB in one request (PutRecords; it was 5 MiB before the large-record launch). */
export const PUT_RECORDS_MAX_RECORDS = 500
export const PUT_RECORDS_MAX_BYTES = 10 * MiB
/** An enhanced fan-out consumer gets its own 2 MiB a second from each shard (enhanced-consumers). */
export const EFO_READ_BYTES = 2 * MiB
/** Registered (enhanced fan-out) consumers per stream: 20, or 50 with On-demand Advantage, which isn't modelled. */
export const EFO_CONSUMERS = 20
/** A new on-demand stream can write 4 MB/s and read 8 MB/s: four shards' worth (limits page). */
export const ON_DEMAND_INITIAL_SHARDS = 4
/** On-demand splits a shard whose incoming traffic exceeds 500 KB/s (modes page). */
export const ON_DEMAND_SPLIT_BYTES = 500 * KiB
/** UpdateShardCount: at most double or half the current count in one call, ten calls in a rolling 24 hours, 10,000 shards a stream. */
export const UPDATE_SHARD_COUNT_PER_DAY = 10
export const MAX_SHARDS_PER_STREAM = 10_000
/** Lambda: a batch is cut at the 6 MB synchronous invocation payload (with-kinesis). */
export const LAMBDA_MAX_BATCH_BYTES = 6 * MiB
/** Lambda's standard-iterator poller reads each shard "at a base rate of once per second" when it has caught up (with-kinesis). */
export const LAMBDA_POLL_MS = 1_000
/** MaximumRecordAgeInSeconds: values from 0 to 59 are refused; the smallest age that can be set is 60 s (CreateEventSourceMapping). */
export const MIN_RECORD_AGE_S = 60
/** Bytes of the invocation record Lambda sends to an on-failure destination: the batch's metadata, not its records. */
export const DISCARD_RECORD_BYTES = KiB

// ---------------------------------------------------------------------------------------------------------
// Assumptions: AWS doesn't publish these.
// ---------------------------------------------------------------------------------------------------------

/**
 * Records written within this long of each other share a segment, and a segment becomes readable this long after its
 * first record: the stream's propagation delay. AWS quotes an average of about 70 ms to an enhanced fan-out consumer
 * and 200 ms to one GetRecords reader (enhanced-consumers); 200 ms segments give about 100 ms on average before the poll.
 */
export const SEGMENT_MS = 200
/** Records a key-hash range is cut into within one shard, so a parallelization factor can split a shard by key (1 to 10). */
export const SLICES = 10
/**
 * The per-shard write burst: one second's worth, or one record of the stream's maximum size when that is bigger (AWS
 * describes large records as drawing on a "burst capacity" it doesn't size).
 */
export const WRITE_BURST_S = 1
/**
 * On-demand watches each shard's incoming traffic as an average over about a minute (an exponential average with this
 * time constant) before it decides a shard needs splitting. AWS says only that it monitors traffic per shard.
 */
export const ON_DEMAND_WINDOW_MS = 60_000
/**
 * On-demand splits on records too: a shard taking more than half its 1,000 records a second is split, as a shard taking
 * more than half its bytes is. AWS publishes only the 500 KB/s threshold.
 */
export const ON_DEMAND_SPLIT_RECORDS = SHARD_WRITE_RECORDS / 2
/** How long one UpdateShardCount step keeps the stream UPDATING. AWS: "could take a few minutes". */
export const RESHARD_MS = 2 * 60_000
/** How often scaling, retention and trimming are looked at. */
export const TICK_MS = 1_000
/**
 * How long an unacknowledged lease from the generic (non-Lambda) consumer lasts before its records are offered again:
 * a Kinesis Client Library worker that died is replaced and restarts from its last checkpoint.
 */
export const GENERIC_LEASE_MS = 60_000
/** How long Lambda waits for one invocation: the function's own 15-minute timeout ends a slow batch first. */
export const LAMBDA_INVOKE_TIMEOUT_MS = 15 * 60_000 + 30_000

// ---------------------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------------------

/** A data stream. Setting names are stable: designs and examples use them. */
export const Stream = Schema.Struct({
  mode: Setting.choice(["provisioned", "on-demand"], {
    default: "provisioned",
    labels: { provisioned: "Provisioned", "on-demand": "On-demand" },
    label: "Capacity mode",
    help: "Provisioned: you choose the shards, each 1 MiB/s and 1,000 records/s in, 2 MiB/s out. On-demand: starts at four shards (4 MB/s) and splits any shard taking more than 500 KB/s, so it holds about twice its peak; traffic that more than doubles faster than it splits is throttled. Switching keeps the shards there are."
  }),
  shards: Setting.int({
    default: 1,
    min: 1,
    max: MAX_SHARDS_PER_STREAM,
    unit: "shards",
    label: "Shards",
    help: "Provisioned mode. Changing it while running is UpdateShardCount: uniform scaling, at most double or half the current count per step (a few minutes each, assumed 2), ten steps in 24 hours. Old shards close and are read to their end before their children.",
    limit: Setting.quota(SOURCES.updateShardCount, "10,000 a stream by default; the account's shard quota is in the region's quotas.")
  }),
  retention: Setting.duration({
    default: "24 hours",
    min: "24 hours",
    max: "8760 hours",
    label: "Retention",
    help: "How long records stay readable. A consumer blocked by a failing batch, or simply behind, loses what is older than this.",
    limit: Setting.hard(SOURCES.retention)
  }),
  maxRecordSize: Setting.int({
    default: 1_024,
    min: 1_024,
    max: 10_240,
    unit: "KiB",
    label: "Maximum record size",
    help: "Records up to this size are accepted (1 MiB by default, up to 10 MiB). A large record draws on the shard's burst and can throttle the writes behind it.",
    limit: Setting.hard(SOURCES.largeRecords)
  }),
  splitDelay: Setting.duration({
    default: "15 minutes",
    min: 0,
    max: "1 hour",
    label: "On-demand split delay",
    help: "How long after a shard goes over 500 KB/s (or 500 records/s) on-demand splits it. AWS says it splits \"within 15 minutes\" and that traffic more than doubling inside 15 minutes can be throttled; the bound is used."
  })
})
export type StreamConfig = typeof Stream.Type

/** Lambda's event source mapping for a stream: the edge from the stream's consumers port to a function. */
export const Mapping = Schema.Struct({
  batchSize: Setting.int({
    default: 100,
    min: 1,
    max: 10_000,
    unit: "records",
    label: "Batch size",
    help: "Records per invocation, at most. A batch is also cut at 6 MB, Lambda's payload limit.",
    limit: Setting.hard(SOURCES.lambdaParams)
  }),
  batchWindow: Setting.duration({
    default: 0,
    min: 0,
    max: "5 minutes",
    label: "Batching window",
    help: "Wait up to this long for a full batch before invoking. 0 invokes as soon as records are read.",
    limit: Setting.hard(SOURCES.lambdaParams)
  }),
  parallelization: Setting.int({
    default: 1,
    min: 1,
    max: 10,
    label: "Parallelization factor",
    help: "Batches processed from each shard at the same time. Records with the same partition key stay in order: a shard is split by key into this many lanes, so a hot key stays in one lane and gains nothing.",
    limit: Setting.hard(SOURCES.lambdaParams)
  }),
  maxRecordAge: Setting.int({
    default: -1,
    min: -1,
    max: 604_800,
    unit: "s",
    label: "Maximum record age",
    help: "A failing batch whose oldest record is older than this is discarded instead of retried. -1: retried until the stream's retention drops it, so one bad record blocks its shard that long. AWS refuses 0 to 59; they are read as 60.",
    limit: Setting.hard(SOURCES.lambdaParams)
  }),
  maxRetries: Setting.int({
    default: -1,
    min: -1,
    max: 10_000,
    label: "Maximum retry attempts",
    help: "Retries of a batch the function failed before it is discarded. -1: until it expires. Throttling doesn't count: a throttled batch is retried until it is too old.",
    limit: Setting.hard(SOURCES.lambdaParams)
  }),
  bisectOnError: Setting.bool({
    default: false,
    label: "Split batch on error",
    help: "BisectBatchOnFunctionError: a batch the function failed is split in two, the halves tried in order, until the bad record is alone. Splitting doesn't use up retries."
  }),
  reportBatchItemFailures: Setting.bool({
    default: false,
    label: "Report batch item failures",
    help: "A function that returns failed records has the batch checkpointed before the first of them and retried from there. Off, such a reply is a success and the failed records are skipped."
  }),
  enhancedFanOut: Setting.bool({
    default: false,
    label: "Enhanced fan-out",
    help: "Read through a registered consumer: records are pushed (no polling) and this mapping gets its own 2 MiB/s per shard instead of sharing 2 MiB/s and five calls a second with every other standard reader. A stream can register 20."
  }),
  retryBackoff: Setting.duration({
    default: "1 second",
    min: 0,
    max: "5 minutes",
    label: "Retry backoff",
    help: "Wait before retrying a failed batch, doubling each time up to the cap. AWS doesn't publish the schedule: an assumption."
  }),
  maxRetryBackoff: Setting.duration({ default: "1 minute", min: 0, max: "1 hour", label: "Retry backoff cap", help: "An assumption: AWS doesn't publish it." }),
  poisonRecords: Setting.ratio({
    default: 0,
    label: "Poison records",
    help: "Share of records this function can never process (bad data meeting this code). A batch holding one fails every time; with batch item failures on, the function reports it instead. A modelling device: the stream carries no record contents."
  })
})
export type MappingConfig = typeof Mapping.Type

/** The on-failure destination: Lambda sends it the batch's metadata, retrying a refused send a few times. */
export const Discard = Schema.Struct({
  retry: Edge.retryWith({ maxAttempts: 3, backoff: "1 second", backoffFactor: 2, maxBackoff: "10 seconds", jitter: true })
})
