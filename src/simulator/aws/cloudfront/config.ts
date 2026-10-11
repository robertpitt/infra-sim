import { Schema } from "effect"
import * as Component from "../../Component.ts"
import * as Setting from "../../Setting.ts"

/** Where AWS documents CloudFront. Every limit below links to a page under here. */
export const DOCS = "https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/"
export const QUOTAS_URL = `${DOCS}cloudfront-limits.html`
const ORIGIN_URL = `${DOCS}DownloadDistValuesOrigin.html`
const EXPIRATION_URL = `${DOCS}Expiration.html`
const ERRORS_URL = `${DOCS}HTTPStatusCodes.html`
const FAILOVER_URL = `${DOCS}high_availability_origin_failover.html`
const COMPRESSION_URL = `${DOCS}ServingCompressedFiles.html`
const PRICE_CLASS_URL = "https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/"

const SECOND = 1000
const DAY = 24 * 3600 * SECOND
/** Cache-Control max-age can be up to 100 years (the documented ceiling for the header). */
const HUNDRED_YEARS = 100 * 365 * DAY

/** The largest response body CloudFront saves in its cache, in KB (50 GB). Bigger ones need range requests. */
export const MAX_CACHEABLE_KB = 50 * 1024 * 1024
/** The largest HTTP request body (64 GB). */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024 ** 3
/** Whether a request body is over the limit (a 413). A function so the 64 GB edge, which no stock client can send, is testable. */
export const bodyTooLarge = (bytes: number): boolean => bytes > MAX_REQUEST_BODY_BYTES
/** CloudFront compresses only objects between 1,000 and 10,000,000 bytes. */
export const COMPRESS_MIN_BYTES = 1_000
export const COMPRESS_MAX_BYTES = 10_000_000
/** Lambda@Edge's function timeout, for every event type. */
export const LAMBDA_EDGE_MAX_TIMEOUT_MS = 30 * SECOND

/**
 * The share of viewers a price class does not cover, who are therefore served from a farther edge location. AWS says
 * those viewers "may encounter slower performance" and publishes no number, so these are assumptions.
 */
export const FAR_VIEWER_SHARE = { all: 0, "200": 0.1, "100": 0.25 } as const

/**
 * Settings of the distribution (its single default cache behaviour). See `README.md` for the source of every number.
 */
export const Config = Schema.Struct({
  objects: Setting.int({
    default: 10_000,
    min: 1,
    max: 100_000_000,
    label: "Distinct objects",
    help: "How many different objects (cache keys) the distribution serves. Requests pick one by their key, so a few objects means a high hit ratio and many objects a low one. A modelling choice."
  }),
  popularitySkew: Setting.number({
    default: 1,
    min: 1,
    max: 10,
    step: 0.1,
    label: "Popularity skew",
    help: "1 spreads requests evenly over the objects. Higher values concentrate them on the first few (a long tail), as real traffic does: object i of N is asked for with probability proportional to its share of the key space raised to 1/skew."
  }),
  objectSize: Setting.number({
    default: 100,
    min: 0,
    max: MAX_CACHEABLE_KB,
    step: 1,
    unit: "KB",
    label: "Object size",
    help: "Average response size. The bytes viewers download, what the origin sends on a miss, and what compression shrinks.",
    limit: Setting.hard(`${DOCS}RequestAndResponseBehaviorCustomOrigin.html`, "CloudFront saves at most 50 GB of a GET response in its cache.")
  }),
  allowedMethods: Setting.choice(["read", "all"], {
    default: "all",
    labels: { read: "GET, HEAD", all: "GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE" },
    help: "Which HTTP methods the behaviour accepts. A call whose operation is write is a PUT/POST/PATCH/DELETE: it is never cached and goes straight to the origin. When only GET and HEAD are allowed, CloudFront answers a write with 403."
  }),
  cache: Setting.group(
    {
      defaultTtl: Setting.duration({
        default: "1 day",
        min: 0,
        max: HUNDRED_YEARS,
        label: "Default TTL",
        help: "How long an object stays cached when the origin sends no Cache-Control or Expires header. AWS's default is 86,400 s."
      }),
      minTtl: Setting.duration({
        default: 0,
        min: 0,
        max: HUNDRED_YEARS,
        label: "Minimum TTL",
        help: "Objects stay cached at least this long, even when the origin says no-store or a shorter max-age."
      }),
      maxTtl: Setting.duration({
        default: "365 days",
        min: 0,
        max: HUNDRED_YEARS,
        label: "Maximum TTL",
        help: "Caps a max-age or s-maxage the origin sends. AWS's default is 31,536,000 s (one year)."
      }),
      originCacheControl: Setting.choice(["none", "max-age", "no-store"], {
        default: "none",
        labels: { none: "No Cache-Control (use the default TTL)", "max-age": "Cache-Control: max-age", "no-store": "Cache-Control: no-store" },
        help: "What the origin tells CloudFront about every object. Together with the TTLs above it fixes how long an object is cached (see the table in the README)."
      }),
      originMaxAge: Setting.duration({
        default: "1 hour",
        min: 0,
        max: HUNDRED_YEARS,
        label: "Origin max-age",
        help: "The max-age the origin sends when it sends one. An assumption: it depends on your application."
      }),
      errorMinTtl: Setting.duration({
        default: "10 seconds",
        min: 0,
        max: 365 * DAY,
        label: "Error caching minimum TTL",
        help: "How long CloudFront caches a 404, 414, 500, 501, 502, 503 or 504 from the origin before asking again. AWS's default is 10 s; the upper bound here is an assumption."
      }),
      staleWhileRevalidate: Setting.duration({
        default: 0,
        min: 0,
        max: 365 * DAY,
        label: "stale-while-revalidate",
        help: "When the origin sends stale-while-revalidate, an expired object is served for this long while one request refreshes it. 0 for none."
      }),
      staleIfError: Setting.duration({
        default: 0,
        min: 0,
        max: 365 * DAY,
        label: "stale-if-error",
        help: "When the origin sends stale-if-error, an expired object is served for this long past its expiry if the origin is failing. 0 for none (CloudFront still serves a stale object for the error caching TTL when the origin returns a 5xx)."
      })
    },
    { label: "Caching" }
  ),
  edge: Setting.group(
    {
      locations: Setting.int({
        default: 1,
        min: 1,
        max: 1_000,
        label: "Edge locations hit",
        help: "How many edge locations (POPs) the viewers spread over. Each has its own cache, so more locations means more cold caches and a lower hit ratio at the edge. The more viewers are spread around the world, the more of these."
      }),
      capacity: Setting.int({
        default: 50_000,
        min: 1,
        max: 1_000_000,
        unit: "objects",
        label: "Edge cache capacity",
        help: "Objects one edge location keeps before it evicts the least recently requested. AWS does not publish cache sizes, so this is an assumption."
      }),
      latency: Setting.latency({
        mean: "3 millis",
        cv: 0.5,
        label: "Edge processing time",
        help: "What the edge location itself adds to every request (TLS, cache lookup, headers). The viewer's network distance is the latency of the edge from the client. AWS publishes no figure, so this is an assumption."
      }),
      priceClass: Setting.choice(["all", "200", "100"], {
        default: "all",
        labels: { all: "Price Class All", "200": "Price Class 200", "100": "Price Class 100" },
        help: "Which edge locations may serve the distribution. Viewers near regions a class leaves out are served from a farther edge location and are slower. How many viewers that is, is an assumption (0%, 10%, 25%)."
      }),
      farLatency: Setting.latency({
        mean: "80 millis",
        cv: 0.3,
        label: "Extra latency from a farther edge",
        help: "What a viewer outside the price class's regions pays on top of the normal latency. An assumption: about one more intercontinental round trip."
      })
    },
    { label: "Edge locations" }
  ),
  regionalEdgeCache: Setting.group(
    {
      enabled: Setting.bool({
        default: true,
        label: "Regional edge cache",
        help: "The larger middle tier between edge locations and the origin. CloudFront uses it automatically for cacheable GET and HEAD requests; proxied methods skip it."
      }),
      locations: Setting.int({
        default: 1,
        min: 1,
        max: 100,
        label: "Regional edge caches hit",
        help: "How many regional caches the edge locations are spread over. Edge location i uses cache i mod this. AWS does not publish the mapping, so it is a modelling choice."
      }),
      capacity: Setting.int({
        default: 500_000,
        min: 1,
        max: 10_000_000,
        unit: "objects",
        label: "Regional cache capacity",
        help: "AWS says it is larger than an edge location's cache and publishes no figure: an assumption."
      }),
      hop: Setting.latency({
        mean: "10 millis",
        cv: 0.3,
        label: "Edge to regional cache latency",
        help: "One way. An assumption: both are close to the viewers."
      })
    },
    { label: "Regional edge cache" }
  ),
  originShield: Setting.group(
    {
      capacity: Setting.int({
        default: 5_000_000,
        min: 1,
        max: 20_000_000,
        unit: "objects",
        label: "Origin Shield capacity",
        help: "Objects each Origin Shield keeps. AWS does not publish it: an assumption. Turn Origin Shield on per origin, on its edge."
      }),
      hop: Setting.latency({
        mean: "15 millis",
        cv: 0.3,
        label: "Regional cache to Origin Shield latency",
        help: "One way. The shield sits in the region with the lowest latency to the origin, so it is typically farther from the viewers. An assumption."
      })
    },
    { label: "Origin Shield" }
  ),
  compression: Setting.group(
    {
      enabled: Setting.bool({
        default: true,
        label: "Compress objects automatically",
        help: "Gzip or Brotli for objects between 1,000 and 10,000,000 bytes of a compressible type, so fewer bytes reach the viewer. Viewers must send Accept-Encoding; the model assumes they do."
      }),
      ratio: Setting.ratio({
        default: 0.35,
        label: "Compressed size",
        help: "What a compressible object shrinks to, as a share of its size. AWS says 'less than a quarter' in some cases; the default is an assumption for text."
      }),
      compressibleShare: Setting.ratio({
        default: 0.6,
        label: "Compressible share",
        help: "The share of the response bytes that are of a type CloudFront compresses (HTML, JS, CSS, JSON... but not JPEG or video). An assumption; the model uses the expected value."
      })
    },
    { label: "Compression" }
  ),
  failover: Setting.group(
    {
      clientErrors: Setting.bool({ default: false, label: "On 4xx (400, 403, 404, 416, 429)", help: "Origin group failover criteria. Used when an origin is set to be the secondary." }),
      status500: Setting.bool({ default: true, label: "On 500" }),
      status502: Setting.bool({ default: true, label: "On 502" }),
      status503: Setting.bool({
        default: true,
        label: "On 503 (and when CloudFront cannot connect)",
        help: "AWS fails over on a failed connection only when 503 is selected."
      }),
      status504: Setting.bool({ default: true, label: "On 504 (and origin timeouts)", help: "AWS fails over on an origin timeout only when 504 is selected." })
    },
    { label: "Origin group failover" }
  ),
  functions: Setting.group(
    {
      viewerRequest: Setting.choice(["none", "function", "lambda"], {
        default: "none",
        labels: { none: "None", function: "CloudFront Function", lambda: "Lambda@Edge" },
        help: "Code that runs on every request before the cache lookup."
      }),
      viewerResponse: Setting.choice(["none", "function", "lambda"], {
        default: "none",
        labels: { none: "None", function: "CloudFront Function", lambda: "Lambda@Edge" },
        help: "Code that runs on every response before it goes to the viewer."
      }),
      originRequest: Setting.choice(["none", "lambda"], {
        default: "none",
        labels: { none: "None", lambda: "Lambda@Edge" },
        help: "Lambda@Edge that runs only on a cache miss, before the request goes to the origin."
      }),
      originResponse: Setting.choice(["none", "lambda"], {
        default: "none",
        labels: { none: "None", lambda: "Lambda@Edge" },
        help: "Lambda@Edge that runs only on a cache miss, when the origin has answered."
      }),
      cloudFrontFunction: Setting.latency({
        mean: "0.3 millis",
        cv: 0.5,
        label: "CloudFront Function time",
        help: "AWS says CloudFront Functions run in under a millisecond; the distribution is an assumption."
      }),
      lambdaAtEdge: Setting.latency({
        mean: "40 millis",
        cv: 1,
        label: "Lambda@Edge time",
        help: "Includes the occasional cold start. AWS publishes no figure for how long Lambda@Edge takes, so this is an assumption."
      }),
      lambdaTimeout: Setting.duration({
        default: "5 seconds",
        min: "1 millis",
        max: LAMBDA_EDGE_MAX_TIMEOUT_MS,
        label: "Lambda@Edge timeout",
        help: "A function that runs longer fails and the viewer gets a 503.",
        limit: Setting.hard(QUOTAS_URL, "30 seconds for every Lambda@Edge event type.")
      }),
      errorRate: Setting.ratio({
        default: 0,
        label: "Function error rate",
        help: "Share of executions that fail. The viewer gets a 503, which AWS documents for execution errors."
      })
    },
    { label: "Edge functions" }
  ),
  invalidation: Setting.group(
    {
      every: Setting.duration({
        default: 0,
        min: 0,
        max: 365 * DAY,
        label: "Invalidate every",
        help: "Purge the cache on a schedule, as a deploy pipeline might. 0 for never. A wildcard path counts as one invalidation path however many objects it covers."
      }),
      share: Setting.ratio({
        default: 1,
        label: "Share of objects invalidated",
        help: "1 is '/*'. Less is a set of specific paths covering that share of the objects."
      }),
      propagation: Setting.duration({
        default: "20 seconds",
        min: 0,
        max: "1 hour",
        label: "Propagation time",
        help: "How long an invalidation takes to reach every edge location and regional cache. AWS publishes no figure (it says invalidations propagate to every location), so this is an assumption."
      }),
      purgeVersion: Setting.int({
        default: 0,
        min: 0,
        max: 1_000_000_000,
        label: "Purge now",
        help: "Change this number while running to invalidate everything now. It is the button for 'create invalidation /*'."
      })
    },
    { label: "Invalidation" }
  )
})
export type Config = typeof Config.Type

/**
 * What an edge leaving the `out` port is: one origin of the distribution. The universal edge settings (latency,
 * timeout, retries, weight) apply on top; the call's operation defaults to read because a cache fills with GETs.
 */
export const Origin = Schema.Struct({
  originType: Setting.choice(["custom", "s3"], {
    default: "custom",
    labels: { custom: "Custom HTTP origin (ALB, EC2, API Gateway...)", s3: "S3 bucket" },
    help: "An S3 bucket does not offer the origin response timeout: it is not retried on a slow response. A custom origin is retried on a timeout for GET and HEAD."
  }),
  role: Setting.choice(["primary", "secondary"], {
    default: "primary",
    labels: { primary: "Primary (or an origin on its own)", secondary: "Secondary (origin group failover)" },
    help: "Primary origins split the objects by this edge's weight, like cache behaviours by path. A secondary origin is only called when a primary fails the failover criteria, and only for reads."
  }),
  shield: Setting.bool({
    default: false,
    label: "Origin Shield",
    help: "Put Origin Shield in front of this origin: one more cache layer that collapses requests from every regional cache into one."
  }),
  connectionAttempts: Setting.int({
    default: 3,
    min: 1,
    max: 3,
    label: "Connection attempts",
    help: "How many times CloudFront tries a refused connection (and, for a custom origin, an origin that does not answer) before giving up or failing over.",
    limit: Setting.hard(ORIGIN_URL, "1 to 3, default 3.")
  }),
  responseTimeout: Setting.duration({
    default: "30 seconds",
    min: "1 second",
    max: "120 seconds",
    label: "Response timeout",
    help: "How long CloudFront waits for the origin to answer before it drops the connection (a 504 once the attempts are used). Applies to custom origins.",
    limit: Setting.quota(ORIGIN_URL, "1 to 120 seconds by default (a higher value needs a quota increase); AWS's default is 30.")
  }),
  responseCompletionTimeout: Setting.duration({
    default: 0,
    min: 0,
    max: "10 minutes",
    label: "Response completion timeout",
    help: "The longest CloudFront waits for the whole origin response across every attempt. 0 for no limit. When set it must be at least the response timeout."
  }),
  timeout: Setting.duration({
    default: "10 minutes",
    min: "1 millis",
    max: "10 minutes",
    label: "Edge timeout",
    help: "The simulator's own per-call timeout on this edge. CloudFront's timeouts above do the real work, so this is long by default."
  }),
  request: Setting.group(
    {
      operation: Setting.choice(["read", "write"], {
        default: "read",
        help: "What a call to this origin does. Cache fills are GETs, so reads; set write for an origin that only takes proxied POSTs."
      }),
      payload: Setting.int({
        default: 0,
        min: 0,
        max: 1_000_000,
        unit: "KB",
        label: "Payload size",
        help: "Size of what this call carries. 0 sends the object's size on a read and the request's own size on a write."
      })
    },
    { label: "Request" }
  )
})
export type Origin = typeof Origin.Type
export { COMPRESSION_URL, ERRORS_URL, EXPIRATION_URL, FAILOVER_URL, ORIGIN_URL, PRICE_CLASS_URL }

/** What a probe reports. */
export const State = Schema.Struct({
  objects: Schema.Number,
  /** How long an object is cached right now, in seconds. */
  ttlSeconds: Schema.Number,
  /** Objects held across the edge locations, the regional caches and the Origin Shields. */
  edgeObjects: Schema.Number,
  regionalObjects: Schema.Number,
  shieldObjects: Schema.Number,
  /** Objects being fetched from upstream right now (each has any number of requests waiting). */
  fetching: Schema.Number,
  /** Requests answered from a cache over cacheable requests: everything so far, and the last ten seconds. */
  hitRatio: Schema.Number,
  recentHitRatio: Schema.Number,
  requests: Schema.Number,
  hits: Schema.Number,
  misses: Schema.Number,
  collapsed: Schema.Number,
  staleServed: Schema.Number,
  originRequests: Schema.Number,
  evictions: Schema.Number,
  errors: Schema.Struct({ client: Schema.Number, server: Schema.Number })
})

/** The distribution's one output: its origins. */
export const ports = { out: Component.port.many("Origins", Origin) }
