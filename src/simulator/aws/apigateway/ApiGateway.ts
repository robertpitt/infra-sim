import { Effect } from "effect"
import * as Aws from "../internal/provider.ts"
import { dashboard } from "./internal/dashboard.ts"
import {
  CACHING_URL,
  Config,
  GATEWAY_RESPONSES_URL,
  HTTP_QUOTAS_URL,
  LIMITS_URL,
  ports,
  REST_QUOTAS_URL,
  State,
  THROTTLING_URL
} from "./internal/config.ts"
import { makeRuntime } from "./internal/runtime.ts"

/**
 * Amazon API Gateway: the front door of a REST or HTTP API. Requests pass the throttle layers (usage plan, stage,
 * account), then the authorizer on the `authorizer` port, the stage's response cache and the integration on `out`,
 * and the gateway answers for its backend: 429, 413, 403, 504, 502 and 503 as AWS does. See `README.md`.
 */
export const ApiGateway = Aws.component({
  type: "aws.apigateway",
  service: "API Gateway",
  title: "API Gateway",
  description:
    "Front door for REST and HTTP APIs. Throttles in layers (usage plan, stage, account) with token buckets, authorizes callers (Lambda authorizer with a result cache, JWT, IAM), caches REST responses, answers 504 when the integration is too slow and 413 when the request is too large.",
  docs: LIMITS_URL,
  category: "network",
  icon: "gateway",
  accent: "#e7157b",
  limits: [
    { label: "Account throttle (token bucket rate)", value: "10,000 requests/s (2,500 in the smaller regions)", adjustable: true, source: LIMITS_URL, note: "Shared by REST, HTTP and WebSocket APIs in the account and Region. An account quota setting." },
    { label: "Account burst (token bucket size)", value: "5,000 requests (1,250 in the smaller regions)", adjustable: false, source: LIMITS_URL, note: "AWS says the service team decides it; a customer cannot change it or ask for a change." },
    { label: "Payload size", value: "10 MB", adjustable: false, source: LIMITS_URL },
    { label: "HTTP API integration timeout", value: "30 s maximum", adjustable: false, source: HTTP_QUOTAS_URL },
    { label: "REST API integration timeout", value: "50 ms to 29 s", adjustable: true, source: REST_QUOTAS_URL, note: "Regional and private REST APIs can raise it through an account quota; edge-optimized APIs cannot." },
    { label: "Throttle layers, in order", value: "usage plan, stage method settings, account", adjustable: false, source: THROTTLING_URL, note: "429 when any is exceeded. Throttles and quotas are best effort: targets, not guaranteed ceilings." },
    { label: "Gateway responses", value: "429 throttled or quota exceeded, 413 too large, 504 integration timeout, 403 denied, 500 authorizer failure", adjustable: false, source: GATEWAY_RESPONSES_URL },
    { label: "Response cache", value: "0.5 to 237 GB, TTL 0 to 3,600 s (300 default), responses up to 1,048,576 bytes", adjustable: false, source: CACHING_URL, note: "GET methods only unless overridden." }
  ],
  dashboard,
  highlights: [
    { gauge: "inflight", label: "in flight" },
    { rate: "fail.Throttled", label: "429/s" },
    { rate: "fail.Timeout", label: "504/s" }
  ],
  config: Config,
  ports,
  state: State,
  make: (node) => Effect.sync(() => makeRuntime(node))
})
