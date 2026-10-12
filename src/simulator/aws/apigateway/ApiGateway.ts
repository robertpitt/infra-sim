import { Effect, Schema } from "effect"
import * as Component from "../../Component.ts"
import * as Distribution from "../../Distribution.ts"
import * as Edge from "../../Edge.ts"
import { type Cancel, noCancel } from "../../Flow.ts"
import { type CallFailure, Failed, type Message, Rejected, Throttled, Timeout, Unavailable } from "../../Message.ts"
import { keyOf } from "../../Provider.ts"
import type { TimerHandle } from "../../VirtualTime.ts"
import * as Aws from "../provider.ts"
import { isDenied, identityOf, makeAuthorizerCache, Verdict } from "./authorizer.ts"
import { cacheKeyOf, makeResponseCache } from "./cache.ts"
import { dashboard } from "./dashboard.ts"
import {
  AUTHORIZER_EVENT_BYTES,
  AUTHORIZER_TIMEOUT_MS,
  CACHING_URL,
  Config,
  GATEWAY_RESPONSES_URL,
  HTTP_QUOTAS_URL,
  JWKS_CACHE_MS,
  JWKS_FETCH_MS,
  LIMITS_URL,
  MAX_PAYLOAD,
  REST_QUOTAS_URL,
  type Settings,
  THROTTLING_URL
} from "./config.ts"
import { derive, type Plan } from "./plan.ts"
import { Admit, makeThrottle } from "./throttle.ts"

/** Why each layer says 429, in the words of the gateway response it maps to (THROTTLED, QUOTA_EXCEEDED). */
const THROTTLE_REASON = {
  [Admit.Client]: "429 too many requests (usage plan rate)",
  [Admit.Quota]: "429 limit exceeded (usage plan quota)",
  [Admit.Stage]: "429 too many requests (stage or method limit)",
  [Admit.Account]: "429 too many requests (account limit)"
} as const

/** One request inside the gateway. It lives from the moment it is admitted until it is answered or abandoned. */
class Request {
  open = true
  /** The one timer the request has running at any time: its overhead, an authorizer check, the timeout, a cache hit. */
  timer: TimerHandle | undefined
  /** Abandons whatever the gateway is waiting on downstream (the authorizer or the integration). */
  cancelDown: Cancel = noCancel
  /** When the downstream call (authorizer or integration) began, for IntegrationLatency. */
  startedAt = 0
  /** The cache entry to fill when the integration answers, or -1 when this response is not cached. */
  cacheEntry = -1
  identity = 0
  constructor(
    readonly message: Message,
    readonly c: Settings,
    readonly plan: Plan,
    readonly resume: (effect: Effect.Effect<void, CallFailure>) => void
  ) {}
}

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
  // The default port comes first: edges drawn without naming a port go to the integration. The authorizer port takes the
  // Lambda function that authorizes requests, so its cold starts and concurrency are the real thing.
  ports: { out: Component.port.many("Integration"), authorizer: Component.port.one("Lambda authorizer") },
  state: Schema.Struct({
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
  }),
  make: (node) =>
    Effect.sync(() => {
      const { fast, meter } = node
      const out = node.out("out")
      const authorizerLinks = node.out("authorizer")
      const region = node.placement.region
      const throttle = makeThrottle({ id: node.id, limiter: node.limiter, now: fast.now, accountKey: `${keyOf(node.placement)}/apigateway` })
      const authorizerCache = makeAuthorizerCache()
      const responseCache = makeResponseCache()
      let inflight = 0
      /** When a JWT authorizer last fetched the issuer's public keys; -Infinity until the first request. */
      let jwksFetchedAt = Number.NEGATIVE_INFINITY
      const totals = {
        served: 0, throttled: 0, quotaExceeded: 0, timeouts: 0, tooLarge: 0, integrationErrors: 0,
        authorizerInvocations: 0, authorizerDenied: 0, authorizerFailures: 0, cacheHits: 0, cacheMisses: 0
      }

      // CloudWatch's names where there is one: Count is `in`, 4XXError and 5XXError are `status.4xx` and `status.5xx`,
      // Latency is `latency`, IntegrationLatency is `integrationLatency`, CacheHitCount and CacheMissCount are `cache.hit` and `cache.miss`.
      const status4xx = meter.counter("status.4xx")
      const status5xx = meter.counter("status.5xx")
      const cacheHit = meter.counter("cache.hit")
      const cacheMiss = meter.counter("cache.miss")
      const throttledBy = {
        [Admit.Client]: meter.counter("throttled.usagePlan"),
        [Admit.Quota]: meter.counter("throttled.quota"),
        [Admit.Stage]: meter.counter("throttled.stage"),
        [Admit.Account]: meter.counter("throttled.account")
      }
      const authInvocations = meter.counter("auth.invocations")
      const authCacheHits = meter.counter("auth.cacheHit")
      const authDenied = meter.counter("auth.denied")
      const authFailed = meter.counter("auth.failed")
      const integrationLatency = meter.sampler("integrationLatency")
      const authLatency = meter.sampler("authLatency")
      // DataProcessed (HTTP APIs): the bytes of the requests the gateway admitted.
      const dataProcessed = meter.counter("dataProcessed")

      // What the settings and quotas mean is worked out again only when either is replaced.
      let planFrom: Settings | undefined
      let planAccount: Aws.Account | undefined
      let planMemo: Plan
      let cacheSize: string | undefined
      const planOf = (c: Settings): Plan => {
        const account = fast.account() as Aws.Account
        if (c !== planFrom || account !== planAccount) {
          planFrom = c
          planAccount = account
          planMemo = derive(c, account, region)
          // API Gateway replaces the cache instance to change its size, which throws everything away.
          if (planMemo.cache?.sizeGb !== cacheSize) {
            cacheSize = planMemo.cache?.sizeGb
            responseCache.flush()
          }
        }
        return planMemo
      }
      meter.gaugeUnsafe("inflight", () => inflight)
      meter.gaugeUnsafe("accountTokens", () => throttle.accountLevel(planOf(fast.settings())))
      meter.gaugeUnsafe("accountBurst", () => planOf(fast.settings()).account.burst)
      meter.gaugeUnsafe("cacheEntries", () => responseCache.size())

      // ---- One request, as a state machine -------------------------------------------------------------------------
      // overhead -> authorize -> cache lookup -> integration. Each wait is one timer or one downstream call, so a request
      // costs a few timers and no fibers of its own. Like most gateways it gives up on a slow backend without telling it:
      // a timeout leaves the integration's work running.

      const answer = (r: Request, failure: CallFailure | undefined): void => {
        if (!r.open) return
        r.open = false
        r.timer?.cancel()
        r.timer = undefined
        inflight--
        if (failure === undefined) {
          totals.served++
          return r.resume(Effect.void)
        }
        // The CloudWatch split: a refused or throttled request is the client's (4XXError), anything else is the server's (5XXError).
        if (failure._tag === "Throttled" || failure._tag === "Rejected") status4xx.n++
        else status5xx.n++
        r.resume(Effect.fail(failure))
      }

      /** The caller gave up (an edge cancelled the call): give back everything the request holds. */
      const abandon = (r: Request): void => {
        if (!r.open) return
        r.open = false
        r.timer?.cancel()
        r.timer = undefined
        r.cancelDown()
        r.cancelDown = noCancel
        inflight--
      }

      // -- The integration --
      const onIntegrationDone = (r: Request, failure: CallFailure | undefined): void => {
        if (!r.open) return
        r.timer?.cancel()
        r.timer = undefined
        r.cancelDown = noCancel
        integrationLatency.add(fast.now() - r.startedAt)
        if (failure === undefined) {
          const cache = r.plan.cache
          if (r.cacheEntry >= 0 && cache !== undefined) responseCache.put(r.cacheEntry, fast.now() + cache.ttlMs, cache.capacity)
          return answer(r, undefined)
        }
        // The gateway answers for its backend. A timeout from the backend's own edge is the same 504 the gateway gives, a refused
        // request stays a 4xx, a backend that is down is a 503 (the integration was not available), and anything else the
        // backend did wrong is a 502 (the gateway could not make a valid response of it).
        if (failure._tag === "Timeout") totals.timeouts++
        else totals.integrationErrors++
        switch (failure._tag) {
          case "Timeout":
          case "Rejected":
            return answer(r, failure)
          case "Unavailable":
            return answer(r, Unavailable({ node: node.id, reason: "503 integration unavailable" }))
          default:
            return answer(r, Failed({ node: node.id, reason: `502 integration failed (${failure._tag})` }))
        }
      }
      const onIntegrationTimeout = (r: Request): void => {
        r.timer = undefined
        // Stop waiting, and stop the edge retrying, but let the work already sent carry on (unless the edge cancels on timeout).
        r.cancelDown()
        r.cancelDown = noCancel
        totals.timeouts++
        answer(r, Timeout({ edge: node.id, after: r.plan.integrationTimeoutMs }))
      }
      const integrate = (r: Request): void => {
        if (r.c.integrationType === "mock") return answer(r, undefined)
        const link = Edge.pickUnsafe(out, fast.random)
        // An integration that was never configured is the API's mistake, which API Gateway reports as a 500.
        if (link === undefined) return answer(r, Failed({ node: node.id, reason: "500 no integration configured" }))
        r.startedAt = fast.now()
        r.timer = fast.after(r.plan.integrationTimeoutMs, onIntegrationTimeout, r)
        r.cancelDown = link.send(r.message, (failure) => onIntegrationDone(r, failure))
      }

      // -- The cache --
      const onCacheHit = (r: Request): void => {
        r.timer = undefined
        answer(r, undefined)
      }
      const lookup = (r: Request): void => {
        const cache = r.plan.cache
        // Only GET is cached unless the stage says otherwise; HTTP APIs have no cache.
        if (cache === undefined || !(cache.allMethods || r.message.operation === "read")) return integrate(r)
        let bypass = false
        if (cache.invalidate > 0 && fast.random.nextDoubleUnsafe() < cache.invalidate) {
          // Cache-Control: max-age=0. Without an InvalidateCache policy anyone may; with one, the unauthorised are refused or ignored.
          if (cache.invalidation === "forbidden") return answer(r, Rejected({ node: node.id, reason: "403 cache invalidation not authorised" }))
          bypass = cache.invalidation === "allowed"
        }
        const entry = cacheKeyOf(r.message.key, cache.keys)
        if (!bypass && responseCache.has(entry, fast.now())) {
          totals.cacheHits++
          cacheHit.n++
          r.timer = fast.after(Distribution.latencyMs(r.c.cache.hitLatency, fast.random), onCacheHit, r)
          return
        }
        totals.cacheMisses++
        cacheMiss.n++
        r.cacheEntry = entry
        integrate(r)
      }

      // -- The authorizer --
      const decide = (r: Request, verdict: Verdict): void => {
        if (verdict !== Verdict.Deny) return lookup(r)
        totals.authorizerDenied++
        authDenied.n++
        answer(r, Rejected({ node: node.id, reason: "403 access denied by authorizer" }))
      }
      /** The authorizer has answered for this caller: remember it (Lambda authorizers cache) and act on it. */
      const authorized = (r: Request): void => {
        const a = r.plan.authorizer!
        const verdict = isDenied(r.identity, a.deny) ? Verdict.Deny : Verdict.Allow
        if (a.ttlMs > 0) authorizerCache.store(r.identity, verdict, fast.now() + a.ttlMs, a.identities)
        decide(r, verdict)
      }
      const onAuthorizerDone = (r: Request, failure: CallFailure | undefined): void => {
        if (!r.open) return
        r.timer?.cancel()
        r.timer = undefined
        r.cancelDown = noCancel
        authLatency.add(fast.now() - r.startedAt)
        if (failure === undefined) return authorized(r)
        // A function that cannot be reached, throws or is throttled leaves the gateway with no policy: AUTHORIZER_FAILURE or
        // AUTHORIZER_CONFIGURATION_ERROR, both 500, and nothing is cached.
        totals.authorizerFailures++
        authFailed.n++
        answer(r, Failed({ node: node.id, reason: `500 authorizer failed (${failure._tag})` }))
      }
      const onAuthorizerTimeout = (r: Request): void => {
        r.timer = undefined
        r.cancelDown()
        r.cancelDown = noCancel
        totals.authorizerFailures++
        authFailed.n++
        answer(r, Failed({ node: node.id, reason: "500 authorizer timed out" }))
      }
      const onAuthorizerChecked = (r: Request): void => {
        r.timer = undefined
        authLatency.add(fast.now() - r.startedAt)
        authorized(r)
      }
      const authorize = (r: Request): void => {
        const a = r.plan.authorizer
        if (a === undefined) return lookup(r)
        r.identity = identityOf(r.message.key, a.identities)
        const now = fast.now()
        if (a.ttlMs > 0) {
          const cached = authorizerCache.lookup(r.identity, now, a.identities)
          if (cached !== Verdict.Unknown) {
            authCacheHits.n++
            return decide(r, cached)
          }
        }
        r.startedAt = now
        if (a.kind === "lambda") {
          totals.authorizerInvocations++
          authInvocations.n++
          const link = authorizerLinks[0]
          if (link !== undefined) {
            r.timer = fast.after(AUTHORIZER_TIMEOUT_MS, onAuthorizerTimeout, r)
            r.cancelDown = link.send(
              { ...r.message, invocation: "sync", bytes: AUTHORIZER_EVENT_BYTES, count: 1 },
              (failure) => onAuthorizerDone(r, failure)
            )
            return
          }
        }
        let checkMs = Distribution.latencyMs(r.c.authorizer.latency, fast.random)
        // A JWT authorizer verifies against the issuer's public keys, which it caches for up to two hours; the request that
        // finds them stale pays for fetching them.
        if (a.kind === "jwt" && now - jwksFetchedAt >= JWKS_CACHE_MS) {
          jwksFetchedAt = now
          checkMs += JWKS_FETCH_MS
        }
        r.timer = fast.after(checkMs, onAuthorizerChecked, r)
      }

      const onOverhead = (r: Request): void => {
        r.timer = undefined
        authorize(r)
      }

      return {
        call: (message) => {
          const c = fast.settings()
          if (message.bytes > MAX_PAYLOAD) {
            totals.tooLarge++
            status4xx.n++
            return Effect.fail(Rejected({ node: node.id, reason: "413 request too large" }))
          }
          const plan = planOf(c)
          const admission = throttle.admit(plan, message.key)
          if (admission !== Admit.Admitted) {
            totals.throttled++
            if (admission === Admit.Quota) totals.quotaExceeded++
            throttledBy[admission].n++
            status4xx.n++
            return Effect.fail(Throttled({ node: node.id, reason: THROTTLE_REASON[admission] }))
          }
          inflight++
          dataProcessed.n += message.bytes
          const overhead = Distribution.latencyMs(c.overhead, fast.random)
          return Effect.callback<void, CallFailure>((resume) => {
            const r = new Request(message, c, plan, resume)
            r.timer = fast.after(overhead, onOverhead, r)
            return Effect.sync(() => abandon(r))
          })
        },
        probe: Effect.sync(() => {
          const plan = planOf(fast.settings())
          return {
            accountTokens: throttle.accountLevel(plan),
            stageTokens: throttle.stageLevel(plan),
            ...totals,
            cacheEntries: responseCache.size()
          }
        })
      }
    })
})
