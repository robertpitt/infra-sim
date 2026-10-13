import { type Dashboard, dist, gauge, latencyPanel, rate } from "../../../Dashboard.ts"

/**
 * A topic's dashboard, as CloudWatch shows one: messages published, the notifications delivered to subscribers, those
 * that failed or a filter policy removed, dead-lettering, and the size of what is published. Names follow CloudWatch's
 * (https://docs.aws.amazon.com/sns/latest/dg/sns-monitoring-using-cloudwatch.html).
 */
export const dashboard: Dashboard = {
  figures: [
    { label: "Published", metric: rate("published"), unit: "perSecond", cloudwatch: "NumberOfMessagesPublished" },
    { label: "Delivered", metric: rate("delivered"), unit: "perSecond", cloudwatch: "NumberOfNotificationsDelivered" },
    { label: "Failed", metric: rate("undelivered"), unit: "perSecond", tone: "bad", cloudwatch: "NumberOfNotificationsFailed" },
    { label: "Throttled", metric: rate("fail.Throttled"), unit: "perSecond", tone: "warn" },
    { label: "Delivering", metric: gauge("pending"), unit: "count" },
    { label: "Avg publish size", metric: dist("publishSize", "mean"), unit: "bytes", cloudwatch: "PublishSize" }
  ],
  panels: [
    {
      id: "published",
      title: "Messages published",
      unit: "perSecond",
      cloudwatch: ["NumberOfMessagesPublished"],
      help: "Messages the topic accepted, and publishes it refused: over the publish rate quota (or a FIFO topic's limits), or too large. FIFO duplicates are accepted and dropped.",
      lines: [
        { label: "published", metric: rate("published"), tone: "primary" },
        { label: "throttled", metric: rate("fail.Throttled"), tone: "bad" },
        { label: "rejected", metric: rate("fail.Rejected"), tone: "warn" },
        { label: "duplicates", metric: rate("duplicates"), tone: "muted" }
      ]
    },
    {
      id: "notifications",
      title: "Notifications",
      unit: "perSecond",
      cloudwatch: ["NumberOfNotificationsDelivered", "NumberOfNotificationsFailed", "NumberOfNotificationsFilteredOut"],
      help: "One per message per subscription: delivered, given up on after the delivery retries, or removed by the subscription's filter policy.",
      lines: [
        { label: "delivered", metric: rate("delivered"), tone: "ok" },
        { label: "failed", metric: rate("undelivered"), tone: "bad" },
        { label: "filtered out", metric: rate("filteredOut"), tone: "muted" }
      ]
    },
    {
      id: "pending",
      title: "Deliveries in progress",
      unit: "count",
      help: "Deliveries accepted and not yet answered: sending, waiting to retry, or held behind a FIFO group or a subscription's throttle. A slow or failing subscriber builds this up; the publisher never waits on it.",
      lines: [
        { label: "delivering", metric: gauge("pending"), tone: "accent" },
        { label: "FIFO groups open", metric: gauge("openGroups"), tone: "muted" }
      ]
    },
    {
      id: "dead-letter",
      title: "Dead-letter queue",
      unit: "perSecond",
      cloudwatch: ["NumberOfNotificationsRedrivenToDlq", "NumberOfNotificationsFailedToRedriveToDlq"],
      help: "Failed notifications moved to the dead-letter queue, or that couldn't be (none is wired, or it refused them); and deliveries dropped because a subscription's backlog was full (a simulator bound, not an AWS one).",
      lines: [
        { label: "to DLQ", metric: rate("redriven"), tone: "warn" },
        { label: "DLQ failed", metric: rate("redriveFailed"), tone: "bad" },
        { label: "backlog full", metric: rate("overflow"), tone: "muted" }
      ]
    },
    {
      id: "publish-size",
      title: "Publish size",
      unit: "bytes",
      cloudwatch: ["PublishSize"],
      help: "Bytes per publish; a PublishBatch counts once, at the size of the whole batch.",
      lines: [
        { label: "average", metric: dist("publishSize", "mean"), tone: "primary" },
        { label: "max", metric: dist("publishSize", "max"), tone: "muted" }
      ]
    },
    latencyPanel("latency", "Publish latency")
  ]
}
