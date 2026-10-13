import { type Dashboard, dist, latencyPanel, rate, sum } from "../../../Dashboard.ts"
import { panels } from "../Delivery.ts"

/**
 * An event bus's dashboard, as CloudWatch shows one: PutEvents requests and entries, the events rules matched, target
 * invocations and their attempts, retries and failures, the invocation quota delaying them (ThrottledRules), the latency
 * from ingestion to the first attempt, and the dead-letter queue. Names follow CloudWatch's
 * (https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-monitoring.html).
 */
export const dashboard: Dashboard = {
  figures: [
    { label: "Events", metric: rate("entries"), unit: "perSecond", cloudwatch: "PutEventsEntriesCount" },
    { label: "Matched", metric: rate("matched"), unit: "perSecond", cloudwatch: "MatchedEvents" },
    { label: "Invocations", metric: rate("invocations"), unit: "perSecond", cloudwatch: "InvocationsCreated" },
    { label: "Failed", metric: rate("failed"), unit: "perSecond", tone: "bad", cloudwatch: "FailedInvocations" },
    { label: "Throttled rules", metric: rate("delayed"), unit: "perSecond", tone: "warn", cloudwatch: "ThrottledRules" },
    { label: "Start latency p95", metric: dist("startLatency", "p95"), unit: "ms", cloudwatch: "IngestiontoInvocationStartLatency" }
  ],
  panels: [
    {
      id: "put-events",
      title: "PutEvents",
      unit: "perSecond",
      cloudwatch: ["PutEventsApproximateSuccessCount", "PutEventsEntriesCount", "PutEventsApproximateThrottledCount", "PutEventsFailedEntriesCount"],
      help: "Requests accepted and the entries they carried (up to ten a request), requests refused by the region's PutEvents quota, and entries refused for size.",
      lines: [
        { label: "requests", metric: rate("requests"), tone: "primary" },
        { label: "entries", metric: rate("entries"), tone: "accent" },
        { label: "throttled requests", metric: rate("putThrottled"), tone: "bad" },
        { label: "failed entries", metric: rate("rejected"), tone: "warn" }
      ]
    },
    {
      id: "matched",
      title: "Matched events",
      unit: "perSecond",
      cloudwatch: ["MatchedEvents"],
      help: "Events that matched at least one rule, and events no rule wanted.",
      lines: [
        { label: "matched", metric: rate("matched"), tone: "primary" },
        { label: "unmatched", metric: rate("unmatched"), tone: "muted" }
      ]
    },
    {
      id: "invocations",
      title: "Invocations",
      unit: "perSecond",
      cloudwatch: ["Invocations", "InvocationAttempts", "RetryInvocationAttempts", "FailedInvocations"],
      help: "Invocations that ended (delivered, or failed for good), every attempt at them, the retries among those attempts, and the invocations given up on.",
      lines: [
        { label: "invocations", metric: sum(rate("delivered"), rate("failed")), tone: "primary" },
        { label: "attempts", metric: rate("attempts"), tone: "accent" },
        { label: "retries", metric: rate("retries"), tone: "warn" },
        { label: "failed", metric: rate("failed"), tone: "bad" }
      ]
    },
    {
      id: "throttled-rules",
      title: "Invocation quota",
      unit: "perSecond",
      cloudwatch: ["InvocationsCreated", "ThrottledRules"],
      help: "Invocations created (one per matching target per event: what the region's invocation quota counts, shared by every bus) and those that had to wait: for that quota, or for an API destination's own invocation rate. Over a limit invocations are delayed, not refused.",
      lines: [
        { label: "created", metric: rate("invocations"), tone: "primary" },
        { label: "throttled", metric: rate("delayed"), tone: "warn" }
      ]
    },
    panels.quotaWait("How long a new invocation would wait for the region's invocation quota now. It grows while more invocations are created than the quota lets through."),
    panels.latency(
      "Ingestion to invocation",
      "From an event's ingestion to its target's first attempt, and to the attempt that succeeded (retries and quota waits included).",
      ["IngestiontoInvocationStartLatency", "IngestionToInvocationSuccessLatency"]
    ),
    {
      id: "dead-letter",
      title: "Dead-letter queue",
      unit: "perSecond",
      cloudwatch: ["InvocationsSentToDlq", "InvocationsFailedToBeSentToDlq"],
      help: "Invocations given up on: moved to the dead-letter queue, refused by it (or none is wired), or lost because the target has no dead-letter queue. Expired ones ran out their maximum event age.",
      lines: [
        { label: "to DLQ", metric: rate("deadLettered"), tone: "warn" },
        { label: "DLQ failed", metric: rate("deadLetterFailed"), tone: "bad" },
        { label: "lost", metric: rate("dropped"), tone: "bad" },
        { label: "expired", metric: rate("expired"), tone: "muted" }
      ]
    },
    panels.pending("Invocations created and not finished: waiting for the quota, in flight, or waiting to retry. A failing target holds its events here for up to a day."),
    {
      id: "request-size",
      title: "PutEvents request size",
      unit: "bytes",
      cloudwatch: ["PutEventsRequestSize"],
      lines: [
        { label: "average", metric: dist("requestSize", "mean"), tone: "primary" },
        { label: "max", metric: dist("requestSize", "max"), tone: "muted" }
      ]
    },
    latencyPanel("put-latency", "PutEvents latency", "latency", ["PutEventsLatency"])
  ]
}
