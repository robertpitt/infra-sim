import { Schema } from "effect"
import * as Edge from "../../Edge.ts"
import * as Setting from "../../Setting.ts"
import { docs } from "../docs.ts"

/**
 * What SNS publishes about itself, as constants with their sources. Anything that is not on a documentation page is
 * labelled an assumption.
 */

/** Largest topic message by default: 256 KiB (`MaximumMessageSize` defaults to 262,144 bytes). */
export const DEFAULT_MESSAGE_KB = 256
/** `MaximumMessageSize` goes up to 1 MiB; above 256 KiB a topic may have 100 subscriptions at most. */
export const LARGE_MESSAGE_SUBSCRIPTIONS = 100
/** One message group delivers at most 300 messages per second, in either throughput mode. */
export const FIFO_GROUP_RATE = 300
/** A FIFO topic in `Topic` throughput scope: 3,000 messages per second ... */
export const FIFO_TOPIC_RATE = 3_000
/** ... or 20 MB per second, whichever comes first. The page says "MB"; read as MiB. */
export const FIFO_TOPIC_BYTES_PER_SECOND = 20 * 1024 * 1024
/** FIFO deduplication window: five minutes. */
export const DEDUPLICATION_WINDOW_MS = 5 * 60 * 1000
/**
 * Assumption: how many deduplication ids a topic remembers. A FIFO topic can see 3,000 messages a second, which over
 * five minutes is 900,000 ids; the simulator keeps the newest half million so memory stays bounded on a long run.
 */
export const DEDUPLICATION_CAPACITY = 500_000
/**
 * Assumption: bytes the JSON envelope adds to a notification when raw message delivery is off (type, message id, topic
 * ARN, timestamp, a 344-character signature, the signing certificate and unsubscribe URLs). Measured on the example
 * notification in the developer guide, which is about 1 KB.
 */
export const ENVELOPE_BYTES = 1_024

/**
 * What a subscription is: an edge from the topic to a subscriber. Its settings are the subscription's attributes.
 *
 * `retry` is the delivery policy. SNS retries a failing SQS or Lambda endpoint for 23 days (100,015 attempts: three at
 * once, two a second apart, ten backing off from 1 to 20 s, then one every 20 s). Edge retries stop at 100 attempts, so
 * the default here is the shape of that policy (exponential from 1 s up to 20 s, jittered) for as long as the engine
 * goes, which is about a quarter of an hour. An HTTP/S subscription's own policy maps onto the same fields:
 * `numRetries + 1` is the attempts, `minDelayTarget` the initial backoff and `maxDelayTarget` the cap.
 */
export const Subscription = Schema.Struct({
  filterMatch: Setting.ratio({
    default: 1,
    label: "Filter policy match rate",
    help: "The share of messages this subscription's filter policy lets through; the rest are filtered out and never delivered. 1 means no filter policy. Simulated messages carry no attributes or body to match, so this is a rate, not a rule."
  }),
  rawMessageDelivery: Setting.bool({
    default: true,
    label: "Raw message delivery",
    help: `On: the subscriber gets exactly what was published. Off: SNS wraps it in a JSON envelope of about ${ENVELOPE_BYTES} bytes (an assumption). AWS's own default is off; the simulator defaults to on so a design's message sizes are unchanged.`
  }),
  deadLetterQueue: Setting.bool({
    default: false,
    label: "Dead-letter queue",
    help: "When delivery finally fails (retries used up, or the endpoint refuses the message), send the message to the queue wired to this topic's dead-letter port instead of discarding it. The redrive policy of the subscription."
  }),
  maxReceivesPerSecond: Setting.int({
    default: 0,
    min: 0,
    max: 10_000_000,
    unit: "msg/s",
    label: "Delivery throttle",
    help: "The throttle policy of an HTTP/S delivery policy (maxReceivesPerSecond): SNS holds deliveries back to this average rate per subscription, and held messages do not use up retries. 0 for no throttle."
  }),
  retry: Edge.retryWith({ maxAttempts: 100, backoff: "1 second", backoffFactor: 2, maxBackoff: "20 seconds", jitter: true })
})

/** An edge leaving the `out` port. */
export type SubscriptionEdge = Edge.Config & typeof Subscription.Type

export const Topic = Schema.Struct({
  kind: Setting.choice(["standard", "fifo"], {
    default: "standard",
    labels: { standard: "Standard", fifo: "FIFO" },
    help: "FIFO keeps the order of each message group and can deduplicate, and is limited to 300 messages a second per group. Its subscribers must be SQS queues."
  }),
  maxMessageSize: Setting.int({
    default: DEFAULT_MESSAGE_KB,
    min: 1,
    max: 1_024,
    unit: "KB",
    label: "Maximum message size",
    help: `256 KB by default; a topic can raise it to 1 MiB (the \`MaximumMessageSize\` attribute), which AWS only allows with ${LARGE_MESSAGE_SUBSCRIPTIONS} subscriptions or fewer. The size counts the body and the attributes of a publish, or of a whole batch.`,
    limit: Setting.hard(`${docs.sns}large-message-payloads.html`)
  }),
  publishLatency: Setting.latency({ mean: "5 millis", cv: 0.3, label: "Publish latency", help: "How long a publish takes to be acknowledged. AWS publishes no figure; an assumption." }),
  deliveryLatency: Setting.latency({
    mean: 0,
    cv: 0.3,
    label: "Delivery latency",
    help: "Time between a publish being accepted and SNS handing the message to a subscriber. AWS publishes no figure; an assumption, and 0 so that deliveries start at once. On a FIFO topic it is spent inside the message group, so it also limits how fast a group can go."
  }),
  fifoThroughput: Setting.choice(["topic", "messageGroup"], {
    default: "topic",
    labels: { topic: "Topic (default)", messageGroup: "Message group (high throughput)" },
    help: "FIFO only (the FifoThroughputScope attribute). Topic scope: the topic as a whole is limited to 3,000 messages or 20 MB a second, and deduplicates across the topic. Message group scope lifts the topic limit to the region's publish quota, with deduplication per group. A group always stays at 300 a second. AWS does not let a topic go back to Topic scope once it has been changed."
  }),
  deduplication: Setting.bool({
    default: false,
    label: "FIFO deduplication",
    help: "FIFO only. A publish whose message was already accepted in the last five minutes (a publisher retrying after a timeout) is acknowledged but not delivered again. Real FIFO topics always deduplicate; this is off by default because it costs memory proportional to the publish rate over five minutes."
  }),
  maxPendingPerSubscription: Setting.int({
    default: 100_000,
    min: 1,
    max: 10_000_000,
    unit: "messages",
    label: "Pending deliveries per subscription",
    help: "SNS keeps retrying a message for up to 23 days; the simulator has to bound what it remembers. Deliveries waiting on a subscriber (retrying, queued behind a FIFO group or a throttle) beyond this are dropped and counted as overflow. An assumption: AWS publishes no such limit."
  })
})
export type TopicConfig = typeof Topic.Type
