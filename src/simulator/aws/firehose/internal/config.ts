import { Schema } from "effect"
import * as Setting from "../../../Setting.ts"
import { docs } from "../../internal/docs.ts"
import { KiB, MiB } from "../../internal/units.ts"

const F = docs.firehose
const API = docs.firehoseApi

/** The pages the numbers below come from (the README lists each number with its page). */
export const SOURCES = {
  limits: `${F}limits.html`,
  quotas: "https://docs.aws.amazon.com/general/latest/gr/fh.html",
  buffering: `${F}create-configure-backup.html#buffering-hints`,
  bufferingApi: `${API}API_BufferingHints.html`,
  delivery: `${F}basic-deliver.html`,
  retry: `${F}retry.html`,
  http: `${F}httpdeliveryrequestresponse.html`,
  httpRetryApi: `${API}API_HttpEndpointRetryOptions.html`,
  transform: `${F}data-transformation.html`,
  transformFailure: `${F}data-transformation-failure-handling.html`,
  processorApi: `${API}API_ProcessorParameter.html`,
  kinesisSource: `${F}writing-with-kinesis-streams.html`,
  metrics: `${F}monitoring-with-cloudwatch-metrics.html`
} as const

// ---------------------------------------------------------------------------------------------------------
// Published numbers.
// ---------------------------------------------------------------------------------------------------------

/** The largest record Firehose takes, before base64: 1,000 KiB (limits page). */
export const MAX_RECORD_BYTES = 1_000 * KiB
/** PutRecordBatch: 500 records or 4 MiB, whichever is smaller (limits page). */
export const BATCH_MAX_RECORDS = 500
export const BATCH_MAX_BYTES = 4 * MiB
/** A Direct PUT stream keeps undelivered data for 24 hours; after that it is lost (limits page, retry page). */
export const DIRECT_PUT_RETENTION_MS = 24 * 60 * 60 * 1000
/** The buffer size hint ranges 1-128 MiB for S3 and 1-64 MiB for an HTTP endpoint (buffering hints table). */
export const MAX_BUFFER_MIB = 128
export const HTTP_MAX_BUFFER_MIB = 64
/** An HTTP endpoint request carries at most 10,000 records (HTTP request specification). */
export const HTTP_MAX_RECORDS = 10_000
/** HTTP endpoints have 3 minutes to answer before Firehose times the request out (HTTP request specification). */
export const HTTP_TIMEOUT_MS = 3 * 60_000
/**
 * Firehose's retry schedule for an HTTP endpoint: 1 s, doubling, capped at 2 minutes, with 15% jitter either way
 * (HTTP request specification). The S3 retry cadence isn't published and this schedule is used for it too.
 */
export const RETRY_INITIAL_MS = 1_000
export const RETRY_MAX_MS = 120_000
export const RETRY_JITTER = 0.15
/** The transformation Lambda may run for up to 5 minutes; Firehose allows 5 outstanding invocations per shard (data-transformation, limits). */
export const TRANSFORM_TIMEOUT_MS = 5 * 60_000
export const TRANSFORM_CONCURRENCY = 5
/** Firehose reads a source stream's shards once a second each (writing-with-kinesis-streams). */
export const KINESIS_POLL_MS = 1_000

// ---------------------------------------------------------------------------------------------------------
// Assumptions: AWS doesn't publish these.
// ---------------------------------------------------------------------------------------------------------

/** A buffer interval of 0 delivers "within a few seconds": a buffer is flushed once a second. */
export const ZERO_BUFFER_MS = 1_000
/** A failed transformation invocation is retried after this long. */
export const TRANSFORM_RETRY_MS = 1_000
/** Bytes of one record Firehose writes to the error prefix for a failed record (its metadata, beside the data). */
export const ERROR_RECORD_OVERHEAD = 300

// ---------------------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------------------

/** A Firehose stream (a delivery stream). Setting names are stable: designs and examples use them. */
export const DeliveryStream = Schema.Struct({
  destination: Setting.choice(["s3", "http"], {
    default: "s3",
    labels: { s3: "Amazon S3", http: "HTTP endpoint" },
    label: "Destination",
    help: "What the 'out' port is. Amazon S3: one object per buffer, retried for 24 hours (or as long as a source stream keeps the records). HTTP endpoint (or a partner such as Datadog or Splunk): one request per buffer, retried for the retry duration, then backed up to the S3 bucket on the 'backup' port."
  }),
  bufferSize: Setting.int({
    default: 5,
    min: 1,
    max: MAX_BUFFER_MIB,
    unit: "MiB",
    label: "Buffer size",
    help: "Deliver once this much has gathered, or when the interval is up, whichever comes first. A hint: Firehose grows the buffer when delivery falls behind. HTTP endpoints take at most 64 MiB. With a Kinesis source each shard has its own buffer.",
    limit: Setting.hard(SOURCES.buffering, "S3 1-128 MiB (5); HTTP endpoint 1-64 MiB (5).")
  }),
  bufferInterval: Setting.duration({
    default: "300 seconds",
    min: 0,
    max: "900 seconds",
    label: "Buffer interval",
    help: "Deliver what has gathered this long after the first record of a buffer arrived. 0 delivers within a few seconds (once a second is assumed). AWS's default is 300 s for S3 and 60 s for an HTTP endpoint.",
    limit: Setting.hard(SOURCES.buffering, "0-900 s; S3 300 s by default, HTTP endpoint 60 s.")
  }),
  retryDuration: Setting.duration({
    default: "300 seconds",
    min: 0,
    max: "7200 seconds",
    label: "Retry duration (HTTP endpoint)",
    help: "How long a failing delivery to an HTTP endpoint is retried before the data is backed up to S3. 0 doesn't retry. S3 destinations ignore it: they retry for 24 hours. AWS gives no default for HTTP endpoints; 300 s is its OpenSearch default.",
    limit: Setting.hard(SOURCES.httpRetryApi)
  }),
  transform: Setting.group(
    {
      bufferSize: Setting.number({
        default: 1,
        min: 0.2,
        max: 3,
        step: 0.1,
        unit: "MB",
        label: "Buffer size",
        help: "Records are sent to the transformation Lambda in batches of about this much.",
        limit: Setting.hard(SOURCES.processorApi)
      }),
      bufferInterval: Setting.duration({
        default: "60 seconds",
        min: 0,
        max: "900 seconds",
        label: "Buffer interval",
        help: "Or after this long, whichever comes first.",
        limit: Setting.hard(SOURCES.transform)
      }),
      retries: Setting.int({
        default: 3,
        min: 0,
        max: 10,
        label: "Retries",
        help: "Retries of a failed invocation (a timeout, a throttle, an error) before its records are treated as failed and written to the error prefix. AWS's default is 3; it publishes no maximum (10 here)."
      }),
      outputRatio: Setting.number({
        default: 1,
        min: 0,
        max: 10,
        step: 0.1,
        label: "Output size ratio",
        help: "Bytes the function returns per byte it is given (compacting or enriching the records). An assumption about your function."
      })
    },
    { label: "Transformation", help: "Used when a Lambda function is wired to the 'transform' port." }
  )
})
export type DeliveryConfig = typeof DeliveryStream.Type

/**
 * The destination edge. Firehose retries on its own schedule (above), so the edge's own retries are best left at one
 * attempt; its timeout defaults to the 3 minutes an HTTP endpoint is given.
 */
export const Out = Schema.Struct({
  timeout: Setting.duration({
    default: HTTP_TIMEOUT_MS,
    min: "1 millis",
    max: "10 minutes",
    label: "Timeout",
    help: "How long Firehose waits for one delivery before counting it failed and retrying. HTTP endpoints get 3 minutes (AWS); AWS doesn't say how long it waits on S3."
  })
})

/** The transformation edge: Firehose lets the function run for up to 5 minutes. */
export const TransformEdge = Schema.Struct({
  timeout: Setting.duration({
    default: TRANSFORM_TIMEOUT_MS,
    min: "1 millis",
    max: TRANSFORM_TIMEOUT_MS,
    label: "Timeout",
    help: "How long Firehose waits for the transformation Lambda. It supports invocations of up to 5 minutes; past that it is a failed invocation, retried like any other.",
    limit: Setting.hard(SOURCES.transform)
  })
})

/** Regions whose Direct PUT quotas are the larger ones (General Reference). */
const BIG = ["us-east-1", "us-west-2", "eu-west-1"]

/** Direct PUT throughput of one Firehose stream in `region`: MiB/s, records/s and requests/s, raised together. */
export const directPutBase = (region: string) =>
  BIG.includes(region) ? { mibps: 5, records: 500_000, requests: 2_000 } : { mibps: 1, records: 100_000, requests: 1_000 }
