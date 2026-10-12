import { Schema } from "effect"
import type * as Edge from "../../Edge.ts"
import * as Setting from "../../Setting.ts"
import { docs } from "../docs.ts"

/**
 * What EventBridge publishes about an event bus (Custom Event Bus - Classic: rules and targets), as constants with
 * their sources. Anything that is not on a documentation page is labelled an assumption.
 */

const D = docs.eventbridge

/** Entries in one `PutEvents` request: 1 to 10 (the `Entries` array of API_PutEvents). */
export const MAX_ENTRIES_PER_REQUEST = 10
/**
 * The sum of the entries of one `PutEvents` request must be under 1 MB (1,048,576 bytes). The limit is on the request,
 * so a single event may use all of it (eb-putevents.html, "Calculating PutEvents event entry size").
 */
export const MAX_REQUEST_BYTES = 1_048_576
/** Targets one rule may have: 5, not adjustable (eb-quota.html, eb-targets.html). */
export const MAX_TARGETS_PER_RULE = 5
/** `RetryPolicy.MaximumRetryAttempts`: 0 to 185, and the default for a rule target is 185 (eb-rule-retry-policy.html). */
export const MAX_RETRY_ATTEMPTS = 185
/** `RetryPolicy.MaximumEventAgeInSeconds`: 60 to 86,400; the default is 24 hours (API_RetryPolicy.html). */
export const MIN_EVENT_AGE = "60 seconds"
export const MAX_EVENT_AGE = "24 hours"
/** An API destination's endpoint must answer within 5 seconds or EventBridge times the request out and retries it. */
export const API_DESTINATION_TIMEOUT_MS = 5_000
/** "Rate of invocations per API destination": 300 a second by default, adjustable. Excess invocations are delayed. */
export const API_DESTINATION_RATE = 300

/**
 * Assumption: AWS says retries use "exponential back off and jitter" and that the default policy runs for 24 hours
 * and up to 185 times, but publishes no delays. With full jitter, a first backoff of 1 s doubling to a cap of 16
 * minutes, 185 retries take about 23.5 hours on average: the two default limits arrive together, as AWS describes.
 */
export const RETRY_FIRST_BACKOFF = "1 second"
export const RETRY_MAX_BACKOFF = "16 minutes"

/**
 * Assumption: the shape of delivery latency. AWS measured its P99 from ingestion to the first invocation attempt at
 * 129 ms in August 2024. A lognormal with mean 40 ms and cv 0.6 has a P99 of about 125 ms.
 */
export const DELIVERY_LATENCY_SOURCE = "https://aws.amazon.com/about-aws/whats-new/2024/11/amazon-eventbridge-improvement-latency-event-buses"

/** The retry backoff group, shared by the event bus and the Scheduler (both say only "exponential backoff and jitter"). */
export const retryBackoff = Setting.group(
  {
    initial: Setting.duration({ default: RETRY_FIRST_BACKOFF, min: 0, max: "1 hour", label: "First backoff", help: "The longest wait before the first retry; each wait is drawn between zero and its limit (full jitter). An assumption: AWS publishes no delays." }),
    max: Setting.duration({ default: RETRY_MAX_BACKOFF, min: 0, max: "24 hours", label: "Longest backoff", help: "The limit doubles after each retry up to this. An assumption, chosen so that 185 retries take about 24 hours, as AWS's default policy does." })
  },
  { label: "Retry backoff (assumed)" }
)

/** A target's retry policy (`RetryPolicy`): how many retries, and for how long after the event was accepted. */
export const retryPolicy = (source: string) =>
  Setting.group(
    {
      maxRetries: Setting.int({
        default: MAX_RETRY_ATTEMPTS,
        min: 0,
        max: MAX_RETRY_ATTEMPTS,
        label: "Maximum retries",
        help: "Retries after the first attempt (MaximumRetryAttempts). 0 tries once.",
        limit: Setting.hard(source)
      }),
      maxEventAge: Setting.duration({
        default: MAX_EVENT_AGE,
        min: MIN_EVENT_AGE,
        max: MAX_EVENT_AGE,
        label: "Maximum event age",
        help: "Stop retrying once the event is this old (MaximumEventAgeInSeconds), counted from when it was accepted. Time spent delayed by a rate limit counts too.",
        limit: Setting.hard(source)
      })
    },
    { label: "Retry policy" }
  )

/**
 * A rule target: an edge from the bus's `out` port. Its settings are the rule's (name, how much its pattern matches)
 * and the target's (retry policy, dead-letter queue, and the API destination's rate).
 */
export const RuleTarget = Schema.Struct({
  rule: Setting.text({
    default: "",
    placeholder: "this target alone",
    label: "Rule",
    help: "The rule this target belongs to. Edges that name the same rule are its targets (up to 5): an event the rule matches goes to all of them. Empty: the edge is a rule of its own."
  }),
  match: Setting.ratio({
    default: 1,
    label: "Event pattern match rate",
    help: "The share of events the rule's event pattern matches. Simulated events carry no fields to match, so this is a rate, not a pattern. Targets of one rule draw together: with the same rate they all receive the same events."
  }),
  retryPolicy: retryPolicy(`${D}eb-rule-retry-policy.html`),
  deadLetterQueue: Setting.bool({
    default: false,
    label: "Dead-letter queue",
    help: "When delivery finally fails (retries or event age used up, or an error that is not retried), send the event to the queue wired to the bus's dead-letter port instead of dropping it."
  }),
  apiDestination: Setting.group(
    {
      enabled: Setting.bool({ default: false, label: "API destination", help: "The target is an HTTPS endpoint called through an API destination: each request is given 5 seconds, and invocations are held to the destination's rate." }),
      rate: Setting.int({
        default: API_DESTINATION_RATE,
        min: 1,
        max: 1_000_000,
        unit: "req/s",
        label: "Invocation rate limit",
        help: "InvocationRateLimitPerSecond. Invocations beyond it are delayed, not refused, and can outlive their maximum event age.",
        limit: Setting.quota(`${D}eb-quota.html`, "Rate of invocations per API destination: 300 a second by default.")
      })
    },
    { label: "API destination" }
  )
})

/** An edge leaving the `out` port. */
export type RuleTargetEdge = Edge.Config & typeof RuleTarget.Type

export const Bus = Schema.Struct({
  putLatency: Setting.latency({ mean: "10 millis", cv: 0.3, label: "PutEvents latency", help: "How long a PutEvents request takes to be answered. AWS publishes no figure; an assumption." }),
  deliveryLatency: Setting.latency({
    mean: "40 millis",
    cv: 0.6,
    label: "Delivery latency",
    help: "From an event being accepted to the first attempt to invoke a target (IngestionToInvocationStartLatency). AWS reported a P99 of 129 ms in 2024; the shape is an assumption with a P99 of about 125 ms."
  }),
  retryBackoff,
  maxPendingPerTarget: Setting.int({
    default: 100_000,
    min: 1,
    max: 10_000_000,
    unit: "events",
    label: "Pending deliveries per target",
    help: "EventBridge keeps retrying an event for up to 24 hours; the simulator has to bound what it remembers. Deliveries waiting on a target (delayed or retrying) beyond this are dropped and counted as overflow. An assumption: AWS publishes no such limit."
  })
})
export type BusConfig = typeof Bus.Type
