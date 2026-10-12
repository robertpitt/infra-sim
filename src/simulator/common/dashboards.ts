import { type Dashboard, dist, gauge, latencyPanel, rate, ratio, sum } from "../Dashboard.ts"

/**
 * The provider-neutral components' dashboards. They belong to no cloud, so they name no CloudWatch metric; each panel's
 * help says what a real system would show for it (a synthetic canary for clients, a load balancer and an orchestrator for
 * a service, an API's status codes for an endpoint, a Durable Object namespace for actors).
 */


/** Answered ones over every answered one: a request still in flight is in neither. */
const successRate = ratio(rate("ok"), sum(rate("ok"), rate("fail")))

/** Traffic from outside, as its users (or a synthetic canary: CloudWatch Synthetics' SuccessPercent and Duration) see it. */
export const client: Dashboard = {
  figures: [
    { label: "Sent", metric: rate("sent"), unit: "perSecond" },
    { label: "Success rate", metric: successRate, unit: "ratio" },
    { label: "Failed", metric: rate("fail"), unit: "perSecond", tone: "bad" },
    { label: "Throttled", metric: rate("fail.Throttled"), unit: "perSecond", tone: "warn" },
    { label: "Latency p95", metric: dist("latency", "p95"), unit: "ms" },
    { label: "In flight", metric: gauge("outstanding"), unit: "count" }
  ],
  panels: [
    {
      id: "requests",
      title: "Requests",
      unit: "perSecond",
      help: "Requests sent, and how they ended: answered, or failed after whatever retries their edge allows.",
      lines: [
        { label: "sent", metric: rate("sent"), tone: "primary" },
        { label: "ok", metric: rate("ok"), tone: "ok" },
        { label: "failed", metric: rate("fail"), tone: "bad" }
      ]
    },
    {
      id: "success-rate",
      title: "Success rate",
      unit: "ratio",
      help: "Requests answered over requests that ended: what a synthetic canary's SuccessPercent, or an SLO's availability, measures.",
      lines: [{ label: "succeeded", metric: successRate, tone: "ok" }]
    },
    {
      id: "failures",
      title: "Failures by kind",
      unit: "perSecond",
      help: "Why requests failed, as a caller sees it: throttled (429), unavailable (503), an error (500), refused as invalid (4xx), or given up on at the edge's timeout. No route: there was no edge to send it down.",
      lines: [
        { label: "429", metric: rate("fail.Throttled"), tone: "warn" },
        { label: "503", metric: rate("fail.Unavailable"), tone: "bad" },
        { label: "500", metric: rate("fail.Failed"), tone: "teal" },
        { label: "4xx", metric: rate("fail.Rejected"), tone: "muted" },
        { label: "timeout", metric: rate("fail.Timeout"), tone: "accent" },
        { label: "no route", metric: rate("noroute"), tone: "primary" }
      ]
    },
    {
      ...latencyPanel("latency", "Latency, end to end"),
      help: "From sending to the answer, retries and every hop included, of requests that succeeded."
    },
    {
      id: "inflight",
      title: "In flight",
      unit: "count",
      help: "Requests sent and not yet answered. It grows when what they call slows down: the concurrency a client holds open.",
      lines: [{ label: "in flight", metric: gauge("outstanding"), tone: "accent" }]
    }
  ]
}

/** A third party's API, as its status codes and response time (an API's Count, 4XXError, 5XXError, Latency) show it. */
export const httpEndpoint: Dashboard = {
  figures: [
    { label: "Requests", metric: rate("in"), unit: "perSecond" },
    { label: "5xx errors", metric: rate("fail.Failed"), unit: "perSecond", tone: "bad" },
    { label: "Throttled", metric: rate("fail.Throttled"), unit: "perSecond", tone: "warn" },
    { label: "Latency p95", metric: dist("latency", "p95"), unit: "ms" },
    { label: "In flight", metric: gauge("inflight"), unit: "count" }
  ],
  panels: [
    {
      id: "requests",
      title: "Requests",
      unit: "perSecond",
      lines: [
        { label: "arriving", metric: rate("in"), tone: "primary" },
        { label: "ok", metric: rate("ok"), tone: "ok" },
        { label: "failed", metric: rate("fail"), tone: "bad" }
      ]
    },
    {
      id: "status",
      title: "Errors by status",
      unit: "perSecond",
      help: "What it answered besides 200: 5xx at its error rate, 429 past its rate limit, 503 past its concurrency limit, 413 for a request over its size limit.",
      lines: [
        { label: "5xx", metric: rate("fail.Failed"), tone: "bad" },
        { label: "429", metric: rate("fail.Throttled"), tone: "warn" },
        { label: "503", metric: rate("fail.Unavailable"), tone: "accent" },
        { label: "413", metric: rate("fail.Rejected"), tone: "muted" }
      ]
    },
    {
      id: "error-rate",
      title: "Error rate",
      unit: "ratio",
      help: "Requests that failed over requests that arrived.",
      lines: [{ label: "errors", metric: ratio(rate("fail"), rate("in")), tone: "bad" }]
    },
    { ...latencyPanel("latency", "Response time"), help: "How long it took to answer, once a request arrived." },
    {
      id: "inflight",
      title: "In flight",
      unit: "count",
      help: "Requests it is working on: past its maximum concurrency, it answers 503.",
      lines: [{ label: "in flight", metric: gauge("inflight"), tone: "accent" }]
    }
  ]
}

/** Replicas behind a balancer, as a load balancer (RequestCount, TargetResponseTime) and an orchestrator (running and desired tasks, CPU) show them. */
export const service: Dashboard = {
  figures: [
    { label: "Requests", metric: rate("in"), unit: "perSecond" },
    { label: "Failed", metric: rate("fail"), unit: "perSecond", tone: "bad" },
    { label: "Latency p95", metric: dist("latency", "p95"), unit: "ms" },
    { label: "Ready", metric: gauge("ready"), unit: "count" },
    { label: "Busy", metric: gauge("utilization"), unit: "ratio" },
    { label: "Queued", metric: gauge("queued"), unit: "count" }
  ],
  panels: [
    {
      id: "requests",
      title: "Requests",
      unit: "perSecond",
      help: "Requests arriving, answered, and failed: an error (its own or downstream's), or unavailable (503) because every worker was busy and the queue full, or the replica was lost.",
      lines: [
        { label: "arriving", metric: rate("in"), tone: "primary" },
        { label: "ok", metric: rate("ok"), tone: "ok" },
        { label: "failed", metric: rate("fail"), tone: "bad" },
        { label: "unavailable (503)", metric: rate("fail.Unavailable"), tone: "warn" }
      ]
    },
    { ...latencyPanel("latency", "Latency"), help: "From arriving to the answer: waiting for a worker, the service time, and the downstream calls." },
    {
      id: "replicas",
      title: "Replicas",
      unit: "count",
      help: "Replicas ready, starting and draining, against the number asked for (an orchestrator's running and desired counts). Ready lagging desired is the start-up time.",
      lines: [
        { label: "ready", metric: gauge("ready"), tone: "primary" },
        { label: "starting", metric: gauge("starting"), tone: "warn" },
        { label: "draining", metric: gauge("draining"), tone: "muted" },
        { label: "desired", metric: gauge("replicas"), tone: "accent", dashed: true }
      ]
    },
    {
      id: "utilization",
      title: "Utilization",
      unit: "ratio",
      help: "Busy workers over the ready replicas' workers: what CPU utilization stands for. At 100% requests queue.",
      lines: [{ label: "busy", metric: gauge("utilization"), tone: "primary" }]
    },
    {
      id: "workers",
      title: "Workers and queue",
      unit: "count",
      help: "Requests being worked on, and requests waiting for a worker (refused with 503 past the queue limit).",
      lines: [
        { label: "busy", metric: gauge("busy"), tone: "primary" },
        { label: "queued", metric: gauge("queued"), tone: "warn" }
      ]
    }
  ]
}

/** Keyed single-threaded objects, as a Durable Object namespace's requests, active objects and wall time show them. */
export const actor: Dashboard = {
  figures: [
    { label: "Requests", metric: rate("in"), unit: "perSecond" },
    { label: "Failed", metric: rate("fail"), unit: "perSecond", tone: "bad" },
    { label: "Overloaded", metric: rate("overloaded"), unit: "perSecond", tone: "warn" },
    { label: "Latency p95", metric: dist("latency", "p95"), unit: "ms" },
    { label: "In memory", metric: gauge("instances"), unit: "count" },
    { label: "Cold starts", metric: rate("coldStarts"), unit: "perSecond" }
  ],
  panels: [
    {
      id: "requests",
      title: "Requests",
      unit: "perSecond",
      help: "Requests arriving, answered, failed, and of those refused because their object's queue was full (overloaded, 503): a hot key.",
      lines: [
        { label: "arriving", metric: rate("in"), tone: "primary" },
        { label: "ok", metric: rate("ok"), tone: "ok" },
        { label: "failed", metric: rate("fail"), tone: "bad" },
        { label: "overloaded", metric: rate("overloaded"), tone: "warn" }
      ]
    },
    { ...latencyPanel("latency", "Latency"), help: "From arriving to the answer: waiting for the object (its queue, its cold start), its handler, and the downstream calls." },
    {
      id: "objects",
      title: "Objects in memory",
      unit: "count",
      help: "Objects started and not yet evicted for being idle: a Durable Object namespace's active objects.",
      lines: [{ label: "in memory", metric: gauge("instances"), tone: "accent" }]
    },
    {
      id: "cold-starts",
      title: "Cold starts",
      unit: "perSecond",
      help: "Requests that found their object not in memory, so it was started first. Many keys touched rarely means many cold starts.",
      lines: [{ label: "cold starts", metric: rate("coldStarts"), tone: "warn" }]
    },
    {
      id: "queued",
      title: "Queued",
      unit: "count",
      help: "Requests waiting for their object, over every object. One object runs one request at a time, so a hot key's queue grows while the rest are idle.",
      lines: [{ label: "queued", metric: gauge("queued"), tone: "warn" }]
    }
  ]
}
