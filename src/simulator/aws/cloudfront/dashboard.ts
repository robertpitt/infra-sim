import { type Dashboard, dist, gauge, latencyPanel, rate, ratio, sum } from "../../Dashboard.ts"

const errors = sum(rate("err4xx"), rate("err5xx"))
/**
 * An error rate: errors over the requests answered in the same stretch (not those that arrived), since both are counted
 * when the answer goes out. A minute of origin timeouts then reads as the share it was, never above 100%.
 */
const answered = sum(rate("ok"), rate("fail"))
const errorRate = (counter: string) => ratio(rate(counter), answered)

/**
 * A distribution's dashboard, as CloudFront's console and CloudWatch show one: requests, bytes downloaded and uploaded, the
 * error rates (4xx, 5xx, total, and with additional metrics 502, 503 and 504), the cache hit rate and origin latency; and
 * beyond CloudWatch, which tier answered, what the origins saw, and what the caches hold. Names follow CloudWatch's
 * (https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/programming-cloudwatch-metrics.html).
 */
export const dashboard: Dashboard = {
  figures: [
    { label: "Requests", metric: rate("requests"), unit: "perSecond", cloudwatch: "Requests" },
    { label: "Cache hit rate", metric: ratio(rate("cacheHit"), sum(rate("cacheHit"), rate("cacheMiss"))), unit: "ratio", cloudwatch: "CacheHitRate" },
    { label: "5xx error rate", metric: errorRate("err5xx"), unit: "ratio", tone: "bad", cloudwatch: "5xxErrorRate" },
    { label: "Total error rate", metric: ratio(errors, answered), unit: "ratio", tone: "warn", cloudwatch: "TotalErrorRate" },
    { label: "Origin latency p95", metric: dist("originLatency", "p95"), unit: "ms", cloudwatch: "OriginLatency" },
    { label: "Bytes downloaded", metric: rate("bytesDownloaded"), unit: "bytesPerSecond", cloudwatch: "BytesDownloaded" }
  ],
  panels: [
    {
      id: "requests",
      title: "Requests",
      unit: "perSecond",
      cloudwatch: ["Requests"],
      help: "Viewer requests, those answered from a cache, those that went to an origin, and those answered with an error.",
      lines: [
        { label: "requests", metric: rate("requests"), tone: "primary" },
        { label: "cache hits", metric: rate("cacheHit"), tone: "ok" },
        { label: "to origin", metric: rate("originRequests"), tone: "accent" },
        { label: "errors", metric: errors, tone: "bad" }
      ]
    },
    {
      id: "error-rate",
      title: "Error rate",
      unit: "ratio",
      cloudwatch: ["4xxErrorRate", "5xxErrorRate", "TotalErrorRate"],
      help: "The share of viewer requests answered with a 4xx, a 5xx, or either (of those answered in the same stretch).",
      lines: [
        { label: "4xx", metric: errorRate("err4xx"), tone: "warn" },
        { label: "5xx", metric: errorRate("err5xx"), tone: "bad" },
        { label: "total", metric: ratio(errors, answered), tone: "muted", dashed: true }
      ]
    },
    {
      id: "error-rate-5xx",
      title: "5xx error rate by status",
      unit: "ratio",
      cloudwatch: ["502ErrorRate", "503ErrorRate", "504ErrorRate"],
      help: "502: the origin failed or reset the connection. 503: the origin was unavailable, an edge function failed, or the distribution's request or bandwidth quota ran out. 504: the origin didn't answer within its response timeout.",
      lines: [
        { label: "502", metric: errorRate("err502"), tone: "bad" },
        { label: "503", metric: errorRate("err503"), tone: "warn" },
        { label: "504", metric: errorRate("err504"), tone: "accent" }
      ]
    },
    {
      id: "cache-hit-rate",
      title: "Cache hit rate",
      unit: "ratio",
      cloudwatch: ["CacheHitRate"],
      help: "Of the cacheable requests (reads that didn't end in an error), the share answered without going to the origin: from an edge location, the regional edge cache or Origin Shield, or by waiting on another request's fetch; and the share answered from an expired copy (stale-while-revalidate, or stale-if-error while the origin fails).",
      lines: [
        { label: "hit rate", metric: ratio(rate("cacheHit"), sum(rate("cacheHit"), rate("cacheMiss"))), tone: "ok" },
        { label: "stale", metric: ratio(rate("staleServed"), sum(rate("cacheHit"), rate("cacheMiss"))), tone: "warn" }
      ]
    },
    {
      id: "hits",
      title: "Hits by tier",
      unit: "perSecond",
      help: "Where cached answers came from: the viewer's edge location, the regional edge cache, Origin Shield, or another request's fetch already on its way (collapsed). Not a CloudWatch metric.",
      lines: [
        { label: "edge", metric: rate("edgeHit"), tone: "ok" },
        { label: "regional", metric: rate("regionalHit"), tone: "teal" },
        { label: "shield", metric: rate("shieldHit"), tone: "accent" },
        { label: "collapsed", metric: rate("collapsed"), tone: "primary" }
      ]
    },
    {
      id: "bytes",
      title: "Data transfer",
      unit: "bytesPerSecond",
      cloudwatch: ["BytesDownloaded", "BytesUploaded"],
      help: "Bytes viewers downloaded (GET and HEAD responses) and uploaded (POST and PUT bodies).",
      lines: [
        { label: "downloaded", metric: rate("bytesDownloaded"), tone: "primary" },
        { label: "uploaded", metric: rate("bytesUploaded"), tone: "accent" }
      ]
    },
    {
      ...latencyPanel("origin-latency", "Origin latency", "originLatency", ["OriginLatency"]),
      help: "From receiving a request to the origin's first byte, for requests answered from the origin rather than a cache."
    },
    {
      id: "origin",
      title: "Origin requests",
      unit: "perSecond",
      help: "What the origins saw: requests (one per object per tier however many viewers wait on it), the connection attempts CloudFront retried, the requests that failed, and the reads it failed over to a secondary origin. Not a CloudWatch metric.",
      lines: [
        { label: "requests", metric: rate("originRequests"), tone: "primary" },
        { label: "retries", metric: rate("originRetries"), tone: "warn" },
        { label: "errors", metric: rate("originErrors"), tone: "bad" },
        { label: "failovers", metric: rate("failover"), tone: "accent" }
      ]
    },
    {
      id: "functions",
      title: "Edge functions",
      unit: "perSecond",
      cloudwatch: ["FunctionInvocations", "FunctionExecutionErrors", "FunctionThrottles"],
      help: "Runs of the distribution's CloudFront Functions and Lambda@Edge, the requests a failed function turned into a 503, and Lambda@Edge runs refused by the Region's rate.",
      lines: [
        { label: "invocations", metric: rate("functionInvocations"), tone: "primary" },
        { label: "errors", metric: rate("functionErrors"), tone: "bad" },
        { label: "throttles", metric: rate("functionThrottles"), tone: "warn" }
      ]
    },
    {
      id: "objects",
      title: "Cached objects",
      unit: "count",
      help: "Objects held at the edge locations, the regional edge caches and Origin Shield, each summed over its locations (an edge location's cache only fills with what its own viewers asked for). Not a CloudWatch metric.",
      lines: [
        { label: "edge", metric: gauge("edgeObjects"), tone: "primary" },
        { label: "regional", metric: gauge("regionalObjects"), tone: "teal" },
        { label: "shield", metric: gauge("shieldObjects"), tone: "accent" }
      ]
    }
  ]
}
