import { Duration, Effect, Schema } from "effect"
import * as Component from "../Component.ts"
import * as Distribution from "../Distribution.ts"
import * as Edge from "../Edge.ts"
import type { Bucket } from "../Limiter.ts"
import { type CallFailure, Failed, Rejected, Throttled, Timeout, Unavailable } from "../Message.ts"
import { keyOf } from "../Provider.ts"
import * as Setting from "../Setting.ts"
import type { TimerHandle } from "../VirtualTime.ts"
import * as Aws from "./provider.ts"

/** Largest request or response, REST and HTTP APIs alike. Not adjustable. */
const MAX_PAYLOAD = 10 * 1024 * 1024
const LIMITS = `${Aws.docs.apigateway}limits.html`

export const ApiGateway = Aws.component({
  type: "aws.apigateway",
  service: "API Gateway",
  title: "API Gateway",
  description: "Front door for HTTP APIs. Throttles with a token bucket, answers 504 when the integration is too slow, and refuses oversized requests.",
  docs: LIMITS,
  category: "network",
  icon: "gateway",
  accent: "#e7157b",
  limits: [
    { label: "Account burst (token bucket size)", value: "5,000 requests (1,250 in the smaller regions)", adjustable: false, source: LIMITS, note: "AWS says this is determined by the service team, not a customer quota." },
    { label: "Payload size", value: "10 MB", adjustable: false, source: LIMITS },
    { label: "HTTP API integration timeout", value: "30 s maximum", adjustable: false, source: `${Aws.docs.apigateway}http-api-quotas.html` },
    { label: "REST API integration timeout", value: "50 ms to 29 s", adjustable: true, source: `${Aws.docs.apigateway}api-gateway-execution-service-limits-table.html`, note: "Regional and private REST APIs can request more than 29 s." },
    { label: "Throttle responses", value: "429 over the limit, 504 on integration timeout, 413 over 10 MB", adjustable: false, source: `${Aws.docs.apigateway}api-gateway-request-throttling.html` }
  ],
  highlights: [
    { gauge: "inflight", label: "in flight" },
    { rate: "fail.Throttled", label: "429/s" },
    { rate: "fail.Timeout", label: "504/s" }
  ],
  config: Schema.Struct({
    apiType: Setting.choice(["rest", "http"], { default: "rest", labels: { rest: "REST API", http: "HTTP API" }, help: "HTTP APIs are fixed at a 30 s integration timeout; REST APIs cap at 29 s unless raised." }),
    integrationTimeout: Setting.duration({
      default: "29 seconds",
      min: "50 millis",
      max: "30 seconds",
      label: "Integration timeout",
      help: "How long the gateway waits for the backend before answering 504. The backend keeps working afterwards.",
      limit: Setting.hard(`${Aws.docs.apigateway}api-gateway-execution-service-limits-table.html`, "REST: 50 ms to 29 s. HTTP: up to 30 s.")
    }),
    overhead: Setting.latency({ mean: "10 millis", cv: 0.4, label: "Gateway overhead", help: "Time the gateway itself adds. AWS publishes no figure, so this is an assumption; typical values are a few to a few tens of ms." }),
    stageThrottle: Setting.group(
      {
        rate: Setting.int({ default: 0, min: 0, max: 10_000_000, unit: "req/s", label: "Stage rate limit", help: "Per-stage throttle, below the account limit. 0 for none.", limit: Setting.quota(`${Aws.docs.apigateway}api-gateway-request-throttling.html`) }),
        burst: Setting.int({ default: 0, min: 0, max: 10_000_000, label: "Stage burst", help: "Bucket size for the stage limit. 0 uses the rate." })
      },
      { label: "Stage throttling" }
    )
  }),
  ports: { out: Component.port.many("Integration") },
  state: Schema.Struct({
    accountTokens: Schema.Number,
    stageTokens: Schema.Number,
    served: Schema.Number,
    throttled: Schema.Number,
    timeouts: Schema.Number,
    tooLarge: Schema.Number,
    integrationErrors: Schema.Number
  }),
  make: (node) =>
    Effect.sync(() => {
      const { fast } = node
      type Config = ReturnType<typeof fast.settings>
      const out = node.out("out")
      const region = node.placement.region
      const accountKey = `${keyOf(node.placement)}/apigateway`
      const stageKey = `${node.id}/stage`
      let inflight = 0
      const totals = { served: 0, throttled: 0, timeouts: 0, tooLarge: 0, integrationErrors: 0 }
      node.meter.gaugeUnsafe("inflight", () => inflight)

      // Buckets are rebuilt only when the settings or quotas they come from are replaced.
      let accountFrom: Aws.Account | undefined
      let accountMemo: Bucket = { rate: 0, burst: 0 }
      const accountBucket = (): Bucket => {
        const a = fast.account() as Aws.Account
        if (a !== accountFrom) {
          accountFrom = a
          accountMemo = { rate: a.apiGatewayRate, burst: Aws.apiGatewayBurst(region) }
        }
        return accountMemo
      }
      let stageFrom: Config | undefined
      let stageMemo: Bucket = { rate: 0, burst: 0 }
      const stageBucket = (c: Config): Bucket => {
        if (c !== stageFrom) {
          stageFrom = c
          stageMemo = { rate: c.stageThrottle.rate, burst: c.stageThrottle.burst > 0 ? c.stageThrottle.burst : c.stageThrottle.rate }
        }
        return stageMemo
      }

      return {
        call: (message) => {
          const c = fast.settings()
          if (message.bytes > MAX_PAYLOAD) {
            totals.tooLarge++
            return Effect.fail(Rejected({ node: node.id, reason: "413 request too large" }))
          }
          // Per-stage limit first, then the account's: the more specific bucket decides before the shared one is spent.
          const withinStage = c.stageThrottle.rate === 0 || node.limiter.takeUnsafe(stageKey, stageBucket(c))
          if (!withinStage || !node.limiter.takeUnsafe(accountKey, accountBucket())) {
            totals.throttled++
            return Effect.fail(Throttled({ node: node.id, reason: "429 too many requests" }))
          }
          inflight++
          const overhead = Distribution.latencyMs(c.overhead, fast.random)
          // One request through the gateway, as a small state machine: wait out the gateway's own overhead, hand the request to
          // the integration, and answer with whatever comes back first, the integration or the gateway's timeout. Like most
          // gateways it gives up without telling the backend, so a timeout leaves the integration's work running.
          return Effect.callback<void, CallFailure>((resume) => {
            let open = true
            let timer: TimerHandle | undefined
            const finish = (failure: CallFailure | undefined, direct = false): void => {
              if (!open) return
              open = false
              timer?.cancel()
              inflight--
              if (failure === undefined) {
                totals.served++
                return resume(Effect.void)
              }
              if (direct) return resume(Effect.fail(failure))
              if (failure._tag === "Timeout") totals.timeouts++
              else totals.integrationErrors++
              // The gateway answers for its backend: its own timeout is a 504, a refused request stays a 4xx, anything else is a 502.
              resume(
                Effect.fail(
                  failure._tag === "Timeout" || failure._tag === "Rejected"
                    ? failure
                    : Failed({ node: node.id, reason: `502 integration failed (${failure._tag})` })
                )
              )
            }
            const route = (): void => {
              const link = Edge.pickUnsafe(out, fast.random)
              if (link === undefined) return finish(Unavailable({ node: node.id, reason: "502 no integration" }), true)
              const limit = Math.min(Duration.toMillis(c.integrationTimeout), (c.apiType === "http" ? 30 : 29) * 1000)
              timer = fast.after(limit, () => finish(Timeout({ edge: node.id, after: limit })), undefined)
              link.send(message, finish)
            }
            timer = fast.after(overhead, route, undefined)
            return Effect.sync(() => {
              if (!open) return
              open = false
              timer?.cancel()
              inflight--
            })
          })
        },
        probe: Effect.sync(() => {
          const c = fast.settings()
          const stage = stageBucket(c)
          return {
            accountTokens: node.limiter.levelUnsafe(accountKey, accountBucket()),
            stageTokens: stage.rate === 0 ? 0 : node.limiter.levelUnsafe(stageKey, stage),
            ...totals
          }
        })
      }
    })
})

