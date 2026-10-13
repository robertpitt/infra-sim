import { Duration } from "effect"
import type { Bucket } from "../../../Limiter.ts"
import type { Account } from "../../internal/account.ts"
import {
  HTTP_INTEGRATION_TIMEOUT_MS,
  MAX_CACHED_RESPONSE_BYTES,
  REST_INTEGRATION_TIMEOUT_MS,
  type Settings
} from "./config.ts"
import { apiGatewayBurst } from "../Quotas.ts"

const PERIOD_MS = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  // AWS resets on the calendar month; a fixed 30 days keeps the window a plain number of milliseconds.
  month: 30 * 24 * 60 * 60 * 1000
} as const

/**
 * What the settings and the account's quotas mean for one request, worked out once and reused until either is replaced.
 * The hot path reads these plain fields instead of re-deriving them per call.
 */
export interface Plan {
  readonly rest: boolean
  /** The integration timeout in force: the setting, held to what the API type and endpoint allow. */
  readonly integrationTimeoutMs: number
  /** The account's bucket, shared by every API in the region. */
  readonly account: Bucket
  /** The per-route stage bucket, or undefined when the stage has no limit. */
  readonly stage: Bucket | undefined
  readonly routes: number
  readonly usagePlan: {
    readonly clients: number
    readonly bucket: Bucket | undefined
    readonly quota: number
    readonly periodMs: number
  } | undefined
  readonly authorizer: {
    readonly kind: Settings["authorizer"]["type"]
    /** 0 when results are not cached (and always 0 for anything but a Lambda authorizer). */
    readonly ttlMs: number
    readonly identities: number
    readonly deny: number
  } | undefined
  readonly cache: {
    readonly ttlMs: number
    readonly keys: number
    /** Entries that fit: what the cluster holds at this response size, or the key count if that is smaller. */
    readonly capacity: number
    readonly sizeGb: string
    readonly allMethods: boolean
    readonly invalidate: number
    readonly invalidation: Settings["cache"]["invalidation"]
  } | undefined
}

/** The integration timeout API Gateway will honour for this API, in ms. */
export const timeoutCapMs = (c: Settings, account: Account): number => {
  if (c.apiType === "http") return HTTP_INTEGRATION_TIMEOUT_MS
  // Only Regional and private REST APIs can raise the timeout, by raising the account quota.
  if (c.endpoint === "edge") return REST_INTEGRATION_TIMEOUT_MS
  return Math.max(REST_INTEGRATION_TIMEOUT_MS, Duration.toMillis(account.apiGatewayIntegrationTimeout))
}

export const derive = (c: Settings, account: Account, region: string): Plan => {
  const rest = c.apiType === "rest"
  const stageRate = c.stageThrottle.rate
  const planRate = c.usagePlan.rate
  const usagePlan = rest && c.usagePlan.enabled
    ? {
      clients: c.usagePlan.clients,
      bucket: planRate > 0 ? { rate: planRate, burst: c.usagePlan.burst > 0 ? c.usagePlan.burst : planRate } : undefined,
      quota: c.usagePlan.quota,
      periodMs: PERIOD_MS[c.usagePlan.period]
    }
    : undefined
  const lambda = c.authorizer.type === "lambda"
  const authorizer = c.authorizer.type === "none"
    ? undefined
    : {
      kind: c.authorizer.type,
      ttlMs: lambda ? Duration.toMillis(c.authorizer.ttl) : 0,
      identities: c.authorizer.identities,
      deny: c.authorizer.deny
    }
  const cacheTtlMs = Duration.toMillis(c.cache.ttl)
  const responseBytes = c.cache.responseSize * 1024
  const cache = rest && c.cache.enabled && cacheTtlMs > 0 && responseBytes <= MAX_CACHED_RESPONSE_BYTES
    ? {
      ttlMs: cacheTtlMs,
      keys: c.cache.keys,
      capacity: Math.max(1, Math.min(c.cache.keys, Math.floor((Number(c.cache.size) * 1e9) / responseBytes))),
      sizeGb: c.cache.size,
      allMethods: c.cache.scope === "all",
      invalidate: c.cache.invalidate,
      invalidation: c.cache.invalidation
    }
    : undefined
  return {
    rest,
    integrationTimeoutMs: Math.min(Duration.toMillis(c.integrationTimeout), timeoutCapMs(c, account)),
    account: { rate: account.apiGatewayRate, burst: apiGatewayBurst(region) },
    stage: stageRate > 0 ? { rate: stageRate, burst: c.stageThrottle.burst > 0 ? c.stageThrottle.burst : stageRate } : undefined,
    routes: c.routes,
    usagePlan,
    authorizer,
    cache
  }
}
