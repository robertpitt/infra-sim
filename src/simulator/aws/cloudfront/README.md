# CloudFront (`aws.cloudfront`)

Amazon CloudFront is a content delivery network: viewers are routed to a nearby edge location, which answers from its cache
when it can and otherwise fetches the object from an origin (S3, a load balancer, any HTTP server), optionally through a
larger regional edge cache and Origin Shield. The component is one distribution with its default cache behaviour. What it
lets you learn: the hit ratio is not a number you type. It **emerges** from how many distinct objects there are, how long
they stay cached, how popularity is spread and how big the caches are; and the cost of a miss, the protection that
request collapsing, regional caches and Origin Shield give an origin, and what a failing origin looks like to viewers
(502, 503, 504, stale objects, failover) all follow from it.

## Coverage

| Feature | Status | Notes |
| --- | --- | --- |
| **Cache** | | |
| Edge cache with per-object lifetime | ✅ | An object is one of `objects` slices of the key space; each edge location holds a bounded map of them with an expiry. |
| Hit ratio from traffic, TTL and object count | ✅ | Nothing sets it. `popularitySkew` spreads requests unevenly over the objects (a long tail). |
| TTL rules (default, minimum, maximum, origin `Cache-Control`) | ✅ | The AWS table: `max-age` is clamped between minimum and maximum, no header means the default, `no-store` means no caching unless the minimum TTL is above 0. One origin policy applies to every object. |
| Expired objects revalidated | 🟡 | An expired object is fetched again and counts as a miss. The 304 and the saved bytes are not modelled: the origin always sends the object. |
| Error caching (`Error Caching Minimum TTL`) | ✅ | 404, 414, 500, 501, 502, 503, 504 are cached for the error TTL (default 10 s) at the edge location. 400, 403 and 405 are cached by AWS only with a `Cache-Control` header, which is not modelled, so they are not cached; neither is 429 or 416. |
| `stale-while-revalidate`, `stale-if-error`, stale on origin 5xx | ✅ | An expired copy is served (and kept for the error TTL) when the origin returns a 5xx or cannot be reached; stale-if-error bounds it. |
| Request collapsing | ✅ | Per edge location, per regional cache and per Origin Shield, by object. The first request is the miss, the others count as hits. Not collapsed: `no-store`, writes. |
| Bounded cache, eviction of the least requested | ✅ | Each cache evicts past its capacity (CLOCK, a cheap least-recently-used). Capacities are assumptions. |
| Multiple edge locations | ✅ | `edge.locations` caches, each cold on its own; a request lands on one at random. |
| Regional edge cache tier | ✅ | Optional middle tier shared by edge locations; skipped by proxied methods. |
| Origin Shield | ✅ | Per origin: one more shared cache in front of that origin. |
| Cache key (query strings, headers, cookies, path) | ❌ | A request has no URL. The cache key is the object number. |
| Cache behaviours by path pattern | 🟡 | One default behaviour. Several primary origins split the objects by edge weight, which stands in for path patterns that route to different origins. |
| **Origins** | | |
| Origins on the `out` port (S3, custom HTTP, ALB...) | ✅ | One edge per origin. `originType` is `s3` or `custom`. |
| Origin groups and failover | ✅ | A secondary origin is called when the primary fails the selected status codes (4xx, 500, 502, 503, 504). Reads only. A refused connection counts as 503 and an origin timeout as 504, as AWS says. One secondary group for the whole distribution. |
| Connection attempts | ✅ | 1 to 3. A refused connection is tried again; a custom origin that does not answer is tried again for a read. |
| Response timeout, response completion timeout | ✅ | A slow origin gives a 504 after attempts x timeout (or the completion timeout). The origin carries on, as in AWS. S3 origins keep the 30 s default and are not retried. |
| Connection timeout | ❌ | See *Not yet simulated*. |
| Failure mapping to viewers | ✅ | 502 for refused connections, 503 for an origin 503 or 429-class throttling, 504 for timeouts, 4xx and 500 relayed. |
| Unwired or all-weight-zero origin | ✅ | 502. Cached objects are still served. |
| **Methods and sizes** | | |
| Read vs write (the call's `operation`) | ✅ | A read is a GET/HEAD and is cached. A write is a PUT/POST/PATCH/DELETE: proxied, never cached, no regional cache, no failover. |
| Allowed methods | ✅ | With GET and HEAD only, a write gets a 403. |
| Maximum cacheable object (50 GB), request body (64 GB) | ✅ | The object size setting stops at 50 GB; a body over 64 GB gets a 413. |
| URL length, header size | ❌ | Requests carry no URL or headers. |
| Compression | ✅ | Gzip or Brotli for objects of 1,000 to 10,000,000 bytes; the compressible share of an object's bytes shrinks to the ratio. Expected values, not per object. |
| **Edge compute** | | |
| CloudFront Functions | 🟡 | A latency (under a millisecond), an error rate. No code runs. |
| Lambda@Edge (viewer and origin events) | 🟡 | A latency, a timeout (30 s hard maximum), an error rate and the regional rate quota (10,000 per second). Over any of them the viewer gets a 503, as AWS documents. Origin events run on a miss only. |
| **Invalidation** | | |
| Invalidate on a schedule, or on demand | ✅ | `invalidation.every`, or change `purgeVersion` while running. A share of the objects, or all. Takes the propagation time. Empties the edge, regional and shield caches. |
| Invalidation path and cost limits | 🟡 | A wildcard counts as one path. The 1,000 free paths a month and the one wildcard a second are checked by an audit, not enforced. |
| **Quotas and viewers** | | |
| Requests per second per distribution (250,000) | ✅ | Account quota `cloudfrontRequestRate`; over it, 503. |
| Data transfer rate per distribution (150 Gbps) | ✅ | Account quota `cloudfrontDataTransferRate`; over it, 503. |
| Lambda@Edge requests per second per Region (10,000) | ✅ | Account quota `cloudfrontLambdaEdgeRate`, shared by the distributions in the region. |
| Price class and viewer distance | 🟡 | A share of viewers (assumed per class) pays an extra latency for a farther edge location. The viewer's own distance is the latency of the edge from the client. |
| **Metrics** | | |
| Requests, BytesDownloaded, BytesUploaded, 4xx/5xx error rates | ✅ | Counters `requests`, `bytesDownloaded`, `bytesUploaded`, `err4xx`, `err5xx`, and gauges `errorRate4xx`, `errorRate5xx`. |
| CacheHitRate, OriginLatency, error rate by status | ✅ | Gauge `cacheHitRate`, sampler `originLatency`, counters `err502`, `err503`, `err504`. |
| Origin protocol, TLS, HTTP/2 and 3, signed URLs, geo restriction, WAF, logging | ❌ | Not requests-and-latency behaviour. |

## Settings

Every setting is editable while the simulation runs and applies to the next request. `A` marks an assumption (AWS publishes
nothing); `H` a hard AWS limit; `Q` an adjustable quota default; `default` AWS's own default for a setting AWS lets you choose.

| Path | Default | Range | Kind | Models |
| --- | --- | --- | --- | --- |
| `objects` | 10,000 | 1 to 100 million | A | How many distinct objects the distribution serves. |
| `popularitySkew` | 1 | 1 to 10 | A | 1 is uniform; higher concentrates requests on the first objects. |
| `objectSize` | 100 KB | 0 to 50 GB | H (max) | Response size, the origin's fetch size. |
| `allowedMethods` | all | read, all | default | Whether writes are accepted (403 otherwise). |
| `cache.defaultTtl` | 1 day | 0 to 100 years | default | TTL when the origin sends no header (86,400 s). |
| `cache.minTtl` | 0 | 0 to 100 years | default | Minimum TTL. |
| `cache.maxTtl` | 365 days | 0 to 100 years | default | Cap on an origin `max-age` (31,536,000 s). |
| `cache.originCacheControl` | none | none, max-age, no-store | A | What the origin tells CloudFront about every object. |
| `cache.originMaxAge` | 1 hour | 0 to 100 years | A | The `max-age` when there is one. |
| `cache.errorMinTtl` | 10 s | 0 to 365 days | default (bound A) | Error caching minimum TTL. |
| `cache.staleWhileRevalidate` | 0 | 0 to 365 days | - | The origin's directive. |
| `cache.staleIfError` | 0 | 0 to 365 days | - | The origin's directive. |
| `edge.locations` | 1 | 1 to 1,000 | A | Edge locations (separate caches) viewers spread over. |
| `edge.capacity` | 50,000 | 1 to 1,000,000 | A | Objects one edge location keeps. |
| `edge.latency` | 3 ms, cv 0.5 | | A | Edge processing time. |
| `edge.priceClass` | all | all, 200, 100 | H (classes), A (viewers outside) | Which edge locations may serve. |
| `edge.farLatency` | 80 ms, cv 0.3 | | A | Extra latency from a farther edge. |
| `regionalEdgeCache.enabled` | on | | default | The middle tier. |
| `regionalEdgeCache.locations` | 1 | 1 to 100 | A | Regional caches the edge locations share. |
| `regionalEdgeCache.capacity` | 500,000 | 1 to 10 million | A | Objects one regional cache keeps. |
| `regionalEdgeCache.hop` | 10 ms, cv 0.3 | | A | One-way edge to regional cache. |
| `originShield.capacity` | 5,000,000 | 1 to 20 million | A | Objects a shield keeps (turn it on per origin). |
| `originShield.hop` | 15 ms, cv 0.3 | | A | One-way regional cache to shield. |
| `compression.enabled` | on | | H (sizes) | Gzip/Brotli for 1,000 to 10,000,000 bytes. |
| `compression.ratio` | 0.35 | 0 to 1 | A | Compressed size of what is compressible. |
| `compression.compressibleShare` | 0.6 | 0 to 1 | A | Share of bytes of compressible types. |
| `failover.*` | 500, 502, 503, 504 on; 4xx off | | H (the code list) | Origin group failover criteria. |
| `functions.viewerRequest` / `viewerResponse` | none | none, function, lambda | - | Code on every request/response. |
| `functions.originRequest` / `originResponse` | none | none, lambda | - | Lambda@Edge on a miss. |
| `functions.cloudFrontFunction` | 0.3 ms, cv 0.5 | | A | AWS says sub-millisecond. |
| `functions.lambdaAtEdge` | 40 ms, cv 1 | | A | Lambda@Edge duration. |
| `functions.lambdaTimeout` | 5 s | 1 ms to 30 s | H (max) | Over it the viewer gets a 503. |
| `functions.errorRate` | 0 | 0 to 1 | - | Share of executions that error (503). |
| `invalidation.every` | 0 (never) | 0 to 365 days | - | Scheduled purge. |
| `invalidation.share` | 1 | 0 to 1 | - | Share of objects the purge covers. |
| `invalidation.propagation` | 20 s | 0 to 1 hour | A | Time to reach every location. |
| `invalidation.purgeVersion` | 0 | integer | - | Change to purge now. |

Per origin (settings on the edge leaving `out`, on top of the usual edge settings):

| Path | Default | Range | Kind | Models |
| --- | --- | --- | --- | --- |
| `originType` | custom | custom, s3 | - | S3 buckets are not retried on a slow response. |
| `role` | primary | primary, secondary | - | Origin group role. Primaries split the objects by `weight`. |
| `shield` | off | | - | Origin Shield in front of this origin. |
| `connectionAttempts` | 3 | 1 to 3 | H | Tries on a refused connection or a slow GET. |
| `responseTimeout` | 30 s | 1 to 120 s | Q | Origin response timeout. |
| `responseCompletionTimeout` | 0 (none) | 0 to 10 min | - | Cap on the whole response across attempts. |
| `timeout` | 10 min | | - | The simulator's edge timeout, long enough not to interfere. |
| `request.operation` | read | read, write | - | Cache fills are GETs. |

Account quotas (Region box, one setting for every region): `cloudfrontRequestRate` (250,000 per second), `cloudfrontDataTransferRate`
(150 Gbps), `cloudfrontLambdaEdgeRate` (10,000 per second).

## Limits

| Limit | Value | Kind | Source |
| --- | --- | --- | --- |
| Requests per second per distribution | 250,000 | quota | https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html |
| Data transfer rate per distribution | 150 Gbps | quota | same |
| Maximum cacheable file size per GET response | 50 GB | hard | same, and RequestAndResponseBehaviorCustomOrigin.html |
| Maximum size of an HTTP request body | 64 GB | hard | same |
| Maximum request or origin response length (headers, query) / URL | 32,768 / 8,192 bytes | hard | same (not modelled) |
| Connection attempts per origin | 1 to 3 (default 3) | hard | https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesOrigin.html |
| Connection timeout per origin | 1 to 10 s (default 10) | hard | same (not modelled) |
| Response timeout per origin | 1 to 120 s (default 30) | quota | same, and cloudfront-limits.html |
| Response completion timeout | at least the response timeout; unlimited if unset | hard | same |
| Origin groups, failover status codes | 400, 403, 404, 416, 429, 500, 502, 503, 504; GET, HEAD, OPTIONS only | hard | https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/high_availability_origin_failover.html |
| Default TTL / minimum / maximum | 86,400 s / 0 / 31,536,000 s | default | https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesCacheBehavior.html |
| Cache-Control max-age ceiling | 100 years | hard | https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Expiration.html |
| Error caching minimum TTL | 10 s by default; 404, 414, 500, 501, 502, 503, 504 cached | default | https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/HTTPStatusCodes.html |
| Compression | gzip and Brotli; 1,000 to 10,000,000 bytes; listed content types | hard | https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/ServingCompressedFiles.html |
| Lambda@Edge function timeout | 30 s for viewer and origin events | hard | cloudfront-limits.html, edge-functions-choosing.html |
| Lambda@Edge requests per second per Region | 10,000 | quota | cloudfront-limits.html |
| Lambda@Edge response size | 40 KB viewer events, 1 MB origin events | hard | same (not modelled) |
| CloudFront Functions | sub-millisecond; 10 KB code; 2 MB memory | hard | https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/edge-functions-choosing.html |
| Invalidation | 150 paths and 1 wildcard per second; first 1,000 paths a month free | hard | cloudfront-limits.html, https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/PayingForInvalidation.html |
| Price classes | All; 200 = All minus South America, Australia and New Zealand; 100 = US, Mexico, Canada, Europe, Israel, Türkiye | hard | https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/ |

The quota page is the newer one where AWS's pages disagree: the response timeout maximum is 120 s there (older notes say 60 s
with a raise to 180 s), the maximum cacheable file is 50 GB (older: 30 GB), the request body 64 GB, the Lambda@Edge timeout
30 s for viewer events as well as origin events (older: 5 s), and the distribution quota of 250,000 requests a second.

## Behaviour

**One lookup per request.** A request carries a key in [0, 1). The component turns it into an object number
(`floor(key^skew x objects)`) and looks that number up in its edge location's cache (`Map`). A fresh entry is a hit,
answered after the edge's processing time. That is the whole hot path: one lookup, a few counter bumps, one timer.

**What a miss does.** The first request for an object an edge location does not hold starts the one fetch for it. Requests
for the same object that arrive while it is away wait on it (request collapsing) and are counted as hits when it lands.
The fetch goes to the regional edge cache (if enabled and the request is a cacheable read), which does the same one level
up, then to the origin, through that origin's Origin Shield if it has one. Each tier has its own cache and collapsing. Each
hop costs its latency each way. When the object comes back every tier on the way keeps it for the TTL.

**Hit ratio.** `cacheHit` counts requests answered without their own origin request: edge hits, regional and shield hits and
collapsed waiters. `cacheMiss` counts the one request per fetch that went to the origin. Writes and errors are not cacheable
requests and are in neither, as in CloudWatch's CacheHitRate. With `n` requests over `N` objects with a TTL much longer
than the run, the hit ratio tends to `1 - N / n` once the cache has warmed; a shorter TTL adds `N / TTL` fetches a
second, and a cache smaller than `N` evicts and loses more. `popularitySkew` > 1 makes a few objects take most traffic
(P(object < k) is `(k / N)^(1 / skew)`), as real traffic does.

**Lifetime.** `ttl` is worked out once per settings change from the table on AWS's Expiration page: `none` gives the default
TTL (or the minimum if higher); `max-age` gives the origin's value clamped to the minimum and maximum; `no-store` gives 0, which
means a GET is not cached and not collapsed (every request goes to the origin), unless the minimum TTL is above 0. When a
cached object expires it is fetched again by the next request (a revalidation, counted as a miss).

**Errors.** The origin's outcome is a status: components put it in their failure reason (`503 Slow Down`) and otherwise the
kind decides (Rejected 404, Failed 500, Throttled 503, an unavailable origin with no status is a refused connection). What
the viewer sees: a refused connection after the connection attempts is a 502 (Failed); an origin 503 or throttling is a 503
(Unavailable); a response timeout after the attempts is a 504 (Timeout); a 4xx is Rejected, a 500 Failed. Cacheable error
statuses are cached at the edge location for `errorMinTtl`; collapsed requests share the same error. If an expired copy of
the object is still in the cache and the origin returns a 5xx, the copy is served instead and kept for the error TTL
(`stale-if-error` bounds how long past its expiry a copy may be served). `stale-while-revalidate` answers from an expired copy
at once while one request refreshes it.

**Failover.** Origins on `out` with role primary split the objects between them by weight: object `i` of `N` goes to the
origin whose slice of the weights contains `(i + 0.5) / N`, so an object always goes to the same one, like a path pattern. If a
primary's outcome matches a selected status code (and the request is a read), the same request goes to a secondary. The
viewer sees the secondary's outcome. A secondary only serves failed-over requests.

**Timeouts and attempts.** Each origin request is up to `connectionAttempts` tries. A refused connection (the origin is down)
is tried again at once. A GET to a custom origin that does not answer within the response timeout is tried again, so
it takes attempts x timeout before the viewer gets a 504; a write is tried once. The completion timeout cuts the total.

**Invalidation.** A purge empties the edge, regional and shield caches (or a share of the objects) after the propagation time.
Requests keep being served from the old copies until then. Objects in flight when it lands are stored as usual.

**Viewers and latency.** The latency of the edge from the client is the viewer's network distance. Estimated latencies assume
the distribution sits in an AWS region, so set that edge's latency to the viewer-to-edge-location round trip you want. The
edge adds its own processing time, plus an extra latency for the share of viewers the price class does not cover, and function
time. Latencies on the edges to origins are the edge-to-origin network and can be left to the placement estimate.

**Quotas.** Each distribution gets its own `cloudfrontRequestRate` and `cloudfrontDataTransferRate` allowance (a one second bucket;
AWS publishes no burst, so that is an assumption). Over it the viewer gets a 503 (AWS documents no specific response). Lambda@Edge's
regional rate is shared by every distribution in the region.

**Differences from AWS.** The simulator has no URLs, so one distribution is one behaviour. Compression is the expected
byte count, not decided per object. Cache sizes, the tier latencies and the share of viewers outside a price class are
modelled because AWS publishes none. One message is one HTTP request: its `count` is ignored.

## Connections

- **In:** any component can call a distribution. The edge's `operation` decides what the request is: `read` is a GET (cached),
  `write` a PUT/POST/PATCH/DELETE (proxied). Edges default to `write`, so set the edge into a distribution to `read` for
  anything that should be cached. The message's `key` picks the object, and its `bytes` is the upload size of a write.
- **Out, `out` (Origins):** one edge per origin. The edge's settings are an origin's (see Settings). The call sent is a read
  for the object's size (a write for the request's size), with the object's place in the key space as its `key`, so an S3
  bucket behind it partitions by object. The usual edge settings still apply: latency (CloudFront to origin), weight (the share
  of objects a primary origin gets).
- **CloudFormation (`AWS::CloudFront::Distribution`, `importers/cloudformation/cloudfront.ts`):** a disabled distribution is left out quietly. Each `Origins[]` entry becomes an edge to what its `DomainName` names: a resource of the template, an S3 domain naming a bucket of the template (by `BucketName`), or an external endpoint named by its host; an origin that can't be told from the template (a deploy-time value) is reported and not connected. Edge settings: `originType` is `s3` for `S3OriginConfig` or an S3 target and `custom` otherwise; the call is always a `read`; `OriginGroups` makes `Members[1]` a `secondary`; `OriginShield.Enabled` sets `shield`; `ConnectionAttempts` and `ResponseCompletionTimeout` set the edge settings, and `CustomOriginConfig.OriginReadTimeout` becomes `responseTimeout`. Distribution settings: `OriginGroups` `FailoverCriteria.StatusCodes` set `failover.*` (4xx as `clientErrors`; the codes of every group are added together, and groups that differ are reported); `PriceClass` sets `edge.priceClass`; `CustomErrorResponses[].ErrorCachingMinTTL` sets `cache.errorMinTtl` (the longest, reported if they differ).
- The **default cache behavior** sets `cache.defaultTtl/minTtl/maxTtl` from `CachePolicyId` (a `AWS::CloudFront::CachePolicy` of the template, or the managed CachingOptimized, CachingOptimizedForUncompressedObjects and CachingDisabled policies by id) or, failing that, the legacy `DefaultTTL`, `MinTTL`, `MaxTTL`; TTLs beyond the component's range are brought into it and reported, and a policy that can't be read is reported and leaves the component's defaults. **`Compress` and `AllowedMethods` follow CloudFront's defaults, not the component's:** `Compress` absent is `compression.enabled: false`, and `allowedMethods` is `read` unless a `PUT`, `POST`, `PATCH` or `DELETE` is listed, which gives `all`. `LambdaFunctionAssociations` and `FunctionAssociations` set `functions.viewerRequest/viewerResponse/originRequest/originResponse` to `lambda` or `function`; the Lambda@Edge function is not wired (the component models it with its `functions` settings) and is reported, and a CloudFront Function is code inside the distribution, not a component.
- **Not represented:** `CacheBehaviors` beyond the default (reported with their path patterns: the component has one cache behavior), and origin access controls, cache and response-header policies and the like (skipped quietly). A distribution nothing in the template calls gets an assumed viewer source whose requests are reads.

## Metrics and state

Counters (per second in frames): `requests`, `cacheHit`, `cacheMiss`, `edgeHit`, `regionalHit`, `shieldHit`, `collapsed`,
`originRequests`, `originRetries`, `originErrors`, `failover`, `staleServed`, `errorsCached`, `proxied`, `invalidations`,
`functionErrors`, `rejected`, `bytesDownloaded`, `bytesUploaded`, `err4xx`, `err5xx`, `err502`, `err503`, `err504`.
Sampler `originLatency`: first-byte time of requests that went to the origin. Gauges: `cacheHitRate` (last ten seconds),
`errorRate4xx`, `errorRate5xx` (share of requests, last ten seconds), `edgeObjects`, `regionalObjects`, `shieldObjects`,
`fetching` (objects being fetched). The framework adds `in`, `ok`, `fail`, `fail.<Kind>`, `latency`, `inflight`.

The probe reports `objects`, `ttlSeconds`, `edgeObjects`, `regionalObjects`, `shieldObjects`, `fetching`, `hitRatio` (since the
start), `recentHitRatio`, the request, hit, miss, collapsed, stale and origin-request totals, `evictions`, and the
client and server error totals.

## Not yet simulated

1. **Cache behaviours by path pattern**, with a cache policy each. Needs requests to carry a path. Today one distribution is one behaviour.
2. **Connection timeout.** AWS retries a connection that does not open within 1 to 10 s. The simulator cannot tell an
   origin that is unreachable (every attempt times out) from one that is merely slow, because both are silence; a refused connection is retried at once instead. An unreachable-versus-refused fault would give it meaning.
3. **A cache key** with query strings, headers (including `Accept-Encoding`) and cookies, which is how real distributions lose hit ratio. `objects` and `popularitySkew` stand in.
4. **304 revalidation** with its saved bytes, and **range requests** for objects over 50 GB.
5. **Origin Shield region and the same-region S3 shortcut**, which need where the origin is.
6. **Custom error pages and error responses with other status codes**, and `Cache-Control` on errors (400, 403, 405).
7. **Real edge locations and viewer geography**, so latency and price class follow from where viewers are. Needs viewer placement in messages.
8. **Per-object sizes and TTLs**, so a catalogue of large and small, short- and long-lived objects can be mixed.
9. **Lambda@Edge cold starts and the regional concurrency pool** (it shares the Lambda account quota), and response size limits.
10. **Distribution deployment time**, continuous deployment, multi-tenant distributions, WebSockets, gRPC, streaming.

## Assumptions

- Edge, regional cache and Origin Shield capacities (50,000, 500,000 and 5,000,000 objects): AWS publishes no cache sizes; the
  ratios (regional larger than an edge location) follow AWS's description.
- Edge processing time (3 ms), regional hop (10 ms), shield hop (15 ms), the farther-edge latency (80 ms) and the share of
  viewers a price class leaves out (10% for 200, 25% for 100): AWS publishes no figure.
- The error caching maximum (365 days): AWS gives no range.
- Compression ratio (0.35) and compressible share (0.6): depend on the content; AWS says 'less than a quarter' at best.
- CloudFront Function time (0.3 ms) and Lambda@Edge time (40 ms, cv 1, cold starts included): AWS says only 'sub-millisecond'.
- Invalidation propagation time (20 s): AWS publishes no figure.
- The one second burst of the request and bandwidth quotas, and a 503 for going over them: AWS documents neither.
- An origin 4xx is a 404 (cacheable) unless the component says another status in its reason; an origin refusing connections
  is a 502; a Throttled origin is a 503.
- S3 origins are not retried on a slow response, and keep the 30 s default timeout: inferred from AWS listing the response
  timeout as a custom-origin setting.
- The origin's `max-age` (1 hour) when it sends one, and `objects` / `popularitySkew`, are properties of your application.

## References

- https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html
- https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Expiration.html
- https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesCacheBehavior.html
- https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesOrigin.html
- https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/HowCloudFrontWorks.html
- https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RequestAndResponseBehaviorCustomOrigin.html
- https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/HTTPStatusCodes.html
- https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/custom-error-pages-expiration.html
- https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/high_availability_origin_failover.html
- https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/origin-shield.html
- https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/ServingCompressedFiles.html
- https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/PayingForInvalidation.html
- https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/edge-functions-choosing.html
- https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/viewing-cloudfront-metrics.html
- https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/http-503-service-unavailable.html
- https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/http-504-gateway-timeout.html
- https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/
- https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-cloudfront-distribution-distributionconfig.html
