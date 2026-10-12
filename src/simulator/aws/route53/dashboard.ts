import { type Dashboard, gauge, latencyPanel, rate, ratio, sum } from "../../Dashboard.ts"

/**
 * A record's dashboard, as Route 53's console and CloudWatch show its hosted zone and health checks: DNSQueries,
 * HealthCheckStatus, HealthCheckPercentageHealthy and the checkers' response time; and what CloudWatch can't see, the
 * resolvers between the callers and Route 53 (answers from their caches, and how many still point at an unhealthy record).
 * Names follow CloudWatch's (https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/monitoring-cloudwatch.html).
 */
export const dashboard: Dashboard = {
  figures: [
    { label: "DNS queries", metric: rate("queries"), unit: "perSecond", cloudwatch: "DNSQueries" },
    { label: "Resolver cache hits", metric: ratio(rate("cacheHits"), sum(rate("cacheHits"), rate("queries"))), unit: "ratio" },
    { label: "Healthy records", metric: gauge("healthyChecks"), unit: "count", cloudwatch: "HealthCheckStatus" },
    { label: "Lowest % healthy", metric: gauge("lowestPercentageHealthy"), unit: "ratio", cloudwatch: "HealthCheckPercentageHealthy" },
    { label: "Cached to unhealthy", metric: gauge("cachedUnhealthy"), unit: "ratio", tone: "warn" },
    { label: "No answer", metric: rate("noAnswer"), unit: "perSecond", tone: "bad" }
  ],
  panels: [
    {
      id: "queries",
      title: "DNS queries",
      unit: "perSecond",
      cloudwatch: ["DNSQueries"],
      help: "Lookups that reached Route 53 (a resolver's cached answer had expired), calls answered from a resolver's cache without asking, and queries Route 53 had no record for.",
      lines: [
        { label: "queries", metric: rate("queries"), tone: "primary" },
        { label: "from resolver caches", metric: rate("cacheHits"), tone: "ok" },
        { label: "no answer", metric: rate("noAnswer"), tone: "bad" }
      ]
    },
    {
      id: "cache-hit-rate",
      title: "Resolver cache hit rate",
      unit: "ratio",
      help: "The share of calls whose resolver still held a live answer: the higher it is, the longer a change of answer (a failover, a new weight) takes to reach the traffic. Not a CloudWatch metric.",
      lines: [{ label: "hit rate", metric: ratio(rate("cacheHits"), sum(rate("cacheHits"), rate("queries"))), tone: "ok" }]
    },
    {
      id: "status",
      title: "Health check status",
      unit: "count",
      cloudwatch: ["HealthCheckStatus"],
      help: "Records with a health check that Route 53 considers healthy and unhealthy, against how many have one. Each edge shows its own record's status.",
      lines: [
        { label: "healthy", metric: gauge("healthyChecks"), tone: "ok" },
        { label: "unhealthy", metric: gauge("unhealthyRecords"), tone: "bad" },
        { label: "health checks", metric: gauge("healthChecks"), tone: "muted", dashed: true }
      ]
    },
    {
      id: "percentage-healthy",
      title: "Health checkers reporting healthy",
      unit: "ratio",
      cloudwatch: ["HealthCheckPercentageHealthy"],
      help: "The lowest share of health checkers that say a record's endpoint is healthy (100% when no record has a health check). Route 53 calls an endpoint healthy while more than 18% of its checkers do.",
      lines: [
        { label: "lowest", metric: gauge("lowestPercentageHealthy"), tone: "warn" },
        { label: "healthy above", metric: gauge("healthyThreshold"), tone: "muted", dashed: true }
      ]
    },
    {
      id: "cached-unhealthy",
      title: "Answers cached to unhealthy records",
      unit: "ratio",
      help: "Of the resolvers holding a live answer, the share pointing at a record Route 53 now calls unhealthy: traffic still going to a failed endpoint until those answers' TTL runs out. Not a CloudWatch metric.",
      lines: [{ label: "cached to unhealthy", metric: gauge("cachedUnhealthy"), tone: "warn" }]
    },
    {
      id: "checks",
      title: "Health check requests",
      unit: "perSecond",
      help: "Results from the health checkers of every record (each checker probes its endpoint once an interval), the ones that failed, and Route 53 changing its verdict on an endpoint.",
      lines: [
        { label: "checks", metric: rate("probes"), tone: "primary" },
        { label: "failed", metric: rate("probeFailures"), tone: "bad" },
        { label: "verdict changes", metric: rate("healthChanges"), tone: "accent" }
      ]
    },
    {
      ...latencyPanel("check-time", "Health check time", "healthCheckTime", ["TimeToFirstByte", "ConnectionTime"]),
      help: "How long the checks the endpoints answered took: an HTTP check's first byte, a TCP check's connection. Checks that ran out of time are not in it."
    },
    {
      ...latencyPanel("latency", "Latency through the record"),
      help: "The callers' calls: a lookup when their resolver's answer had expired, then the endpoint's own time. Route 53 is not in the data path otherwise."
    }
  ]
}

/** A record's edge: its own health check, as CloudWatch reports one per health check. */
export const connectionDashboard: Dashboard = {
  figures: [
    { label: "Health check status", metric: gauge("healthCheckStatus"), unit: "count", cloudwatch: "HealthCheckStatus" },
    { label: "Checkers healthy", metric: gauge("healthCheckPercentageHealthy"), unit: "ratio", cloudwatch: "HealthCheckPercentageHealthy" }
  ],
  panels: [
    {
      id: "health-check-status",
      title: "Health check status",
      unit: "count",
      cloudwatch: ["HealthCheckStatus"],
      help: "1 while Route 53 considers this record's endpoint healthy, 0 when it doesn't. A record without a health check is always healthy.",
      lines: [{ label: "status", metric: gauge("healthCheckStatus"), tone: "ok" }]
    },
    {
      id: "percentage-healthy",
      title: "Health checkers reporting healthy",
      unit: "ratio",
      cloudwatch: ["HealthCheckPercentageHealthy"],
      help: "The share of health checkers that say this endpoint is healthy (100% without a health check). Route 53 calls it healthy while more than 18% do.",
      lines: [
        { label: "healthy", metric: gauge("healthCheckPercentageHealthy"), tone: "ok" },
        { label: "healthy above", metric: gauge("healthyThreshold"), tone: "muted", dashed: true }
      ]
    },
    {
      id: "health-checks",
      title: "Health checks",
      unit: "perSecond",
      help: "Health check requests that crossed this edge, among the calls the transport counts.",
      lines: [{ label: "checks", metric: rate("healthChecks"), tone: "primary" }]
    },
    {
      ...latencyPanel("check-time", "Health check time", "healthCheckTime", ["TimeToFirstByte", "ConnectionTime"]),
      help: "How long this endpoint took to answer its health checks: an HTTP check's first byte, a TCP check's connection."
    }
  ]
}
