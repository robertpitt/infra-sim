import { Effect } from "effect"
import * as Aws from "../provider.ts"
import { COMPRESSION_URL, Config, DOCS, EXPIRATION_URL, FAILOVER_URL, ORIGIN_URL, PRICE_CLASS_URL, QUOTAS_URL, ports, State } from "./config.ts"
import { dashboard } from "./dashboard.ts"
import { makeRuntime } from "./runtime.ts"

/**
 * Amazon CloudFront: a content delivery network. One distribution, with its default cache behaviour, its edge
 * locations' caches, the optional regional edge cache and Origin Shield tiers, and the origins on its `out` port.
 * The hit ratio is not a setting: it emerges from how many objects there are, how long they are cached and how the
 * traffic spreads over them. See `README.md`.
 */
export const CloudFront = Aws.component({
  type: "aws.cloudfront",
  service: "CloudFront",
  title: "CloudFront distribution",
  description:
    "Content delivery network. Caches objects at edge locations with a TTL, collapses simultaneous misses, adds regional cache and Origin Shield tiers, fails over between origins, and turns origin failures into 502, 503 and 504.",
  docs: DOCS,
  category: "network",
  // Served from edge locations everywhere: losing a region takes its origins down, not the distribution.
  global: true,
  icon: "cdn",
  accent: "#8c4fff",
  limits: [
    { label: "Requests per second per distribution", value: "250,000", adjustable: true, source: QUOTAS_URL, note: "An account quota here; over it the model answers 503 (AWS documents no response)." },
    { label: "Data transfer rate per distribution", value: "150 Gbps", adjustable: true, source: QUOTAS_URL },
    { label: "Maximum cacheable file size", value: "50 GB per GET response", adjustable: false, source: `${DOCS}RequestAndResponseBehaviorCustomOrigin.html` },
    { label: "Maximum HTTP request body", value: "64 GB", adjustable: false, source: QUOTAS_URL },
    { label: "Request or origin response headers", value: "32,768 bytes; URL 8,192 bytes", adjustable: false, source: QUOTAS_URL, note: "Not modelled: requests carry no URL or headers." },
    { label: "Origin connection attempts", value: "1 to 3", adjustable: false, source: ORIGIN_URL },
    { label: "Origin response timeout", value: "1 to 120 seconds (default 30)", adjustable: true, source: ORIGIN_URL },
    { label: "Compression", value: "gzip or Brotli, objects of 1,000 to 10,000,000 bytes of compressible types", adjustable: false, source: COMPRESSION_URL },
    { label: "Error caching minimum TTL", value: "10 seconds by default; 404, 414, 500, 501, 502, 503, 504 are cached", adjustable: false, source: `${DOCS}HTTPStatusCodes.html` },
    { label: "Origin group failover", value: "400, 403, 404, 416, 429, 500, 502, 503, 504; GET, HEAD and OPTIONS only", adjustable: false, source: FAILOVER_URL },
    { label: "Lambda@Edge", value: "30 s timeout; 10,000 requests per second per Region", adjustable: true, source: QUOTAS_URL },
    { label: "CloudFront Functions", value: "sub-millisecond; 10 KB code, 2 MB memory", adjustable: false, source: `${DOCS}edge-functions-choosing.html` },
    { label: "Invalidation", value: "150 paths per second, 1 wildcard per second; first 1,000 paths a month free", adjustable: false, source: `${DOCS}PayingForInvalidation.html`, note: "Scheduled invalidations are one wildcard path each." },
    { label: "Price classes", value: "All, 200 (no South America, Australia/NZ), 100 (US, Mexico, Canada, Europe, Israel, Türkiye)", adjustable: false, source: PRICE_CLASS_URL },
    { label: "Object lifetime", value: "min, default and max TTL; stale-while-revalidate and stale-if-error", adjustable: false, source: EXPIRATION_URL }
  ],
  dashboard,
  highlights: [
    { gauge: "cacheHitRate", label: "cache hit rate", format: "percent" },
    { rate: "originRequests", label: "origin req/s" },
    { rate: "err5xx", label: "5xx/s" }
  ],
  config: Config,
  ports,
  state: State,
  make: (node) => Effect.sync(() => makeRuntime(node))
})
