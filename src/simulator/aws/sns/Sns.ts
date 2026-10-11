import { Effect, Schema } from "effect"
import * as Component from "../../Component.ts"
import * as Distribution from "../../Distribution.ts"
import * as Flow from "../../Flow.ts"
import { Rejected, Throttled } from "../../Message.ts"
import { keyOf } from "../../Provider.ts"
import * as Aws from "../provider.ts"
import {
  DEDUPLICATION_CAPACITY,
  DEDUPLICATION_WINDOW_MS,
  DEFAULT_MESSAGE_KB,
  FIFO_GROUP_RATE,
  FIFO_TOPIC_BYTES_PER_SECOND,
  FIFO_TOPIC_RATE,
  LARGE_MESSAGE_SUBSCRIPTIONS,
  Subscription,
  Topic
} from "./config.ts"
import { DeduplicationWindow, GroupRates } from "./fifo.ts"
import { FanOut } from "./fanout.ts"

const D = Aws.docs.sns

/** FIFO publishes with no message group are treated as one group (AWS rejects them: the group id is required). */
const DEFAULT_GROUP = ""

export const Sns = Aws.component({
  type: "aws.sns",
  service: "SNS",
  title: "SNS topic",
  description:
    "Publish/subscribe fan-out. Acknowledges the publisher, then delivers a copy to every subscriber on its own, retrying failed deliveries, filtering and dead-lettering per subscription.",
  docs: Aws.docs.snsQuotas,
  category: "messaging",
  icon: "topic",
  accent: "#b0084d",
  limits: [
    { label: "Publish rate", value: "per region, set in the account quotas (30,000/s in us-east-1 down to 300/s)", adjustable: true, source: Aws.docs.snsQuotas, note: "Counts messages: a PublishBatch of 10 uses 10." },
    { label: "FIFO per message group", value: "300 messages/s", adjustable: false, source: `${D}fifo-message-grouping.html` },
    { label: "FIFO topic, Topic throughput scope", value: "3,000 messages/s or 20 MB/s", adjustable: false, source: Aws.docs.snsQuotas, note: "Message group scope (high throughput) lifts it to the regional publish quota." },
    { label: "Message size", value: "256 KiB, up to 1 MiB; counts body and attributes", adjustable: false, source: `${D}large-message-payloads.html`, note: "Above 256 KiB a topic may have 100 subscriptions at most." },
    { label: "Subscriptions per topic", value: "12,500,000 standard, 100 FIFO", adjustable: true, source: Aws.docs.snsQuotas, note: "Not enforced." },
    { label: "Topics per account", value: "100,000 standard, 1,000 FIFO", adjustable: true, source: Aws.docs.snsQuotas, note: "Checked against the account quotas." },
    { label: "FIFO subscribers", value: "SQS queues only", adjustable: false, source: `${D}fifo-message-delivery.html`, note: "Not enforced: the topic cannot tell what a subscriber is." },
    { label: "FIFO deduplication window", value: "5 minutes", adjustable: false, source: `${D}fifo-message-dedup.html` },
    { label: "Delivery retries to SQS and Lambda", value: "100,015 attempts over 23 days (capped at 100 here)", adjustable: false, source: `${D}sns-message-delivery-retries.html` },
    { label: "Delivery retries to HTTP/S", value: "3 retries 20 s apart unless a delivery policy says otherwise; up to 100 retries, 3,600 s in all", adjustable: true, source: `${D}sns-message-delivery-retries.html` }
  ],
  highlights: [
    { gauge: "pending", label: "delivering" },
    { rate: "undelivered", label: "lost/s" },
    { rate: "fail.Throttled", label: "429/s" }
  ],
  config: Topic,
  ports: {
    out: Component.port.many("Subscribers", Subscription),
    dlq: Component.port.one("Dead-letter queue")
  },
  state: Schema.Struct({
    published: Schema.Number,
    subscribers: Schema.Number,
    pending: Schema.Number,
    throttled: Schema.Number,
    delivered: Schema.Number,
    undelivered: Schema.Number,
    filteredOut: Schema.Number,
    duplicates: Schema.Number,
    overflow: Schema.Number,
    redriven: Schema.Number,
    redriveFailed: Schema.Number,
    /** FIFO message groups with something in flight or waiting, summed over the subscriptions. */
    openGroups: Schema.Number,
    /** The message size limit in force, in KB: the setting, unless too many subscriptions hold it at 256. */
    maxMessageSize: Schema.Number,
    backlog: Schema.Array(Schema.Struct({ node: Schema.String, pending: Schema.Number }))
  }),
  make: (node) =>
    Effect.sync(() => {
      const { fast } = node
      const region = keyOf(node.placement)
      const fan = new FanOut(fast, node.meter, node.out("out"), node.out("dlq"))
      const groupRates = new GroupRates(FIFO_GROUP_RATE)
      let dedup: DeduplicationWindow | undefined
      let published = 0
      let throttled = 0
      let duplicates = 0
      const publishedCount = node.meter.counter("published")
      const duplicateCount = node.meter.counter("duplicates")
      const publishSize = node.meter.sampler("publishSize")
      node.meter.gaugeUnsafe("pending", () => fan.pending)
      node.meter.gaugeUnsafe("openGroups", () => fan.openGroups())

      /** AWS refuses to put a topic above 256 KiB while it has more than 100 subscriptions, so the limit stays where it was. */
      const messageLimitKb = (configured: number): number =>
        configured > DEFAULT_MESSAGE_KB && fan.subscribers > LARGE_MESSAGE_SUBSCRIPTIONS ? DEFAULT_MESSAGE_KB : configured

      return {
        call: (message) => {
          const c = fast.settings()
          const account = fast.account() as Aws.Account
          // A message that carries nothing or counts nothing is still one message: it must not be free or negative.
          const count = message.count >= 1 ? message.count : 1
          const bytes = message.bytes > 0 ? message.bytes : 0
          const limitKb = messageLimitKb(c.maxMessageSize)
          if (bytes > limitKb * 1024) {
            return Effect.fail(Rejected({ node: node.id, reason: `message over the ${limitKb} KB limit` }))
          }
          const fifo = c.kind === "fifo"
          const now = fast.now()
          const group = fifo ? message.group ?? DEFAULT_GROUP : undefined
          // The most specific limit first, so a publish refused by its group does not use up the topic's or the region's allowance.
          let refused: string | undefined
          if (group !== undefined && !groupRates.take(group, count, now)) refused = "message group rate limit"
          else if (fifo && c.fifoThroughput === "topic") {
            if (!node.limiter.takeUnsafe(`${node.id}/topic`, { rate: FIFO_TOPIC_RATE, burst: FIFO_TOPIC_RATE }, count)) refused = "FIFO topic rate limit"
            else if (!node.limiter.takeUnsafe(`${node.id}/topic-bytes`, { rate: FIFO_TOPIC_BYTES_PER_SECOND, burst: FIFO_TOPIC_BYTES_PER_SECOND }, bytes)) refused = "FIFO topic bandwidth limit"
          }
          if (refused === undefined) {
            const rate = fifo ? account.snsFifoPublishRate : account.snsPublishRate
            if (!node.limiter.takeUnsafe(`${region}/sns.${c.kind}`, { rate, burst: rate }, count)) refused = "publish rate limit"
          }
          if (refused !== undefined) {
            throttled++
            return Effect.fail(Throttled({ node: node.id, reason: refused }))
          }
          return Flow.delayed(fast, Distribution.latencyMs(c.publishLatency, fast.random), () => {
            published += count
            publishedCount.n += count
            publishSize.add(bytes)
            if (fifo && c.deduplication) {
              dedup ??= new DeduplicationWindow(DEDUPLICATION_WINDOW_MS, DEDUPLICATION_CAPACITY)
              // The duplicate is accepted (the publisher sees success) and then dropped.
              if (dedup.isDuplicate(message.id, fast.now())) {
                duplicates += count
                duplicateCount.n += count
                return undefined
              }
            } else dedup = undefined
            fan.publish(message, count, group)
            return undefined
          })
        },
        probe: Effect.sync(() => ({
          published,
          subscribers: fan.subscribers,
          pending: fan.pending,
          throttled,
          ...fan.totals,
          duplicates,
          openGroups: fan.openGroups(),
          maxMessageSize: messageLimitKb(fast.settings().maxMessageSize),
          backlog: fan.backlog()
        }))
      }
    })
})
