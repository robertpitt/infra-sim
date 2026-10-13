import { Schema } from "effect"
import * as Component from "../../../Component.ts"
import * as Setting from "../../../Setting.ts"
import { docs } from "../../internal/docs.ts"

/** Where each number comes from. Every constant below names the page that says so. */
const D = docs.apigateway
export const LIMITS_URL = `${D}limits.html`
export const REST_QUOTAS_URL = `${D}api-gateway-execution-service-limits-table.html`
export const HTTP_QUOTAS_URL = `${D}http-api-quotas.html`
export const THROTTLING_URL = `${D}api-gateway-request-throttling.html`
export const HTTP_THROTTLING_URL = `${D}http-api-throttling.html`
export const USAGE_PLANS_URL = `${D}api-gateway-api-usage-plans.html`
export const CACHING_URL = `${D}api-gateway-caching.html`
export const LAMBDA_AUTHORIZER_URL = `${D}apigateway-use-lambda-authorizer.html`
export const HTTP_LAMBDA_AUTHORIZER_URL = `${D}http-api-lambda-authorizer.html`
export const JWT_AUTHORIZER_URL = `${D}http-api-jwt-authorizer.html`
export const GATEWAY_RESPONSES_URL = `${D}supported-gateway-response-types.html`
export const METRICS_URL = `${D}api-gateway-metrics-and-dimensions.html`
export const AUTHORIZER_API_URL = "https://docs.aws.amazon.com/apigateway/latest/api/API_CreateAuthorizer.html"
export const STAGE_API_URL = "https://docs.aws.amazon.com/apigateway/latest/api/API_CreateStage.html"

/** Largest request or response, REST and HTTP APIs alike (hard: 10 MB; the 413 body says 10485760 bytes). */
export const MAX_PAYLOAD = 10 * 1024 * 1024
/** HTTP APIs: maximum integration timeout (hard). */
export const HTTP_INTEGRATION_TIMEOUT_MS = 30_000
/** REST APIs: the default and, for edge-optimized APIs, the maximum integration timeout. */
export const REST_INTEGRATION_TIMEOUT_MS = 29_000
/** Shortest integration timeout, REST and HTTP. */
export const MIN_INTEGRATION_TIMEOUT_MS = 50
/** Largest response API Gateway will put in its cache (hard). */
export const MAX_CACHED_RESPONSE_BYTES = 1_048_576
/** REST cache capacities in GB, as the `cacheClusterSize` values the API accepts. */
export const CACHE_SIZES_GB = ["0.5", "1.6", "6.1", "13.5", "28.4", "58.2", "118", "237"] as const
/** Authorizer result cache TTL: the REST default, and the maximum for both API types. */
export const AUTHORIZER_DEFAULT_TTL_S = 300
export const AUTHORIZER_MAX_TTL_S = 3_600
/** HTTP APIs wait at most this long for a Lambda authorizer (hard). REST publishes no figure; the same is assumed. */
export const AUTHORIZER_TIMEOUT_MS = 10_000
/** A JWT authorizer caches the issuer's public keys for up to two hours, best effort (documented). */
export const JWKS_CACHE_MS = 2 * 60 * 60 * 1000
/** What one cold fetch of the issuer's keys costs on top of the request that triggers it (assumed). */
export const JWKS_FETCH_MS = 100
/** API keys per account and region (hard), which bounds the clients a usage plan can tell apart. */
export const MAX_API_KEYS = 10_000
/** Resources per REST API or routes per HTTP API (quota, default). */
export const MAX_ROUTES = 300
/** What the gateway sends a Lambda authorizer: headers and context, not the request body (assumed). */
export const AUTHORIZER_EVENT_BYTES = 2 * 1024
/** Distinct authorizer identities the simulator tracks; the result cache is one slot per identity. */
export const MAX_IDENTITIES = 100_000
/** Distinct cacheable keys the simulator tracks. */
export const MAX_CACHE_KEYS = 100_000

export const Config = Schema.Struct({
  apiType: Setting.choice(["rest", "http"], {
    default: "rest",
    labels: { rest: "REST API", http: "HTTP API" },
    help: "HTTP APIs are fixed at a 30 s integration timeout and have no usage plans or response cache; REST APIs cap at 29 s unless the account quota is raised."
  }),
  endpoint: Setting.choice(["regional", "edge", "private"], {
    default: "regional",
    labels: { regional: "Regional", edge: "Edge-optimized", private: "Private" },
    help: "REST endpoint type. Only Regional and private REST APIs can be given an integration timeout above 29 s; edge-optimized APIs stay at 29 s. The edge CloudFront hop is not modelled. Ignored for HTTP APIs."
  }),
  integrationType: Setting.choice(["proxy", "mock"], {
    default: "proxy",
    labels: { proxy: "Call the connected integration", mock: "MOCK (answer at the gateway)" },
    help: "Lambda, HTTP and AWS-service integrations all look the same here: the gateway calls whatever is connected to its Integration port. MOCK answers at the gateway and calls nothing."
  }),
  integrationTimeout: Setting.duration({
    default: "29 seconds",
    min: "50 millis",
    max: "5 minutes",
    label: "Integration timeout",
    help:
      "How long the gateway waits for the backend before answering 504. The backend keeps working afterwards. The effective limit is the smaller of this and what the API type allows: 30 s for HTTP, 29 s for edge-optimized REST, the account's integration timeout quota for Regional and private REST.",
    limit: Setting.hard(REST_QUOTAS_URL, "50 ms at the least. At most 30 s for HTTP APIs; 29 s for REST unless the account quota is raised (Regional and private only).")
  }),
  overhead: Setting.latency({
    mean: "10 millis",
    cv: 0.4,
    label: "Gateway overhead",
    help: "Time the gateway itself adds (CloudWatch Latency minus IntegrationLatency). AWS publishes no figure, so this is an assumption; typical values are a few to a few tens of ms."
  }),
  stageThrottle: Setting.group(
    {
      rate: Setting.int({
        default: 0,
        min: 0,
        max: 10_000_000,
        unit: "req/s",
        label: "Stage rate limit",
        help: "Default throttle for every method (REST) or route (HTTP) of the stage, below the account limit. With one route it is the stage's limit. 0 for none.",
        limit: Setting.quota(THROTTLING_URL, "Cannot be set above the account limit.")
      }),
      burst: Setting.int({ default: 0, min: 0, max: 10_000_000, label: "Stage burst", help: "Bucket size for the stage limit. 0 uses the rate." })
    },
    { label: "Stage throttling" }
  ),
  routes: Setting.int({
    default: 1,
    min: 1,
    max: MAX_ROUTES,
    label: "Routes",
    help:
      "How many methods or routes the API has. Requests spread evenly over them by their key (a hot key lands on one), and the stage throttle is applied to each separately. With 1 the whole API shares one stage bucket.",
    limit: Setting.quota(HTTP_QUOTAS_URL, "300 routes per HTTP API and 300 resources per REST API by default.")
  }),
  usagePlan: Setting.group(
    {
      enabled: Setting.bool({ default: false, help: "REST APIs only: identify clients by API key and throttle and cap each one. HTTP APIs have no usage plans, so this is ignored for them." }),
      clients: Setting.int({
        default: 10,
        min: 1,
        max: MAX_API_KEYS,
        label: "API keys",
        help: "Distinct clients. Requests spread over them by key, so a hot key is one noisy client.",
        limit: Setting.hard(REST_QUOTAS_URL, "10,000 API keys per account and Region.")
      }),
      rate: Setting.int({ default: 100, min: 0, max: 10_000_000, unit: "req/s", label: "Rate per client", help: "Steady rate for each API key (the plan's throttle). 0 for none. Applied before the stage and account limits." }),
      burst: Setting.int({ default: 0, min: 0, max: 10_000_000, label: "Burst per client", help: "Bucket size per API key. 0 uses the rate." }),
      quota: Setting.int({ default: 0, min: 0, max: 1_000_000_000, unit: "requests", label: "Quota per client", help: "Requests each key may make per period. 0 for none. Over it the client gets 429 until the period turns." }),
      period: Setting.choice(["day", "week", "month"], {
        default: "day",
        help: "The quota period. Windows are aligned to the start of the simulation (a month is 30 days); AWS aligns them to the calendar, so this is an assumption."
      })
    },
    { label: "Usage plan and API keys" }
  ),
  authorizer: Setting.group(
    {
      type: Setting.choice(["none", "lambda", "jwt", "iam", "cognito"], {
        default: "none",
        labels: { none: "None", lambda: "Lambda authorizer", jwt: "JWT (HTTP APIs)", iam: "IAM (SigV4)", cognito: "Cognito user pool (REST)" },
        help:
          "A Lambda authorizer calls the function connected to the Authorizer port (or, if nothing is connected, is timed by the latency below). JWT, IAM and Cognito are checked inside API Gateway and cost only the latency below."
      }),
      latency: Setting.latency({
        mean: "10 millis",
        cv: 0.4,
        label: "Check latency",
        help: "What authorising takes when no function is connected, and what JWT, IAM and Cognito checks cost. AWS publishes no figure: an assumption."
      }),
      ttl: Setting.duration({
        default: `${AUTHORIZER_DEFAULT_TTL_S} seconds`,
        min: 0,
        max: `${AUTHORIZER_MAX_TTL_S} seconds`,
        label: "Result cache TTL",
        help: "Lambda authorizers only. How long an allow or deny is cached per caller identity, so the function is not called again. 0 turns caching off.",
        limit: Setting.hard(AUTHORIZER_API_URL, "Default 300 s, at most 3,600 s.")
      }),
      identities: Setting.int({
        default: 1_000,
        min: 1,
        max: MAX_IDENTITIES,
        label: "Distinct callers",
        help: "How many different identities (tokens or header values) make requests. The authorizer result is cached per identity, so more callers means more authorizer calls."
      }),
      deny: Setting.ratio({
        default: 0,
        label: "Denied callers",
        help: "Share of identities the authorizer refuses. They get 403 (the answer is cached like an allow)."
      })
    },
    { label: "Authorization" }
  ),
  cache: Setting.group(
    {
      enabled: Setting.bool({ default: false, help: "REST APIs only: a stage cache in front of the integration. HTTP APIs have none, so this is ignored for them." }),
      size: Setting.choice(CACHE_SIZES_GB, {
        default: "0.5",
        labels: { "0.5": "0.5 GB", "1.6": "1.6 GB", "6.1": "6.1 GB", "13.5": "13.5 GB", "28.4": "28.4 GB", "58.2": "58.2 GB", "118": "118 GB", "237": "237 GB" },
        help: "Cache capacity. Together with the response size it decides how many entries fit; the oldest entry goes first when it is full (AWS does not publish its eviction policy). Changing it empties the cache."
      }),
      ttl: Setting.duration({
        default: "300 seconds",
        min: 0,
        max: "3600 seconds",
        label: "TTL",
        help: "How long a response is cached. 0 turns caching off.",
        limit: Setting.hard(CACHING_URL, "Default 300 s, at most 3,600 s.")
      }),
      keys: Setting.int({
        default: 1_000,
        min: 1,
        max: MAX_CACHE_KEYS,
        label: "Distinct cache keys",
        help: "How many different responses callers ask for (distinct values of the cache key parameters). The hit ratio comes from this: few keys, high ratio. A request's key decides which one it asks for."
      }),
      responseSize: Setting.int({
        default: 10,
        min: 1,
        max: 10_240,
        unit: "KB",
        label: "Response size",
        help: "Typical size of a cached response. Responses over 1 MB (1,048,576 bytes) are never cached.",
        limit: Setting.hard(CACHING_URL, "Cached responses are at most 1,048,576 bytes.")
      }),
      scope: Setting.choice(["get", "all"], {
        default: "get",
        labels: { get: "GET only (AWS default)", all: "Every method" },
        help: "Which requests are cached. Enabling a stage cache caches GET only; other methods need an override. A GET is a call whose edge into the gateway has Operation: read."
      }),
      hitLatency: Setting.latency({ mean: "2 millis", cv: 0.4, label: "Hit latency", help: "Time to answer from the cache, on top of the gateway overhead. AWS publishes no figure: an assumption." }),
      invalidate: Setting.ratio({
        default: 0,
        label: "Cache-Control: max-age=0",
        help: "Share of requests that ask for a fresh copy. They go to the integration and replace the cached entry."
      }),
      invalidation: Setting.choice(["allowed", "forbidden", "ignored"], {
        default: "allowed",
        labels: { allowed: "Anyone may invalidate (no policy)", forbidden: "Unauthorized: fail with 403", ignored: "Unauthorized: ignore the header" },
        help: "What happens to a Cache-Control: max-age=0 request. With no InvalidateCache policy any client can invalidate; with one, unauthorised requests either fail with 403 or are served from the cache."
      })
    },
    { label: "Response cache" }
  )
})
export type Settings = typeof Config.Type

// The default port comes first: edges drawn without naming a port go to the integration. The authorizer port takes the
// Lambda function that authorizes requests, so its cold starts and concurrency are the real thing.
export const ports = { out: Component.port.many("Integration"), authorizer: Component.port.one("Lambda authorizer") }

/** What a probe reports. */
export const State = Schema.Struct({
  accountTokens: Schema.Number,
  stageTokens: Schema.Number,
  served: Schema.Number,
  throttled: Schema.Number,
  quotaExceeded: Schema.Number,
  timeouts: Schema.Number,
  tooLarge: Schema.Number,
  integrationErrors: Schema.Number,
  authorizerInvocations: Schema.Number,
  authorizerDenied: Schema.Number,
  authorizerFailures: Schema.Number,
  cacheHits: Schema.Number,
  cacheMisses: Schema.Number,
  cacheEntries: Schema.Number
})
export type State = typeof State.Type
