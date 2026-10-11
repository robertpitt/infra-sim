import { Duration } from "effect"
import { COMPRESS_MAX_BYTES, COMPRESS_MIN_BYTES, type Config, FAR_VIEWER_SHARE } from "./config.ts"

/** Which kind of code runs at an edge-function hook. */
export const NONE = 0
export const CLOUDFRONT_FUNCTION = 1
export const LAMBDA_AT_EDGE = 2
const KINDS = { none: NONE, function: CLOUDFRONT_FUNCTION, lambda: LAMBDA_AT_EDGE } as const

/**
 * Everything a request needs that depends only on the settings: worked out once per edit of them, not once per
 * request. The settings object is replaced whole on every edit, so its identity is the cache key.
 */
export interface Derived {
  readonly objects: number
  readonly skew: number
  readonly readOnly: boolean
  /** How long an object is cached, from the TTL settings and what the origin says. 0 means it is not cached. */
  readonly ttlMs: number
  readonly errorTtlMs: number
  readonly staleWhileRevalidateMs: number
  readonly staleIfErrorMs: number
  /** What the origin sends for one object, and what the viewer downloads after compression (the expected value). */
  readonly rawBytes: number
  readonly responseBytes: number
  readonly edgeLocations: number
  readonly edgeCapacity: number
  readonly regional: boolean
  readonly regionalLocations: number
  readonly regionalCapacity: number
  readonly shieldCapacity: number
  readonly farShare: number
  readonly viewerRequest: number
  readonly viewerResponse: number
  readonly originRequest: number
  readonly originResponse: number
  readonly lambdaTimeoutMs: number
  readonly failClient: boolean
  readonly fail500: boolean
  readonly fail502: boolean
  readonly fail503: boolean
  readonly fail504: boolean
}

/**
 * The lifetime CloudFront gives an object: the table in the "Expiration" page. A max-age is clamped between the
 * minimum and maximum TTL; no header means the default TTL (or the minimum, if that is higher); no-store means do not
 * cache unless the minimum TTL is above 0, which overrides it.
 */
export const ttlOf = (c: Config["cache"]): number => {
  const min = Duration.toMillis(c.minTtl)
  switch (c.originCacheControl) {
    case "none":
      return min > 0 ? Math.max(min, Duration.toMillis(c.defaultTtl)) : Duration.toMillis(c.defaultTtl)
    case "max-age":
      return Math.max(min, Math.min(Duration.toMillis(c.originMaxAge), Duration.toMillis(c.maxTtl)))
    case "no-store":
      return min
  }
}

export const derive = (c: Config): Derived => {
  const rawBytes = Math.round(c.objectSize * 1024)
  // Compression applies to objects in the documented size range, and only to the compressible share of the bytes.
  const compressed = c.compression.enabled && rawBytes >= COMPRESS_MIN_BYTES && rawBytes <= COMPRESS_MAX_BYTES
  return {
    objects: c.objects,
    skew: c.popularitySkew,
    readOnly: c.allowedMethods === "read",
    ttlMs: ttlOf(c.cache),
    errorTtlMs: Duration.toMillis(c.cache.errorMinTtl),
    staleWhileRevalidateMs: Duration.toMillis(c.cache.staleWhileRevalidate),
    staleIfErrorMs: Duration.toMillis(c.cache.staleIfError),
    rawBytes,
    responseBytes: compressed ? rawBytes * (1 - c.compression.compressibleShare * (1 - c.compression.ratio)) : rawBytes,
    edgeLocations: c.edge.locations,
    edgeCapacity: c.edge.capacity,
    regional: c.regionalEdgeCache.enabled,
    regionalLocations: c.regionalEdgeCache.locations,
    regionalCapacity: c.regionalEdgeCache.capacity,
    shieldCapacity: c.originShield.capacity,
    farShare: FAR_VIEWER_SHARE[c.edge.priceClass],
    viewerRequest: KINDS[c.functions.viewerRequest],
    viewerResponse: KINDS[c.functions.viewerResponse],
    originRequest: KINDS[c.functions.originRequest],
    originResponse: KINDS[c.functions.originResponse],
    lambdaTimeoutMs: Duration.toMillis(c.functions.lambdaTimeout),
    failClient: c.failover.clientErrors,
    fail500: c.failover.status500,
    fail502: c.failover.status502,
    fail503: c.failover.status503,
    fail504: c.failover.status504
  }
}
