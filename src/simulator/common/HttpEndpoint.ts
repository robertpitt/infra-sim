import { Effect, Schema } from "effect"
import * as Component from "../Component.ts"
import * as Distribution from "../Distribution.ts"
import * as Flow from "../Flow.ts"
import { Failed, Rejected, Throttled, Unavailable } from "../Message.ts"
import * as Setting from "../Setting.ts"
import * as dashboards from "./dashboards.ts"

/**
 * Something outside your system that you call over HTTP: a payment provider, a partner's webhook, any third-party
 * API. You don't control it, so everything about it is a setting: how slow it is, how often it fails, how hard it
 * pushes back. It runs "on the internet", in whichever geography you place it, so distance shows up in the latency.
 */
export const HttpEndpoint = Component.make({
  type: "common.http-endpoint",
  provider: "internet",
  service: "HTTP endpoint",
  title: "HTTP endpoint",
  description: "An external receiver outside your system: a third-party API or webhook with its own latency, error rate and rate limit.",
  category: "external",
  icon: "globe",
  accent: "#7d8aa3",
  dashboard: dashboards.httpEndpoint,
  highlights: [
    { gauge: "inflight", label: "in flight" },
    { rate: "fail.Throttled", label: "429/s" }
  ],
  config: Schema.Struct({
    latency: Setting.latency({ mean: "120 millis", cv: 0.6, label: "Response time", help: "How long the receiver takes to answer, once the request arrives." }),
    errorRate: Setting.ratio({ default: 0, label: "Error rate", help: "Fraction of requests answered with a 5xx." }),
    rateLimit: Setting.int({ default: 0, min: 0, max: 10_000_000, unit: "req/s", label: "Rate limit", help: "Requests per second before it answers 429. 0 for no limit." }),
    burst: Setting.int({ default: 0, min: 0, max: 10_000_000, label: "Rate limit burst", help: "Requests allowed above the steady rate at once. 0 allows as many as one second's worth." }),
    maxConcurrency: Setting.int({ default: 0, min: 0, max: 10_000_000, unit: "requests", label: "Max concurrent requests", help: "Beyond this it answers 503 at once. 0 for no limit." }),
    maxPayload: Setting.number({ default: 0, min: 0, max: 1_000_000, unit: "KB", label: "Max request size", help: "Larger requests are refused with 413. 0 for no limit." })
  }),
  state: Schema.Struct({
    inflight: Schema.Number,
    served: Schema.Number,
    errors: Schema.Number,
    rateLimited: Schema.Number,
    refused: Schema.Number
  }),
  make: (node) =>
    Effect.sync(() => {
      const { fast } = node
      let inflight = 0
      const totals = { served: 0, errors: 0, rateLimited: 0, refused: 0 }
      node.meter.gaugeUnsafe("inflight", () => inflight)
      const key = `${node.id}/rate`

      return {
        call: (message) => {
          const c = fast.settings()
          if (c.maxPayload > 0 && message.bytes > c.maxPayload * 1024) {
            totals.refused++
            return Effect.fail(Rejected({ node: node.id, reason: "413 payload too large" }))
          }
          if (c.rateLimit > 0 && !node.limiter.takeUnsafe(key, { rate: c.rateLimit, burst: c.burst > 0 ? c.burst : c.rateLimit })) {
            totals.rateLimited++
            return Effect.fail(Throttled({ node: node.id, reason: "429 too many requests" }))
          }
          if (c.maxConcurrency > 0 && inflight >= c.maxConcurrency) {
            totals.refused++
            return Effect.fail(Unavailable({ node: node.id, reason: "503 at capacity" }))
          }
          inflight++
          return Flow.delayed(
            fast,
            Distribution.latencyMs(c.latency, fast.random),
            () => {
              inflight--
              if (c.errorRate > 0 && fast.random.nextDoubleUnsafe() < c.errorRate) {
                totals.errors++
                return Failed({ node: node.id, reason: "500 internal server error" })
              }
              totals.served++
              return undefined
            },
            () => void inflight--
          )
        },
        probe: Effect.sync(() => ({ inflight, ...totals }))
      }
    })
})
