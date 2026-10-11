import { Effect, Schema } from "effect"
import * as Component from "../Component.ts"
import * as Distribution from "../Distribution.ts"
import * as Edge from "../Edge.ts"
import * as Flow from "../Flow.ts"
import { type Message, Rejected, Throttled } from "../Message.ts"
import { keyOf } from "../Provider.ts"
import * as Setting from "../Setting.ts"
import * as Aws from "./provider.ts"

const D = Aws.docs.sns

/** FIFO topics: 300 messages per second per message group, 3,000 per second for the topic by default. */
const FIFO_GROUP_RATE = 300
const FIFO_TOPIC_RATE = 3_000

/**
 * What an SNS subscription retries like. For SQS and Lambda endpoints AWS retries for 23 days (100,015 attempts:
 * three at once, two a second apart, ten backing off from 1 to 20 s, then one every 20 s). Attempts here are capped at
 * 100, which at 20 s apart is about half an hour of retrying; that is as long as the simulator's edge retries go.
 */
const Subscription = Schema.Struct({
  retry: Edge.retryWith({ maxAttempts: 100, backoff: "1 second", backoffFactor: 2, maxBackoff: "20 seconds", jitter: true })
})

export const Sns = Aws.component({
  type: "aws.sns",
  service: "SNS",
  title: "SNS topic",
  description: "Publish/subscribe fan-out. Acknowledges the publisher, then delivers a copy to every subscriber on its own, retrying failed deliveries.",
  docs: Aws.docs.snsQuotas,
  category: "messaging",
  icon: "topic",
  accent: "#b0084d",
  limits: [
    { label: "Publish rate", value: "per region, set in the account quotas (30,000/s in us-east-1 down to 300/s)", adjustable: true, source: Aws.docs.snsQuotas },
    { label: "FIFO per message group", value: "300 messages/s", adjustable: false, source: `${D}fifo-message-grouping.html` },
    { label: "FIFO topic default", value: "3,000 messages/s or 20 MB/s", adjustable: false, source: Aws.docs.snsQuotas },
    { label: "Subscriptions per topic", value: "12,500,000 standard, 100 FIFO", adjustable: true, source: Aws.docs.snsQuotas },
    { label: "FIFO delivery targets", value: "SQS queues only", adjustable: false, source: `${D}fifo-message-delivery.html` },
    { label: "Delivery retries to SQS and Lambda", value: "100,015 attempts over 23 days (capped at 100 here)", adjustable: false, source: `${D}sns-message-delivery-retries.html` }
  ],
  highlights: [
    { gauge: "pending", label: "delivering" },
    { rate: "undelivered", label: "lost/s" },
    { rate: "fail.Throttled", label: "429/s" }
  ],
  config: Schema.Struct({
    kind: Setting.choice(["standard", "fifo"], { default: "standard", labels: { standard: "Standard", fifo: "FIFO" } }),
    maxMessageSize: Setting.int({
      default: 256,
      min: 1,
      max: 1_024,
      unit: "KB",
      label: "Maximum message size",
      help: "256 KB by default; a topic can raise it to 1 MiB.",
      limit: Setting.hard(Aws.docs.snsQuotas)
    }),
    publishLatency: Setting.latency({ mean: "5 millis", cv: 0.3, label: "Publish latency", help: "AWS publishes no figure; an assumption." })
  }),
  ports: { out: Component.port.many("Subscribers", Subscription) },
  state: Schema.Struct({ published: Schema.Number, subscribers: Schema.Number, pending: Schema.Number, throttled: Schema.Number }),
  make: (node) =>
    Effect.sync(() => {
      const { fast } = node
      let published = 0
      let pending = 0
      let throttled = 0
      const delivered = node.meter.counter("delivered")
      const undelivered = node.meter.counter("undelivered")
      const subscribers = node.out("out")
      node.meter.gaugeUnsafe("pending", () => pending)
      const region = keyOf(node.placement)

      // SNS invokes Lambda subscribers asynchronously, so deliveries are marked async. Each subscription has its own lanes:
      // on a FIFO topic a message waits for the one before it in its group, whatever it takes that one to get through.
      const lanes = subscribers.map(() => new Flow.Lanes())
      const deliver = (link: Edge.Link<Edge.Config>, message: Message, release: () => void): void => {
        pending++
        link.send({ ...message, invocation: "async" }, (failure) => {
          pending--
          if (failure === undefined) delivered.n++
          else undelivered.n++
          release()
        })
      }
      const publish = (message: Message, lane: string | undefined): void => {
        published++
        for (let i = 0; i < subscribers.length; i++) {
          const link = subscribers[i]!
          if (lane === undefined) deliver(link, message, noop)
          else lanes[i]!.run(lane, (release) => deliver(link, message, release))
        }
      }

      return {
        call: (message) => {
          const c = fast.settings()
          const account = fast.account() as Aws.Account
          if (message.bytes > c.maxMessageSize * 1024) {
            return Effect.fail(Rejected({ node: node.id, reason: `message over the ${c.maxMessageSize} KB limit` }))
          }
          const fifo = c.kind === "fifo"
          const rate = fifo ? account.snsFifoPublishRate : account.snsPublishRate
          let ok = node.limiter.takeUnsafe(`${region}/sns.${c.kind}`, { rate, burst: rate }, message.count)
          if (ok && fifo) {
            ok = node.limiter.takeUnsafe(`${node.id}/topic`, { rate: FIFO_TOPIC_RATE, burst: FIFO_TOPIC_RATE }, message.count)
            if (ok && message.group !== undefined) ok = node.limiter.takeUnsafe(`${node.id}/group/${message.group}`, { rate: FIFO_GROUP_RATE, burst: FIFO_GROUP_RATE }, message.count)
          }
          if (!ok) {
            throttled++
            return Effect.fail(Throttled({ node: node.id, reason: "publish rate limit" }))
          }
          return Flow.delayed(fast, Distribution.latencyMs(c.publishLatency, fast.random), () => {
            publish(message, fifo ? message.group ?? "" : undefined)
            return undefined
          })
        },
        probe: Effect.sync(() => ({ published, subscribers: subscribers.length, pending, throttled }))
      }
    })
})

const noop = (): void => {}
