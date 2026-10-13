import { type Dashboard, gauge, rate } from "../../../Dashboard.ts"

/**
 * SES's dashboard, as the account dashboard and CloudWatch show it: what is sent against the sending quota and rate
 * (GetSendQuota's Max24HourSend and MaxSendRate), what happens to it (Send, Delivery, Bounce, Complaint, Reject,
 * DeliveryDelay), the reputation rates against the thresholds at which AWS reviews and then pauses an account, and the
 * sends refused for each limit. Names follow SES's event types and CloudWatch metrics
 * (https://docs.aws.amazon.com/ses/latest/dg/monitor-sending-activity.html). The quota, reputation and the rates are
 * the account's in its region, shared by every SES node there.
 */
export const dashboard: Dashboard = {
  figures: [
    { label: "Sends", metric: rate("send"), unit: "perSecond", cloudwatch: "Send" },
    { label: "Deliveries", metric: rate("delivery"), unit: "perSecond", cloudwatch: "Delivery" },
    { label: "Bounce rate", metric: gauge("bounceRate"), unit: "ratio", cloudwatch: "Reputation.BounceRate" },
    { label: "Complaint rate", metric: gauge("complaintRate"), unit: "ratio", cloudwatch: "Reputation.ComplaintRate" },
    { label: "Daily quota used", metric: gauge("quotaUsed"), unit: "ratio" },
    { label: "Throttled", metric: rate("fail.Throttled"), unit: "perSecond", tone: "bad" }
  ],
  panels: [
    {
      id: "send-rate",
      title: "Sending rate",
      unit: "perSecond",
      cloudwatch: ["Send", "MaxSendRate"],
      help: "Recipients accepted each second against the account's maximum send rate (a short burst above it is allowed). What it refuses is under Sends refused: a throttled send is dropped, not queued.",
      lines: [
        { label: "recipients", metric: rate("recipients"), tone: "primary" },
        { label: "max send rate", metric: gauge("maxSendRate"), tone: "muted", dashed: true }
      ]
    },
    {
      id: "daily-quota",
      title: "Daily sending quota",
      unit: "count",
      cloudwatch: ["SentLast24Hours", "Max24HourSend"],
      help: "Recipients sent in the last 24 hours (a rolling window) against the quota. At the quota every send is refused until the oldest fall out of the window.",
      lines: [
        { label: "sent, 24 h", metric: gauge("dailyUsed"), tone: "primary" },
        { label: "quota", metric: gauge("dailyQuota"), tone: "muted", dashed: true }
      ]
    },
    {
      id: "deliveries",
      title: "Sending activity",
      unit: "perSecond",
      cloudwatch: ["Send", "Delivery", "DeliveryDelay", "Reject"],
      help: "Recipients SES accepted to send, delivered to the recipient's mail server (late ones included), delayed at the first attempt, and rejected for a virus.",
      lines: [
        { label: "send", metric: rate("send"), tone: "primary" },
        { label: "delivery", metric: rate("delivery"), tone: "ok" },
        { label: "delay", metric: rate("deliveryDelay"), tone: "warn" },
        { label: "reject", metric: rate("reject"), tone: "bad" }
      ]
    },
    {
      id: "bounces",
      title: "Bounces and complaints",
      unit: "perSecond",
      cloudwatch: ["Bounce", "Complaint"],
      help: "Hard bounces (sends to suppressed addresses included), soft bounces SES gave up retrying, complaints, and recipients the suppression list stopped.",
      lines: [
        { label: "hard bounce", metric: rate("bounce.permanent"), tone: "bad" },
        { label: "soft bounce", metric: rate("bounce.transient"), tone: "warn" },
        { label: "complaint", metric: rate("complaint"), tone: "accent" },
        { label: "suppressed", metric: rate("suppressed"), tone: "muted" }
      ]
    },
    {
      id: "bounce-rate",
      title: "Bounce rate",
      unit: "ratio",
      cloudwatch: ["Reputation.BounceRate"],
      help: "Hard bounces over recent sends. At 5% AWS reviews the account; still at 10% when the review ends, it may pause sending.",
      lines: [
        { label: "bounce rate", metric: gauge("bounceRate"), tone: "warn" },
        { label: "review", metric: gauge("bounceRateReview"), tone: "muted", dashed: true },
        { label: "pause", metric: gauge("bounceRatePause"), tone: "bad", dashed: true }
      ]
    },
    {
      id: "complaint-rate",
      title: "Complaint rate",
      unit: "ratio",
      cloudwatch: ["Reputation.ComplaintRate"],
      help: "Complaints over recent sends. At 0.1% AWS reviews the account; still at 0.5% when the review ends, it may pause sending.",
      lines: [
        { label: "complaint rate", metric: gauge("complaintRate"), tone: "warn" },
        { label: "review", metric: gauge("complaintRateReview"), tone: "muted", dashed: true },
        { label: "pause", metric: gauge("complaintRatePause"), tone: "bad", dashed: true }
      ]
    },
    {
      id: "throttling",
      title: "Sends refused",
      unit: "perSecond",
      help: "Sends refused, by limit: the maximum send rate, the daily quota, or the bandwidth of large messages (ThrottlingException); and sends refused outright (the account is paused, a recipient isn't verified in the sandbox, too many recipients, too large). SES publishes none of these to CloudWatch: the caller sees them as errors.",
      lines: [
        { label: "send rate", metric: rate("throttled.rate"), tone: "bad" },
        { label: "daily quota", metric: rate("throttled.daily"), tone: "warn" },
        { label: "bandwidth", metric: rate("throttled.bandwidth"), tone: "accent" },
        { label: "refused", metric: rate("fail.Rejected"), tone: "muted" }
      ]
    },
    {
      id: "engagement",
      title: "Opens and clicks",
      unit: "perSecond",
      cloudwatch: ["Open", "Click"],
      help: "Engagement events, recorded when an event destination subscribes to them.",
      lines: [
        { label: "open", metric: rate("open"), tone: "primary" },
        { label: "click", metric: rate("click"), tone: "teal" }
      ]
    },
    {
      id: "events",
      title: "Event publishing",
      unit: "perSecond",
      help: "Events delivered to the event destinations, and events a destination refused.",
      lines: [
        { label: "published", metric: rate("events.published"), tone: "ok" },
        { label: "lost", metric: rate("events.lost"), tone: "bad" }
      ]
    }
  ]
}
