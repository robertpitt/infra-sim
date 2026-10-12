import { type Dashboard, dist, gauge, rate, ratio, sum } from "../../Dashboard.ts"

/**
 * A function's dashboard, as the Lambda console's Monitor tab and CloudWatch show one: invocations and their outcomes,
 * the error rate, duration, concurrency against the function's limit and the region's, cold starts (Lambda Insights'
 * init_duration), provisioned concurrency, and the asynchronous queue. Names follow CloudWatch's
 * (https://docs.aws.amazon.com/lambda/latest/dg/monitoring-metrics-types.html,
 * https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Lambda-Insights-metrics-lambda-functions.html).
 */
export const dashboard: Dashboard = {
  figures: [
    { label: "Invocations", metric: rate("invocations"), unit: "perSecond", cloudwatch: "Invocations" },
    { label: "Errors", metric: rate("errors"), unit: "perSecond", tone: "bad", cloudwatch: "Errors" },
    { label: "Throttles", metric: rate("throttles"), unit: "perSecond", tone: "warn", cloudwatch: "Throttles" },
    { label: "Duration avg", metric: dist("duration", "mean"), unit: "ms", cloudwatch: "Duration" },
    { label: "Concurrent", metric: gauge("concurrent"), unit: "count", cloudwatch: "ConcurrentExecutions" },
    { label: "Cold starts", metric: rate("coldStarts"), unit: "perSecond", cloudwatch: "init_duration (Lambda Insights)" }
  ],
  panels: [
    {
      id: "invocations",
      title: "Invocations",
      unit: "perSecond",
      cloudwatch: ["Invocations", "Errors", "Throttles"],
      help: "Invocations that ran, the ones that ended in a function error (timeouts included), attempts refused with 429 (never invoked), and invocations that had to cold start.",
      lines: [
        { label: "invocations", metric: rate("invocations"), tone: "primary" },
        { label: "errors", metric: rate("errors"), tone: "bad" },
        { label: "throttles", metric: rate("throttles"), tone: "warn" },
        { label: "cold starts", metric: rate("coldStarts"), tone: "accent" }
      ]
    },
    {
      id: "error-rate",
      title: "Error and throttle rate",
      unit: "ratio",
      cloudwatch: ["Errors", "Invocations", "Throttles"],
      help: "Errors over invocations (the console's success rate is one minus it), timeouts over invocations, and throttles over every attempt. Errors and timeouts are counted against the invocations that ended.",
      lines: [
        { label: "errors", metric: ratio(rate("errors"), rate("completedInvocations")), tone: "bad" },
        { label: "timeouts", metric: ratio(rate("timeouts"), rate("completedInvocations")), tone: "accent" },
        { label: "throttled", metric: ratio(rate("throttles"), sum(rate("invocations"), rate("throttles"))), tone: "warn" }
      ]
    },
    {
      id: "duration",
      title: "Duration",
      unit: "ms",
      cloudwatch: ["Duration"],
      help: "Time the handler ran, its downstream calls included, not counting the cold start before it.",
      lines: [
        { label: "avg", metric: dist("duration", "mean"), tone: "primary" },
        { label: "p99", metric: dist("duration", "p99"), tone: "bad" },
        { label: "max", metric: dist("duration", "max"), tone: "muted", dashed: true }
      ]
    },
    {
      id: "concurrency",
      title: "Concurrent executions",
      unit: "count",
      cloudwatch: ["ConcurrentExecutions", "ProvisionedConcurrentExecutions"],
      help: "Executions running (cold starting ones included), the on-demand environments alive (busy and warm), and the provisioned environments allocated.",
      lines: [
        { label: "concurrent", metric: gauge("concurrent"), tone: "primary" },
        { label: "environments", metric: gauge("environments"), tone: "teal" },
        { label: "provisioned", metric: gauge("provisioned"), tone: "muted", dashed: true }
      ]
    },
    {
      id: "regional-concurrency",
      title: "Regional concurrency",
      unit: "count",
      cloudwatch: ["UnreservedConcurrentExecutions", "ClaimedAccountConcurrency"],
      help: "The concurrency this function competes for. Unreserved: executions on the shared pool, every function's. Claimed: that plus what reservations and provisioned concurrency hold back. A function without a reservation is throttled when claimed reaches the account's quota; one with a reservation, when it reaches its reservation.",
      lines: [
        { label: "this function", metric: gauge("concurrent"), tone: "primary" },
        { label: "unreserved", metric: gauge("unreservedConcurrent"), tone: "teal" },
        { label: "claimed", metric: gauge("claimedConcurrency"), tone: "warn" },
        { label: "quota", metric: gauge("accountConcurrency"), tone: "muted", dashed: true }
      ]
    },
    {
      id: "init-duration",
      title: "Init duration",
      unit: "ms",
      cloudwatch: ["init_duration (Lambda Insights)"],
      help: "How long each cold start took to make its environment: Init, or a SnapStart Restore.",
      lines: [
        { label: "avg", metric: dist("initDuration", "mean"), tone: "primary" },
        { label: "p99", metric: dist("initDuration", "p99"), tone: "bad" }
      ]
    },
    {
      id: "provisioned",
      title: "Provisioned concurrency",
      unit: "ratio",
      cloudwatch: ["ProvisionedConcurrencyUtilization", "ProvisionedConcurrencySpilloverInvocations"],
      help: "Provisioned environments busy over those allocated, and the share of invocations that spilled over onto standard concurrency (and may cold start) because all of them were busy. Shown once the function has provisioned concurrency.",
      requires: "provisionedBusy",
      lines: [
        { label: "utilization", metric: ratio(gauge("provisionedBusy"), gauge("provisioned")), tone: "primary" },
        { label: "spillover", metric: ratio(rate("spilloverInvocations"), sum(rate("provisionedInvocations"), rate("spilloverInvocations"))), tone: "warn" }
      ]
    },
    {
      id: "async-events",
      title: "Asynchronous events",
      unit: "perSecond",
      cloudwatch: ["AsyncEventsReceived", "AsyncEventsDropped", "DestinationDeliveryFailures", "DeadLetterErrors"],
      help: "Events queued, retries scheduled after an error or a throttle, events dropped (retries used up, too old, or reserved at 0) to the on-failure destination, and records a destination (or dead-letter queue: the same port here) refused. Shown once the function is invoked asynchronously.",
      requires: "asyncPending",
      lines: [
        { label: "received", metric: rate("asyncEventsReceived"), tone: "primary" },
        { label: "retried", metric: rate("asyncRetries"), tone: "warn" },
        { label: "dropped", metric: rate("asyncFailed"), tone: "bad" },
        { label: "delivery failed", metric: rate("destinationFailures"), tone: "muted" }
      ]
    },
    {
      id: "async-age",
      title: "Async event age",
      unit: "ms",
      cloudwatch: ["AsyncEventAge"],
      help: "How long an event waited between being queued and being invoked. It grows when events are retried after errors or throttles.",
      requires: "asyncPending",
      lines: [
        { label: "avg", metric: dist("asyncEventAge", "mean"), tone: "primary" },
        { label: "max", metric: dist("asyncEventAge", "max"), tone: "bad" }
      ]
    }
  ]
}
