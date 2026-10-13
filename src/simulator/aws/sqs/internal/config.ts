import { Schema } from "effect"
import * as Setting from "../../../Setting.ts"
import { docs } from "../../internal/docs.ts"

const D = docs.sqs
const L = docs.lambda

// ---------------------------------------------------------------------------------------------------------
// Published numbers the behaviour is built on (the README lists each with its source and whether it is hard,
// a quota or an assumption).
// ---------------------------------------------------------------------------------------------------------

/** Largest message, and largest total of one send batch: 1 MiB (the general reference still says 256 KB; it is stale). */
export const MAX_MESSAGE_BYTES = 1_048_576
/** Lambda hands a function at most 6 MB of records per invocation (synchronous payload limit); a batch is cut there. */
export const MAX_BATCH_BYTES = 6 * 1024 * 1024
/** A send, receive or delete batch is at most ten messages; it is also the unit the FIFO API limits count in. */
export const API_BATCH = 10
/** FIFO in normal mode: 300 API calls per second per action, per queue (one partition). */
export const FIFO_NORMAL_TPS = 300
/** One FIFO partition takes 300 calls per second; a message group lives on one partition, so one group can't send faster. */
export const FIFO_PARTITION_TPS = 300
/** FIFO deduplication: a deduplication id is remembered for five minutes after the message was accepted. */
export const DEDUP_WINDOW_MS = 5 * 60_000
/** Without provisioned mode, an event source mapping scales up to 1,250 concurrent invocations at most. */
export const ESM_CEILING = 1_250
/** Provisioned mode: a poller drives up to 10 concurrent invocations, and the mapping adds up to 1,000 per minute, to 100,000. */
export const PROVISIONED_INVOKES_PER_POLLER = 10
export const PROVISIONED_SCALE_PER_MINUTE = 1_000
export const PROVISIONED_CEILING = 100_000
/** Long polling waits at most 20 seconds, which is how often an idle poller completes an (empty) receive. */
export const LONG_POLL_MS = 20_000
/** A custom redrive velocity is at most 500 messages per second. */
export const REDRIVE_MAX_VELOCITY = 500
/**
 * A standard queue that has delivered a message this many times without a delete moves it to the back of the queue, and
 * stops counting it in ApproximateAgeOfOldestMessage (poison pill).
 */
export const POISON_RECEIVES = 3

// Assumptions: AWS does not publish these.
/** "System optimised" redrive velocity: AWS says "the maximum number of messages per second" and gives no number. */
export const REDRIVE_SYSTEM_VELOCITY = 1_000
/** A move to the dead-letter queue that fails (the queue is down or refusing) is attempted again after this long. Real SQS moves internally and does not fail this way. */
export const DLQ_RETRY_MS = 1_000
/** How often retention is enforced. AWS deletes expired messages in the background without a stated cadence. */
export const SWEEP_MS = 1_000
/** How often an event source mapping re-evaluates how many pollers it wants. */
export const RESCALE_MS = 1_000

/** What polls a queue and hands messages to a consumer: batching and concurrency. An event source mapping, in Lambda's terms. */
export const Consumer = Schema.Struct({
  batchSize: Setting.int({
    default: 10,
    min: 1,
    max: 10_000,
    unit: "messages",
    label: "Batch size",
    help: "Messages per invocation. FIFO queues cap at 10; above 10 AWS requires a batching window of at least a second. A batch is also cut at 6 MB.",
    limit: Setting.hard(`${L}services-sqs-parameters.html`, "FIFO: 10. Standard: 10,000.")
  }),
  batchWindow: Setting.duration({
    default: 0,
    min: 0,
    max: "5 minutes",
    label: "Batching window",
    help: "How long to wait for a batch to fill. Standard queues only. The messages are already received, so their visibility timeout is running while the batch fills: AWS advises a visibility timeout of six times the function timeout plus this window.",
    limit: Setting.hard(`${L}services-sqs-configure.html`)
  }),
  maxConcurrency: Setting.int({
    default: 0,
    min: 0,
    max: 1_000,
    unit: "invocations",
    label: "Maximum concurrency",
    help: "Cap on concurrent invocations from this queue. 0 for none (the mapping then scales up to 1,250). AWS accepts 2 to 1,000, and not together with provisioned mode.",
    limit: Setting.hard(`${L}services-sqs-scaling.html`, "AWS accepts 2 to 1,000.")
  }),
  initialConcurrency: Setting.int({
    default: 5,
    min: 1,
    max: 1_250,
    unit: "invocations",
    label: "Starting concurrency",
    help: "A standard queue's mapping starts with 5 concurrent batches. AWS fixes this at 5; it is editable here to explore what-ifs.",
    limit: Setting.hard(`${L}services-sqs-scaling.html`)
  }),
  scaleUpPerMinute: Setting.int({
    default: 300,
    min: 0,
    max: 10_000,
    unit: "per minute",
    label: "Scale-up rate",
    help: "Invocations added each minute while messages are waiting, up to 1,250. AWS publishes this for standard queues only; the same ramp is used for FIFO.",
    limit: Setting.hard(`${L}services-sqs-scaling.html`)
  }),
  reportBatchItemFailures: Setting.bool({
    default: false,
    label: "Report batch item failures",
    help: "FunctionResponseTypes: ReportBatchItemFailures. A function that returns the records that failed has only those come back after the visibility timeout; the rest are deleted. Off, such a reply is ignored: the invocation succeeded, so the whole batch is deleted, the failed records with it. A FIFO batch keeps a failed record's later messages of the same group too, as a correct FIFO handler reports them."
  }),
  throttleRetry: Setting.duration({
    default: "1 second",
    min: "100 millis",
    max: "1 minute",
    label: "Throttle retry",
    help: "When the function is throttled, the mapping keeps the batch and tries again after this long, until the queue's visibility timeout runs out. AWS says Lambda backs off and retries but publishes no interval: this is an assumption."
  }),
  provisionedMinPollers: Setting.int({
    default: 0,
    min: 0,
    max: 200,
    unit: "pollers",
    label: "Provisioned mode: minimum pollers",
    help: "0 leaves provisioned mode off. Otherwise (AWS accepts 2 to 200) the mapping starts with this many dedicated pollers, each driving up to 10 concurrent invocations, and adds up to 1,000 invocations a minute. Overrides maximum concurrency, as in AWS.",
    limit: Setting.hard(`${L}with-sqs.html`)
  }),
  provisionedMaxPollers: Setting.int({
    default: 200,
    min: 2,
    max: 10_000,
    unit: "pollers",
    label: "Provisioned mode: maximum pollers",
    help: "Upper bound on pollers in provisioned mode: 100,000 concurrent invocations at 10,000. The AWS pages disagree on this maximum (2,000 on the parameters page, 10,000 on the newer scaling pages); the newer figure is used.",
    limit: Setting.hard(`${L}with-sqs.html`)
  })
})

/** Everything a queue is configured with. Setting names are stable: designs, examples and the CloudFormation importer use them. */
export const Queue = Schema.Struct({
  kind: Setting.choice(["standard", "fifo"], {
    default: "standard",
    labels: { standard: "Standard", fifo: "FIFO" },
    help: "FIFO delivers one message per message group at a time, and is rate-limited. The type is fixed when the queue is created (a standard queue can't be turned into a FIFO one)."
  }),
  retention: Setting.duration({
    default: "4 days",
    min: "1 minute",
    max: "14 days",
    label: "Message retention",
    help: "Messages are deleted this long after they were enqueued, whether or not they were received. A standard dead-letter queue counts from the message's original enqueue time, so give it a longer retention than its source.",
    limit: Setting.hard(`${D}quotas-messages.html`)
  }),
  visibilityTimeout: Setting.duration({
    default: "30 seconds",
    min: 0,
    max: "12 hours",
    label: "Visibility timeout",
    help: "A delivered message stays hidden this long. If it isn't deleted in time it is delivered again. AWS suggests at least six times a Lambda consumer's timeout (plus its batching window).",
    limit: Setting.hard(`${D}quotas-messages.html`)
  }),
  delay: Setting.duration({
    default: 0,
    min: 0,
    max: "15 minutes",
    label: "Delivery delay",
    help: "New messages stay invisible this long (a delay queue). Per-message timers aren't modelled.",
    limit: Setting.hard(`${D}sqs-delay-queues.html`)
  }),
  maxReceives: Setting.int({
    default: 5,
    min: 1,
    max: 1_000,
    label: "Max receives",
    help: "With a dead-letter queue connected: after this many deliveries without a delete, the message moves there. Without one, messages are retried until retention ends. AWS recommends at least 5 for a Lambda consumer.",
    limit: Setting.hard(`${D}sqs-configure-dead-letter-queue.html`)
  }),
  inFlightLimit: Setting.int({
    default: 120_000,
    min: 1,
    max: 10_000_000,
    unit: "messages",
    label: "In-flight limit",
    help: "Messages delivered but not yet deleted. At the limit, consumers receive nothing until it drops. About 120,000 for a standard queue (raisable); AWS says a FIFO queue's depends on its active message groups and is also 120,000 by default.",
    limit: Setting.quota(`${D}quotas-queues.html`)
  }),
  highThroughput: Setting.bool({
    default: false,
    label: "FIFO high throughput",
    help: "FIFO only. Raises the rate limit to the region's high-throughput quota (set in the account quotas). A single message group is still held to one partition's 300 calls a second."
  }),
  deduplication: Setting.bool({
    default: false,
    label: "FIFO deduplication",
    help: "FIFO only. A message whose id was accepted in the last five minutes is acknowledged but not enqueued again, which is what a producer retrying a send with the same deduplication id gets. The sender's message id is the deduplication id: two different messages with identical bodies can't be told apart, so content-based deduplication isn't modelled."
  }),
  redrive: Setting.bool({
    default: false,
    label: "Redrive messages",
    help: "Moves this queue's waiting messages to the queue on its 'redrive' port, oldest first, at the velocity below, until switched off. This is DLQ redrive: the messages become new messages in the destination with a fresh retention clock."
  }),
  redriveVelocity: Setting.int({
    default: 0,
    min: 0,
    max: REDRIVE_MAX_VELOCITY,
    unit: "messages/s",
    label: "Redrive velocity",
    help: "Messages moved per second. 0 is 'system optimised', which AWS describes as the maximum and gives no number for: 1,000 a second is assumed.",
    limit: Setting.hard(`${D}sqs-configure-dead-letter-queue-redrive.html`, "A custom velocity is at most 500 messages per second.")
  })
})

export type QueueConfig = typeof Queue.Type
