import { type Dashboard, dist, gauge, latencyPanel, rate, ratio, sum } from "../../Dashboard.ts"

/** Requests answered, well or not: what an error rate is a share of, counted as the errors are, when the answer goes out. */
const answered = sum(rate("ok"), rate("fail"))

/**
 * An API's dashboard, as the API Gateway console and CloudWatch show one: requests (Count) with their 4XXError and 5XXError,
 * Latency and IntegrationLatency, the cache's hits and misses, and what the simulator can show beyond CloudWatch: which
 * throttle layer said 429, the authorizer, and the account's token bucket. Names follow CloudWatch's
 * (https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-metrics-and-dimensions.html, and for HTTP APIs
 * https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-metrics.html).
 */
export const dashboard: Dashboard = {
  figures: [
    { label: "Requests", metric: rate("in"), unit: "perSecond", cloudwatch: "Count" },
    { label: "4XX errors", metric: rate("status.4xx"), unit: "perSecond", tone: "warn", cloudwatch: "4XXError" },
    { label: "5XX errors", metric: rate("status.5xx"), unit: "perSecond", tone: "bad", cloudwatch: "5XXError" },
    { label: "Latency p95", metric: dist("latency", "p95"), unit: "ms", cloudwatch: "Latency" },
    { label: "Integration p95", metric: dist("integrationLatency", "p95"), unit: "ms", cloudwatch: "IntegrationLatency" },
    { label: "Cache hit rate", metric: ratio(rate("cache.hit"), sum(rate("cache.hit"), rate("cache.miss"))), unit: "ratio", cloudwatch: "CacheHitCount" }
  ],
  panels: [
    {
      id: "requests",
      title: "Requests",
      unit: "perSecond",
      cloudwatch: ["Count", "4XXError", "5XXError"],
      help: "Every request the API received, throttled and refused ones included, and how they ended: a client error (4XX: throttled, refused, denied) or a server error (5XX: timed out, the backend or the authorizer failed).",
      lines: [
        { label: "count", metric: rate("in"), tone: "primary" },
        { label: "ok", metric: rate("ok"), tone: "ok" },
        { label: "4XX", metric: rate("status.4xx"), tone: "warn" },
        { label: "5XX", metric: rate("status.5xx"), tone: "bad" }
      ]
    },
    {
      id: "error-rate",
      title: "Error rate",
      unit: "ratio",
      cloudwatch: ["4XXError (Average)", "5XXError (Average)"],
      help: "The share of answers that were errors, as the Average statistic of 4XXError and 5XXError reads. Counted when the answer goes out, so a burst of 504s after a slow minute reads as the share it was.",
      lines: [
        { label: "4XX", metric: ratio(rate("status.4xx"), answered), tone: "warn" },
        { label: "5XX", metric: ratio(rate("status.5xx"), answered), tone: "bad" }
      ]
    },
    {
      ...latencyPanel("latency", "Latency", "latency", ["Latency"]),
      help: "From receiving a request to answering it: the gateway's overhead, the authorizer, the cache and the integration."
    },
    {
      ...latencyPanel("integration-latency", "Integration latency", "integrationLatency", ["IntegrationLatency"]),
      help: "From relaying a request to the backend to its answer. Not recorded for cache hits, or when the gateway gives up first (504)."
    },
    {
      id: "throttles",
      title: "Throttles by layer",
      unit: "perSecond",
      cloudwatch: ["4XXError"],
      help: "429s by the layer that refused the request: a client's usage plan (its rate, or its quota for the period), the stage's or method's limit, or the account's bucket shared by every API in the Region. CloudWatch counts them all as 4XXError.",
      lines: [
        { label: "plan rate", metric: rate("throttled.usagePlan"), tone: "warn" },
        { label: "plan quota", metric: rate("throttled.quota"), tone: "accent" },
        { label: "stage", metric: rate("throttled.stage"), tone: "teal" },
        { label: "account", metric: rate("throttled.account"), tone: "bad" }
      ]
    },
    {
      id: "errors",
      title: "Errors by response",
      unit: "perSecond",
      cloudwatch: ["5XXError", "4XXError"],
      help: "What the gateway answered when it couldn't give a good response: 504 when the integration was too slow, 502 or 500 when the backend or the authorizer failed, 503 when the backend was down, 403 or 413 when it refused the request (the backend's own 4xx included).",
      lines: [
        { label: "504 timeout", metric: rate("fail.Timeout"), tone: "warn" },
        { label: "502 / 500", metric: rate("fail.Failed"), tone: "bad" },
        { label: "503", metric: rate("fail.Unavailable"), tone: "accent" },
        { label: "403 / 413", metric: rate("fail.Rejected"), tone: "muted" }
      ]
    },
    {
      id: "cache",
      title: "Cache",
      unit: "perSecond",
      cloudwatch: ["CacheHitCount", "CacheMissCount"],
      help: "Requests answered from the stage's cache, and those that went to the backend. REST APIs with a cache only; GET requests unless the stage caches every method.",
      lines: [
        { label: "hits", metric: rate("cache.hit"), tone: "ok" },
        { label: "misses", metric: rate("cache.miss"), tone: "warn" }
      ]
    },
    {
      id: "authorizer",
      title: "Authorizer",
      unit: "perSecond",
      help: "Lambda authorizer calls, answers from its result cache, callers it denied (403), and checks that failed (500). CloudWatch shows these on the authorizer function (Invocations, Errors), not on the API.",
      lines: [
        { label: "invocations", metric: rate("auth.invocations"), tone: "primary" },
        { label: "cached", metric: rate("auth.cacheHit"), tone: "ok" },
        { label: "denied", metric: rate("auth.denied"), tone: "warn" },
        { label: "failed", metric: rate("auth.failed"), tone: "bad" }
      ]
    },
    {
      id: "account-bucket",
      title: "Account token bucket",
      unit: "count",
      help: "Tokens left in the account's bucket for the Region, which every API in it draws from; at 0 the account throttles with 429. It refills at the account's rate up to its burst. Not a CloudWatch metric.",
      lines: [
        { label: "tokens", metric: gauge("accountTokens"), tone: "primary" },
        { label: "burst", metric: gauge("accountBurst"), tone: "muted", dashed: true }
      ]
    },
    {
      id: "data",
      title: "Data processed",
      unit: "bytesPerSecond",
      cloudwatch: ["DataProcessed"],
      help: "Bytes of the requests the gateway admitted. HTTP APIs publish it; responses carry no size here, so it counts requests only.",
      lines: [{ label: "processed", metric: rate("dataProcessed"), tone: "accent" }]
    }
  ]
}
