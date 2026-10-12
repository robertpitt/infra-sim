import { type Dashboard, gauge, latencyPanel, rate, ratio, sum } from "../../Dashboard.ts"

const blockedShare = ratio(rate("blocked"), sum(rate("allowed"), rate("blocked")))

/**
 * A web ACL's dashboard, as AWS WAF's traffic overview and CloudWatch show one: AllowedRequests, BlockedRequests and
 * CountedRequests, overall and by rule (the Rule dimension), and what CloudWatch doesn't publish: the rate-based rule's
 * busiest address against its limit, the addresses it is limiting, and requests past the web ACL's quota. Names follow
 * CloudWatch's (https://docs.aws.amazon.com/waf/latest/developerguide/waf-metrics.html).
 */
export const dashboard: Dashboard = {
  figures: [
    { label: "Allowed", metric: rate("allowed"), unit: "perSecond", cloudwatch: "AllowedRequests" },
    { label: "Blocked", metric: rate("blocked"), unit: "perSecond", tone: "warn", cloudwatch: "BlockedRequests" },
    { label: "Counted", metric: rate("counted"), unit: "perSecond", tone: "accent", cloudwatch: "CountedRequests" },
    { label: "Blocked share", metric: blockedShare, unit: "ratio" },
    { label: "IPs rate limited", metric: gauge("rateLimitedAddresses"), unit: "count", tone: "warn" },
    { label: "Over quota", metric: rate("overQuota"), unit: "perSecond", tone: "bad" }
  ],
  panels: [
    {
      id: "requests",
      title: "Requests",
      unit: "perSecond",
      cloudwatch: ["AllowedRequests", "BlockedRequests", "CountedRequests"],
      help: "Requests the web ACL let through and blocked (403), and those a rule with the Count action matched on the way (they are allowed or blocked too).",
      lines: [
        { label: "allowed", metric: rate("allowed"), tone: "ok" },
        { label: "blocked", metric: rate("blocked"), tone: "warn" },
        { label: "counted", metric: rate("counted"), tone: "accent", dashed: true }
      ]
    },
    {
      id: "blocked-by-rule",
      title: "Blocked by rule",
      unit: "perSecond",
      cloudwatch: ["BlockedRequests (Rule)"],
      help: "Which rule blocked: the rate-based rule, a managed rule group or your own rules, the Core rule set's body size rule, or the rule that blocks bodies larger than AWS WAF inspects.",
      lines: [
        { label: "rate-based", metric: rate("blocked.rateBased"), tone: "bad" },
        { label: "rules", metric: rate("blocked.rules"), tone: "warn" },
        { label: "body size (Core)", metric: rate("blocked.bodySize"), tone: "accent" },
        { label: "oversize body", metric: rate("blocked.oversize"), tone: "teal" }
      ]
    },
    {
      id: "counted-by-rule",
      title: "Counted by rule",
      unit: "perSecond",
      cloudwatch: ["CountedRequests (Rule)"],
      help: "Matches of rules whose action is Count (or overridden to Count, as when trying rules out): what they would block.",
      lines: [
        { label: "rate-based", metric: rate("counted.rateBased"), tone: "bad" },
        { label: "rules", metric: rate("counted.rules"), tone: "warn" },
        { label: "body size (Core)", metric: rate("counted.bodySize"), tone: "accent" }
      ]
    },
    {
      id: "blocked-share",
      title: "Blocked share",
      unit: "ratio",
      help: "Blocked requests over all the requests the web ACL inspected.",
      lines: [{ label: "blocked", metric: blockedShare, tone: "warn" }]
    },
    {
      id: "rate-rule",
      title: "Rate-based rule",
      unit: "count",
      help: "Requests from the busiest address over the rule's window at the last check (AWS WAF checks about every 10 seconds), against the rule's limit: past it, the address is limited after the detection lag. Not a CloudWatch metric.",
      lines: [
        { label: "busiest address", metric: gauge("busiestAddress"), tone: "primary" },
        { label: "limit", metric: gauge("rateLimit"), tone: "muted", dashed: true }
      ]
    },
    {
      id: "limited",
      title: "Addresses rate limited",
      unit: "count",
      help: "Addresses the rate-based rule is limiting now (at most 10,000, the busiest first). Not a CloudWatch metric.",
      lines: [{ label: "addresses", metric: gauge("rateLimitedAddresses"), tone: "warn" }]
    },
    {
      id: "quota",
      title: "Request quota",
      unit: "perSecond",
      help: "Requests past the regional web ACL's request quota: answered 500, or routed to the target uninspected when an Application Load Balancer is set to fail open. Not a CloudWatch metric.",
      lines: [
        { label: "over quota", metric: rate("overQuota"), tone: "bad" },
        { label: "uninspected", metric: rate("uninspected"), tone: "warn" }
      ]
    },
    {
      ...latencyPanel("latency", "Latency"),
      help: "The web ACL's inspection, plus the protected resource's time for the requests it let through. AWS WAF publishes no latency metric."
    }
  ]
}
