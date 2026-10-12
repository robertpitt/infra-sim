import { Effect, Schema } from "effect"
import * as Refuse from "../../kit/Refuse.ts"
import { bodyBytes, records } from "../../kit/Shape.ts"
import { tallies, totals } from "../../kit/Tally.ts"
import * as Component from "../../Component.ts"
import * as Distribution from "../../Distribution.ts"
import * as Flow from "../../Flow.ts"
import type { Message } from "../../Message.ts"
import { keyOf } from "../../Provider.ts"
import type { Latency } from "../../Setting.ts"
import * as Aws from "../provider.ts"
import {
  API_DESTINATION_RATE,
  API_DESTINATION_TIMEOUT_MS,
  Bus,
  DELIVERY_LATENCY_SOURCE,
  MAX_ENTRIES_PER_REQUEST,
  MAX_REQUEST_BYTES,
  MAX_RETRY_ATTEMPTS,
  MAX_TARGETS_PER_RULE,
  RuleTarget
} from "./config.ts"
import { Dispatcher, limitsOf, Pacer } from "./delivery.ts"
import { QUOTAS_PAGE } from "./quotas.ts"
import { type Rule, Rules } from "./rules.ts"

const D = Aws.docs.eventbridge

/**
 * `PutEvents` requests a call stands for. A call carrying several entries (a batch from a function) is sent the way an
 * SDK would: packed into as few requests as the 10-entry and 1 MB limits allow. Entries are taken as equal in size.
 */
export const putEventsRequests = (entries: number, entryBytes: number): number => {
  const perRequest = entryBytes > 0 ? Math.min(MAX_ENTRIES_PER_REQUEST, Math.max(1, Math.floor(MAX_REQUEST_BYTES / entryBytes))) : MAX_ENTRIES_PER_REQUEST
  return Math.max(1, Math.ceil(entries / perRequest))
}

/** Ingestion outcomes, as rates and totals. */
const INGESTION = ["requests", "entries", "putThrottled", "rejected", "matched", "unmatched"] as const

export const EventBus = Aws.component({
  type: "aws.eventbridge",
  service: "EventBridge",
  title: "EventBridge event bus",
  description:
    "An event bus with rules. Producers put events; each rule that matches invokes its targets asynchronously, holding invocations to the regional rate, retrying failures for up to a day and dead-lettering what it gives up on.",
  docs: QUOTAS_PAGE,
  category: "messaging",
  icon: "bus",
  accent: "#e7157b",
  limits: [
    { label: "PutEvents rate", value: "per region, set in the account quotas (10,000 requests/s in us-east-1 down to 400/s)", adjustable: true, source: QUOTAS_PAGE, note: "Counts requests; a request carries up to 10 entries." },
    { label: "Target invocations", value: "per region, set in the account quotas (18,750/s in us-east-1 down to 750/s)", adjustable: true, source: QUOTAS_PAGE, note: "Over it, invocations are delayed rather than refused." },
    { label: "Entries per PutEvents request", value: `${MAX_ENTRIES_PER_REQUEST}`, adjustable: false, source: "https://docs.aws.amazon.com/eventbridge/latest/APIReference/API_PutEvents.html", note: "A call with more entries is counted as several requests." },
    { label: "PutEvents request size", value: "under 1 MB (1,048,576 bytes) for all entries together; one entry may use it all", adjustable: false, source: `${D}eb-putevents.html#eb-putevent-size` },
    { label: "Targets per rule", value: `${MAX_TARGETS_PER_RULE}`, adjustable: false, source: QUOTAS_PAGE, note: "Targets wired to a rule beyond five are left out." },
    { label: "Rules per bus", value: "300 (100 in af-south-1 and eu-south-1)", adjustable: true, source: QUOTAS_PAGE, note: "Set in the account quotas; rules beyond it are left out." },
    { label: "Retry policy", value: `24 hours and ${MAX_RETRY_ATTEMPTS} retries by default; 60 s to 24 h, 0 to ${MAX_RETRY_ATTEMPTS} retries`, adjustable: false, source: `${D}eb-rule-retry-policy.html` },
    { label: "Dead-letter queue", value: "a standard SQS queue in the same region, per target", adjustable: false, source: `${D}eb-rule-dlq.html`, note: "One dead-letter port per bus here." },
    { label: "API destination", value: `${API_DESTINATION_TIMEOUT_MS / 1000} s per request; ${API_DESTINATION_RATE} invocations/s per destination by default`, adjustable: true, source: `${D}eb-api-destinations.html` },
    { label: "Delivery latency", value: "P99 of 129 ms from ingestion to the first invocation attempt (August 2024)", adjustable: false, source: DELIVERY_LATENCY_SOURCE }
  ],
  highlights: [
    { gauge: "pending", label: "delivering" },
    { rate: "dropped", label: "lost/s" },
    { rate: "fail.Throttled", label: "429/s" }
  ],
  config: Bus,
  ports: {
    out: Component.port.many("Rule targets", RuleTarget),
    dlq: Component.port.one("Dead-letter queue")
  },
  state: Schema.Struct({
    requests: Schema.Number,
    entries: Schema.Number,
    putThrottled: Schema.Number,
    rejected: Schema.Number,
    matched: Schema.Number,
    unmatched: Schema.Number,
    pending: Schema.Number,
    invocations: Schema.Number,
    attempts: Schema.Number,
    delivered: Schema.Number,
    retries: Schema.Number,
    failed: Schema.Number,
    dropped: Schema.Number,
    deadLettered: Schema.Number,
    deadLetterFailed: Schema.Number,
    expired: Schema.Number,
    delayed: Schema.Number,
    overflow: Schema.Number,
    /** How long a new invocation would wait for the region's invocation quota, in ms. */
    quotaWait: Schema.Number,
    rules: Schema.Array(Schema.Struct({ rule: Schema.String, active: Schema.Boolean, targets: Schema.Array(Schema.String), ignored: Schema.Array(Schema.String) })),
    backlog: Schema.Array(Schema.Struct({ node: Schema.String, pending: Schema.Number }))
  }),
  make: (node) =>
    Effect.gen(function*() {
      const { fast } = node
      const region = keyOf(node.placement)
      const putKey = `${region}/eventbridge.putEvents`
      // One invocation quota for every bus in the region, as AWS counts it per account and Region.
      const quota = yield* node.shared("eventbridge/invocations", Effect.sync(() => new Pacer()))
      const account = () => fast.account() as Aws.Account
      const rules = new Rules(node.out("out"))
      const dispatcher = new Dispatcher(fast, node.meter, node.out("dlq"), quota, () => account().eventBridgeInvocationRate, () => {
        const c = fast.settings()
        return limitsOf(c, c.maxPendingPerTarget)
      })
      const ingestion = tallies(node.meter, INGESTION)
      const requestSize = node.meter.sampler("requestSize")
      node.meter.gaugeUnsafe("pending", () => dispatcher.pending)
      node.meter.gaugeUnsafe("quotaWait", () => dispatcher.quotaWait())

      /** One entry of a call as an event of its own. Targets are invoked asynchronously (a Lambda function gets an `Event` invocation). */
      const eventOf = (message: Message, entries: number, entryBytes: number): Message => {
        if (entries === 1) {
          if (message.invocation === "async" && message.batched === undefined) return message
          const { batched: _, ...rest } = message
          return { ...rest, invocation: "async" }
        }
        // Each entry is a separate event with its own id, so nothing downstream takes them for duplicates.
        const event = fast.mint({ bytes: Math.round(entryBytes), count: 1, invocation: "async", key: message.key, operation: message.operation, ...(message.group === undefined ? {} : { group: message.group }) })
        return { ...event, bornAt: message.bornAt, origin: message.origin }
      }

      /** Match one event against every rule and invoke the targets of those that match. */
      const route = (active: ReadonlyArray<Rule>, event: Message, deliveryLatency: Latency): void => {
        let matched = false
        for (const rule of active) {
          // One draw per rule and event; each target compares it with its own rate.
          let u = -1
          for (const wired of rule.targets) {
            const share = wired.config.match
            if (share < 1) {
              if (u < 0) u = fast.random.nextDoubleUnsafe()
              if (u >= share) continue
            }
            matched = true
            dispatcher.dispatch(wired.target, event, wired.policy, Distribution.latencyMs(deliveryLatency, fast.random))
          }
        }
        if (matched) ingestion.matched.add(1)
        else ingestion.unmatched.add(1)
      }

      return {
        call: (message) => {
          const c = fast.settings()
          const entries = records(message)
          const bytes = bodyBytes(message)
          const entryBytes = bytes / entries
          if (entryBytes > MAX_REQUEST_BYTES) {
            ingestion.rejected.add(entries)
            return Refuse.rejected(node.id, "an entry larger than the 1 MB PutEvents limit")
          }
          const requests = putEventsRequests(entries, entryBytes)
          const rate = account().eventBridgePutEventsRate
          if (!node.limiter.takeUnsafe(putKey, { rate, burst: rate }, requests)) {
            ingestion.putThrottled.add(requests)
            return Refuse.throttled(node.id, "PutEvents rate limit")
          }
          return Flow.delayed(fast, Distribution.latencyMs(c.putLatency, fast.random), () => {
            ingestion.requests.add(requests)
            ingestion.entries.add(entries)
            requestSize.add(bytes / requests)
            const latency = fast.settings().deliveryLatency
            const active = rules.current(account().eventBridgeRulesPerBus)
            for (let i = 0; i < entries; i++) route(active, eventOf(message, entries, entryBytes), latency)
            return undefined
          })
        },
        probe: Effect.sync(() => ({
          ...totals(ingestion),
          ...dispatcher.totals,
          pending: dispatcher.pending,
          quotaWait: dispatcher.quotaWait(),
          rules: rules.describe(account().eventBridgeRulesPerBus).map((r) => ({
            rule: r.name,
            active: r.active,
            targets: r.targets.map((w) => w.target.link.to),
            ignored: r.ignored.map((w) => w.target.link.to)
          })),
          backlog: rules.targets.map((t) => ({ node: t.link.to, pending: t.pending }))
        }))
      }
    })
})
