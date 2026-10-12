import { type Dashboard, dist, gauge, rate, ratio, sum } from "../../Dashboard.ts"

/**
 * A queue's dashboard, as the SQS console's monitoring tab and CloudWatch show one: messages sent, received and deleted,
 * the backlog (visible, in flight, delayed) and the age of its oldest message, then what only failure shows: messages
 * coming back after their visibility timeout, dead-lettered, redriven, expired. Names follow CloudWatch's
 * (https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-available-cloudwatch-metrics.html).
 */
export const dashboard: Dashboard = {
  figures: [
    { label: "Sent", metric: rate("sent"), unit: "perSecond", cloudwatch: "NumberOfMessagesSent" },
    { label: "Deleted", metric: rate("deleted"), unit: "perSecond", cloudwatch: "NumberOfMessagesDeleted" },
    { label: "Visible", metric: gauge("depth"), unit: "count", cloudwatch: "ApproximateNumberOfMessagesVisible" },
    { label: "In flight", metric: gauge("hidden"), unit: "count", cloudwatch: "ApproximateNumberOfMessagesNotVisible" },
    { label: "Oldest message", metric: gauge("oldestAgeMs"), unit: "ms", cloudwatch: "ApproximateAgeOfOldestMessage" },
    { label: "Redelivered", metric: rate("redelivered"), unit: "perSecond", tone: "warn" }
  ],
  panels: [
    {
      id: "messages",
      title: "Messages",
      unit: "perSecond",
      cloudwatch: ["NumberOfMessagesSent", "NumberOfMessagesReceived", "NumberOfMessagesDeleted"],
      help: "Sent by producers, received by consumers (redeliveries included) and deleted once processed. Received above deleted is work being done twice.",
      lines: [
        { label: "sent", metric: rate("sent"), tone: "primary" },
        { label: "received", metric: rate("received"), tone: "accent" },
        { label: "deleted", metric: rate("deleted"), tone: "ok" }
      ]
    },
    {
      id: "depth",
      title: "Messages in the queue",
      unit: "count",
      cloudwatch: ["ApproximateNumberOfMessagesVisible", "ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesDelayed", "ApproximateNumberOfGroupsWithInflightMessages"],
      help: "The backlog waiting to be received, the messages consumers hold and haven't deleted, and those still in a delay. A FIFO queue also shows how many message groups have messages in flight: each delivers one batch at a time, so a backlog with few groups in flight has too few groups to spread its work over.",
      lines: [
        { label: "visible", metric: gauge("depth"), tone: "primary" },
        { label: "in flight", metric: gauge("hidden"), tone: "accent" },
        { label: "delayed", metric: gauge("delayed"), tone: "muted" },
        { label: "groups in flight (FIFO)", metric: gauge("groupsInflight"), tone: "teal" }
      ]
    },
    {
      id: "oldest",
      title: "Age of oldest message",
      unit: "ms",
      cloudwatch: ["ApproximateAgeOfOldestMessage"],
      help: "How long the oldest message has waited. Rising steadily means consumers are falling behind; past the retention period, messages are lost.",
      lines: [{ label: "oldest", metric: gauge("oldestAgeMs"), tone: "warn" }]
    },
    {
      id: "redelivery",
      title: "Redeliveries and duplicates",
      unit: "perSecond",
      help: "Messages whose visibility timeout ran out before they were deleted, and come back; and deliveries whose messages a later receive had already taken, so the work was done twice. AWS publishes neither: they show as received above deleted.",
      lines: [
        { label: "redelivered", metric: rate("redelivered"), tone: "warn" },
        { label: "duplicate work", metric: rate("duplicates"), tone: "bad" }
      ]
    },
    {
      id: "dead-letter",
      title: "Dead-lettering and redrive",
      unit: "perSecond",
      cloudwatch: ["ApproximateNumberOfMessagesVisible (dead-letter queue)"],
      help: "Messages received too often moved to the dead-letter queue (and moves it refused, retried), messages a redrive moved out, and messages retention deleted. AWS counts none of these on the source queue: watch the dead-letter queue's visible messages.",
      lines: [
        { label: "dead-lettered", metric: rate("deadLettered"), tone: "bad" },
        { label: "DLQ refused", metric: rate("dlqFailed"), tone: "warn" },
        { label: "redriven", metric: rate("redriven"), tone: "teal" },
        { label: "expired", metric: rate("expired"), tone: "muted" }
      ]
    },
    {
      id: "empty-receives",
      title: "Empty receives",
      unit: "perSecond",
      cloudwatch: ["NumberOfEmptyReceives"],
      help: "ReceiveMessage calls that returned nothing: idle consumers' long polls ending empty after 20 seconds. An estimate (see the README).",
      lines: [{ label: "empty receives", metric: rate("emptyReceives"), tone: "muted" }]
    },
    {
      id: "size",
      title: "Sent message size",
      unit: "bytes",
      cloudwatch: ["SentMessageSize"],
      lines: [
        { label: "average", metric: ratio(rate("sentBytes"), rate("sent")), tone: "primary" },
        { label: "max", metric: dist("sentMessageSize", "max"), tone: "muted" }
      ]
    },
    {
      id: "send-errors",
      title: "Sends refused and deduplicated",
      unit: "perSecond",
      cloudwatch: ["NumberOfDeduplicatedSentMessages"],
      help: "Sends refused for a FIFO queue's throughput limit or for size, and FIFO sends acknowledged but dropped as duplicates.",
      lines: [
        { label: "throttled", metric: rate("fail.Throttled"), tone: "bad" },
        { label: "rejected", metric: rate("fail.Rejected"), tone: "warn" },
        { label: "deduplicated", metric: rate("deduplicated"), tone: "muted" }
      ]
    }
  ]
}

/**
 * The event source mapping's own charts, after transport's: its concurrency (the pollers and the batches they run), the
 * records it polls, invokes and fails as Lambda's event source mapping metrics count them, and the batches it makes
 * (https://docs.aws.amazon.com/lambda/latest/dg/monitoring-metrics-types.html#event-source-mapping-metrics).
 */
export const mappingDashboard: Dashboard = {
  figures: [
    { label: "Concurrency", metric: gauge("concurrency"), unit: "count" },
    { label: "Batches", metric: rate("batches"), unit: "perSecond" },
    { label: "Avg batch", metric: ratio(rate("invoked"), rate("batches")), unit: "count" }
  ],
  panels: [
    {
      id: "concurrency",
      title: "Concurrency",
      unit: "count",
      help: "Concurrent batches the mapping runs: it starts at five and adds up to 300 a minute while messages wait and every poller is busy, and falls back when the backlog clears or the function fails. Busy pollers hold or run a batch.",
      lines: [
        { label: "concurrency", metric: gauge("concurrency"), tone: "primary" },
        { label: "busy", metric: gauge("busy"), tone: "accent" }
      ]
    },
    {
      id: "events",
      title: "Events",
      unit: "perSecond",
      cloudwatch: ["PolledEventCount", "InvokedEventCount", "FailedInvokeEventCount"],
      help: "Records received from the queue, sent to the function (a batch retried after a throttle counts again), in invocations that failed, and reported failed by a function that returns batch item failures. Failed records come back after the visibility timeout.",
      lines: [
        { label: "polled", metric: rate("polled"), tone: "primary" },
        { label: "invoked", metric: rate("invoked"), tone: "ok" },
        { label: "failed", metric: rate("failedInvoke"), tone: "bad" },
        { label: "reported failed", metric: rate("itemFailures"), tone: "warn" }
      ]
    },
    {
      id: "batch-size",
      title: "Batch size",
      unit: "count",
      help: "Records per invocation against the batch size. Below it, batches are sent before they fill: the queue is drained faster than it fills, or the batching window is short.",
      lines: [
        { label: "average", metric: ratio(rate("invoked"), rate("batches")), tone: "primary" },
        { label: "batch size", metric: gauge("batchSize"), tone: "muted", dashed: true }
      ]
    },
    {
      id: "invoke-errors",
      title: "Invocation errors",
      unit: "perSecond",
      help: "Invocations that failed, by why: the function threw, Lambda throttled it (the batch is kept and tried again), or it timed out or was down. And records a function reported failed while the mapping doesn't act on reports: they are deleted all the same.",
      lines: [
        { label: "errors", metric: rate("fail.Failed"), tone: "bad" },
        { label: "throttled", metric: rate("fail.Throttled"), tone: "warn" },
        { label: "timed out", metric: sum(rate("fail.Timeout"), rate("fail.Unavailable")), tone: "accent" },
        { label: "reports ignored", metric: rate("itemFailuresIgnored"), tone: "muted" }
      ]
    }
  ]
}
