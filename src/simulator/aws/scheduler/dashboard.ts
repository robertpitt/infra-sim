import { type Dashboard, dist, gauge, rate } from "../../Dashboard.ts"

/**
 * A schedule's dashboard, as CloudWatch shows EventBridge Scheduler's: invocation attempts, the errors targets answer
 * with, invocations the region's quota delays, and those dropped or dead-lettered once the retry policy is spent. Names
 * follow CloudWatch's (https://docs.aws.amazon.com/scheduler/latest/UserGuide/monitoring-cloudwatch.html).
 */
export const dashboard: Dashboard = {
  figures: [
    { label: "Attempts", metric: rate("attempts"), unit: "perSecond", cloudwatch: "InvocationAttemptCount" },
    { label: "Target errors", metric: rate("targetErrors"), unit: "perSecond", tone: "bad", cloudwatch: "TargetErrorCount" },
    { label: "Throttled", metric: rate("delayed"), unit: "perSecond", tone: "warn", cloudwatch: "InvocationThrottleCount" },
    { label: "Dropped", metric: rate("failed"), unit: "perSecond", tone: "bad", cloudwatch: "InvocationDroppedCount" },
    { label: "To DLQ", metric: rate("deadLettered"), unit: "perSecond", tone: "warn", cloudwatch: "InvocationsSentToDeadLetterCount" },
    { label: "Pending", metric: gauge("pending"), unit: "count" }
  ],
  panels: [
    {
      id: "invocations",
      title: "Invocations",
      unit: "perSecond",
      cloudwatch: ["InvocationAttemptCount"],
      help: "Invocations created as schedules come due (spread over their flexible time window), every attempt at them, the ones the target accepted, and the retries.",
      lines: [
        { label: "attempts", metric: rate("attempts"), tone: "primary" },
        { label: "created", metric: rate("invocations"), tone: "accent" },
        { label: "succeeded", metric: rate("delivered"), tone: "ok" },
        { label: "retries", metric: rate("retries"), tone: "warn" }
      ]
    },
    {
      id: "target-errors",
      title: "Target errors",
      unit: "perSecond",
      cloudwatch: ["TargetErrorCount", "TargetErrorThrottledCount"],
      help: "Attempts the target answered with an error, and of those the ones it throttled. Each is retried until the retry policy runs out.",
      lines: [
        { label: "errors", metric: rate("targetErrors"), tone: "bad" },
        { label: "throttled by target", metric: rate("targetThrottled"), tone: "warn" }
      ]
    },
    {
      id: "throttled",
      title: "Invocation quota",
      unit: "perSecond",
      cloudwatch: ["InvocationThrottleCount"],
      help: "Invocations created, and those that had to wait, against the region's invocation quota (which every schedule in the region shares). Over it invocations are delayed, not refused.",
      lines: [
        { label: "created", metric: rate("invocations"), tone: "primary" },
        { label: "throttled", metric: rate("delayed"), tone: "warn" },
        { label: "quota", metric: gauge("invocationQuota"), tone: "muted", dashed: true }
      ]
    },
    {
      id: "quota-wait",
      title: "Invocation quota wait",
      unit: "ms",
      help: "How long a new invocation would wait for the region's quota now: a big burst of schedules due at once builds it up.",
      lines: [{ label: "wait", metric: gauge("quotaWait"), tone: "warn" }]
    },
    {
      id: "dropped",
      title: "Dropped and dead-lettered",
      unit: "perSecond",
      cloudwatch: ["InvocationDroppedCount", "InvocationsSentToDeadLetterCount", "InvocationsFailedToBeSentToDeadLetterCount"],
      help: "Invocations given up on once the retry policy (retries or maximum event age) is spent, or the error isn't retried: sent to the dead-letter queue, refused by it, or lost with none wired.",
      lines: [
        { label: "dropped", metric: rate("failed"), tone: "bad" },
        { label: "to DLQ", metric: rate("deadLettered"), tone: "warn" },
        { label: "DLQ failed", metric: rate("deadLetterFailed"), tone: "accent" },
        { label: "lost", metric: rate("dropped"), tone: "muted" }
      ]
    },
    {
      id: "pending",
      title: "Pending invocations",
      unit: "count",
      help: "Invocations created and not finished: waiting for the quota, in flight, or waiting to retry.",
      lines: [{ label: "pending", metric: gauge("pending"), tone: "accent" }]
    },
    {
      id: "latency",
      title: "Invocation latency",
      unit: "ms",
      help: "From an invocation's creation to its first attempt (the quota's delay), and to the attempt that succeeded (retries included). Scheduler publishes neither.",
      lines: [
        { label: "start p50", metric: dist("startLatency", "p50"), tone: "primary" },
        { label: "start p95", metric: dist("startLatency", "p95"), tone: "warn" },
        { label: "success p95", metric: dist("successLatency", "p95"), tone: "bad" }
      ]
    }
  ]
}
