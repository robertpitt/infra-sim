# API Gateway (`aws.apigateway`)

Amazon API Gateway is the managed front door for HTTP APIs: it terminates the request, throttles it, authorizes the caller, optionally answers from a cache, and hands what is left to an integration (a Lambda function, an HTTP backend, an AWS service). This component lets you see how a design behaves at that door: where the throttle layers (usage plan, stage, account) start returning 429, what a slow backend looks like from outside (504, with the work still running behind it), how much a Lambda authorizer's result cache takes off the authorizer function, how much a stage cache takes off the backend, and which of 4xx and 5xx your callers will see when something behind the gateway goes wrong. REST and HTTP APIs share the component and differ where AWS makes them differ; WebSocket APIs are not modelled.

## Coverage

| Feature | Status | Notes |
| --- | --- | --- |
| **API types** | | |
| REST API and HTTP API | ✅ | `apiType`. They differ in the integration timeout (29 s vs 30 s), and only REST has usage plans and the response cache. |
| Regional, edge-optimized, private REST endpoints | 🟡 | `endpoint` only decides whether the integration timeout can be raised above 29 s (Regional and private yes, edge no). The CloudFront hop of an edge-optimized API, and private APIs' VPC endpoint, add no latency. |
| WebSocket APIs | ❌ | Different model (connections, frames, callback API). The CloudFormation importer already skips them. |
| **Requests** | | |
| 10 MB payload limit (413) | ✅ | Checked first, before any throttle token is spent. |
| Gateway overhead latency | 🟡 | One lognormal `overhead` for everything the gateway adds. AWS publishes no figure (assumed). Mapping templates, request validation and WAF add nothing of their own. |
| Header size, URL length, method ARN length limits | ❌ | Messages carry no headers or paths. |
| Request validation, WAF, resource policies, CORS, custom domains, canary stages | ❌ | Have no effect on load behaviour in this model. |
| **Integrations** | | |
| Call the connected backend (Lambda proxy, HTTP proxy, AWS service) | 🟡 | All three look the same: the gateway calls what is on its Integration port, weighted when there are several. Lambda's non-proxy mapping and AWS-service request shaping are not modelled. |
| MOCK integration | ✅ | `integrationType: mock` answers at the gateway; no edge needed. |
| Private integration through a VPC link | ❌ | VPC links add latency and have their own quotas; the VPC component does not model them yet. |
| Integration timeout, 50 ms to 29 s / 30 s, 504 | ✅ | The gateway answers 504 and abandons the call; the backend keeps working unless the edge is set to cancel on timeout. |
| Raising the REST timeout above 29 s | ✅ | Account quota `apiGatewayIntegrationTimeout`; Regional and private REST only. The cost in regional throttle that AWS mentions is reported by the audit, not modelled. |
| **Throttling** | | |
| Account token bucket (rate, burst), shared per region by every API | ✅ | Rate is an account quota; the burst is fixed by AWS. Reduced regional defaults. |
| Stage throttle as the default for every method or route | 🟡 | One rate and burst applied to each of `routes` buckets. Traffic spreads evenly over routes by message key (a hot key lands on one route). Different limits per method are not modelled. |
| Usage plan: per-API-key rate and burst | ✅ | `usagePlan`: N clients identified by message key, each with its own bucket, checked before the stage and account. REST only. |
| Usage plan: per-day, per-week, per-month quota | 🟡 | Counted per client; windows start with the simulation and a month is 30 days (AWS uses the calendar). The `offset` option is not modelled. |
| API key required / invalid key (403), key source from an authorizer | ❌ | Every request is assumed to carry a valid key. |
| Method-level throttling inside a usage plan | ❌ | |
| AWS's own regional throttle (the last layer) | ❌ | Not published. |
| "Best effort" overrun of limits | ❌ | Buckets are exact; AWS says limits are targets that can be overrun. |
| **Authorization** | | |
| Lambda authorizer calling a real Lambda function | ✅ | Connect a function to the `authorizer` port: its cold starts, concurrency and throttling count. Unconnected, the check takes `authorizer.latency`. |
| Authorizer result cache (TTL, per caller identity) | ✅ | TTL 0 to 3,600 s, default 300. A cache hit never calls the function. Concurrent misses for one caller each call it. |
| Authorizer deny (403), failure (500), timeout | ✅ | `deny` is a share of callers; a down, throttled or erroring function is a 500; the gateway waits 10 s. The 10 s is documented for HTTP APIs and assumed for REST. Denials are cached, failures are not. |
| JWT authorizer (HTTP), IAM (SigV4), Cognito user pool (REST) | 🟡 | Each costs `authorizer.latency` and nothing else; JWT also pays once per two hours for fetching the issuer's keys. Token validity, scopes and signature failures are not modelled; nobody is ever rejected except by `deny`. |
| 401 for a missing identity source | ❌ | |
| **Response cache (REST)** | | |
| Hit and miss by cache key, TTL, GET only by default | ✅ | The request's key picks one of `keys` distinct entries. A hit answers from the cache (overhead plus `hitLatency`) without calling the integration. |
| Capacity by cluster size | 🟡 | Entries that fit = size ÷ response size; the oldest entry is evicted first (AWS publishes no eviction policy). Changing the size empties the cache. Cluster CPU and network are not modelled. |
| 1,048,576-byte cached response limit | ✅ | Larger responses are never cached. |
| `Cache-Control: max-age=0` invalidation and unauthorised handling | ✅ | `invalidate` share of requests; allowed, 403, or ignored. |
| Up to 4 minutes to create or delete the cache cluster | ❌ | The cache is ready at the start of the run. |
| Per-method cache overrides (TTL, key parameters, encryption) | ❌ | One cache setting for the stage. |
| **Failures seen by the caller** | | |
| 429 throttled and quota exceeded | ✅ | `Throttled`, with the layer that said no in the reason and a counter per layer. |
| 413 too large, 403 denied | ✅ | `Rejected`. |
| 504 integration timeout | ✅ | `Timeout`. |
| 503 backend unavailable, 502 backend failed | 🟡 | A backend that is down (`Unavailable`) is 503; one that ran and failed or was throttled is 502; its own 4xx passes through. AWS's exact status for a throttled Lambda differs by API type and integration and is not published clearly (assumed 502). |
| 500 for a gateway with nothing connected | ✅ | `API_CONFIGURATION_ERROR`. |
| Custom gateway responses | ❌ | |
| **Metrics** | | |
| Count, 4XXError, 5XXError, Latency, IntegrationLatency, CacheHitCount, CacheMissCount | ✅ | See Metrics and state. |
| Per-method and per-route dimensions, DataProcessed | ❌ | |

Counts: ✅ 18, 🟡 8, ❌ 13.

## Settings

The first column is the path in a design file. Kind is how the number relates to AWS: **hard** (enforced, not adjustable), **quota** (adjustable default), **assumed** (AWS publishes nothing, or the choice is a modelling one).

| Setting | Default | Range | Kind | What it models |
| --- | --- | --- | --- | --- |
| `apiType` | `rest` | `rest`, `http` | hard (a choice) | REST or HTTP API. |
| `endpoint` | `regional` | `regional`, `edge`, `private` | hard (a choice) | REST endpoint type; decides whether the integration timeout can exceed 29 s. |
| `integrationType` | `proxy` | `proxy`, `mock` | modelling | Call the connected integration, or answer at the gateway. |
| `integrationTimeout` | 29 s | 50 ms to 5 min | 50 ms hard; upper end is what the API type allows (below); the 5 min ceiling is assumed | How long to wait before 504. The effective value is the smaller of this and the cap: 30 s HTTP, 29 s edge-optimized REST, the account quota for Regional and private REST. |
| `overhead.mean`, `overhead.cv` | 10 ms, 0.4 | 0 to 10 min; 0 to 3 | assumed | What the gateway adds to every request (lognormal). |
| `stageThrottle.rate` | 0 (none) | 0 to 10,000,000 req/s | quota | Default rate for every method or route; cannot usefully exceed the account's. |
| `stageThrottle.burst` | 0 (uses the rate) | 0 to 10,000,000 | quota | Bucket size for that limit. |
| `routes` | 1 | 1 to 300 | quota | How many methods or routes traffic spreads over; the stage limit applies to each. |
| `usagePlan.enabled` | false | | modelling | REST only. |
| `usagePlan.clients` | 10 | 1 to 10,000 | hard (10,000 API keys per account and Region) | Distinct API keys; requests spread over them by key. |
| `usagePlan.rate`, `usagePlan.burst` | 100 req/s, 0 (uses the rate) | 0 to 10,000,000 | quota | Per-key throttle. 0 for none. |
| `usagePlan.quota`, `usagePlan.period` | 0 (none), `day` | 0 to 1,000,000,000; `day`, `week`, `month` | quota; window alignment assumed | Requests per key per period; 429 above it. |
| `authorizer.type` | `none` | `none`, `lambda`, `jwt`, `iam`, `cognito` | modelling | The authorizer in front of the integration. |
| `authorizer.latency.mean`, `.cv` | 10 ms, 0.4 | | assumed | What a check costs when no function is connected, and what JWT, IAM and Cognito checks cost. |
| `authorizer.ttl` | 300 s | 0 to 3,600 s | hard (default 300 s, maximum 3,600 s) | Lambda authorizer result cache; 0 turns it off. |
| `authorizer.identities` | 1,000 | 1 to 100,000 | assumed | Distinct callers (cache keys). The simulator's own ceiling is 100,000. |
| `authorizer.deny` | 0 | 0 to 100% | modelling | Share of callers the authorizer refuses with 403. |
| `cache.enabled` | false | | modelling | REST only. |
| `cache.size` | 0.5 GB | 0.5, 1.6, 6.1, 13.5, 28.4, 58.2, 118, 237 GB | hard (the sizes AWS offers) | Cluster capacity. |
| `cache.ttl` | 300 s | 0 to 3,600 s | hard | Response TTL; 0 turns the cache off. |
| `cache.keys` | 1,000 | 1 to 100,000 | assumed | Distinct cacheable responses. Sets the hit ratio. The simulator's own ceiling is 100,000. |
| `cache.responseSize` | 10 KB | 1 to 10,240 KB | assumed (the 1 MB cache limit is hard) | Typical response size: capacity and the 1 MB rule. |
| `cache.scope` | `get` | `get`, `all` | hard (AWS default is GET only) | Which requests are cached. A GET is a call whose incoming edge has Operation: read. |
| `cache.hitLatency.mean`, `.cv` | 2 ms, 0.4 | | assumed | Time to answer from the cache. |
| `cache.invalidate` | 0 | 0 to 100% | modelling | Share of requests sending `Cache-Control: max-age=0`. |
| `cache.invalidation` | `allowed` | `allowed`, `forbidden`, `ignored` | hard (the three AWS strategies, plus "no policy") | What happens to those requests. |

Account quotas (shown in the region's Account quotas panel, shared by every API in the region):

| Setting | Default | Range | Kind | What it models |
| --- | --- | --- | --- | --- |
| `apiGatewayRate` | 10,000 req/s (2,500 in the smaller regions) | 1 to 10,000,000 | quota | Steady rate of the account bucket across all API types. |
| `apiGatewayIntegrationTimeout` | 29 s | 29 s to 5 min | quota (Regional and private REST only); the 5 min ceiling is assumed | The longest REST integration timeout. |

## Limits

| Limit | Value | Kind | Source |
| --- | --- | --- | --- |
| Account throttle rate, per Region, across REST, HTTP and WebSocket | 10,000 requests/s | quota | [quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html) |
| Account burst (bucket size) | 5,000 | hard ("not a quota that a customer can control or request changes to") | same |
| Reduced regions | 2,500 requests/s with a 1,250 burst | quota (rate), hard (burst) | same; [Service Quotas listing](https://docs.aws.amazon.com/general/latest/gr/apigateway.html) |
| Payload size, REST and HTTP | 10 MB (the 413 message says 10,485,760 bytes) | hard | same; [gateway responses](https://docs.aws.amazon.com/apigateway/latest/developerguide/supported-gateway-response-types.html) |
| REST integration timeout | 50 ms to 29 s; Regional and private can be raised by quota, edge-optimized cannot | hard minimum; quota maximum | [REST quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-execution-service-limits-table.html) |
| HTTP integration timeout | up to 30 s | hard | [HTTP quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html) |
| Throttle precedence | usage plan, stage method settings, account, AWS regional | hard | [throttling](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-request-throttling.html), [HTTP throttling](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-throttling.html) |
| Throttles and quotas are best effort | not guaranteed ceilings | behaviour | same; [usage plans](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-api-usage-plans.html) |
| Usage plan quota period | DAY, WEEK or MONTH | hard | [QuotaSettings](https://docs.aws.amazon.com/apigateway/latest/api/API_QuotaSettings.html) |
| API keys per account and Region | 10,000 | hard | [REST quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-execution-service-limits-table.html) |
| Routes per HTTP API; resources per REST API | 300 | quota | [HTTP quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html), [Service Quotas listing](https://docs.aws.amazon.com/general/latest/gr/apigateway.html) |
| Cache sizes | 0.5, 1.6, 6.1, 13.5, 28.4, 58.2, 118, 237 GB | hard | [CreateStage](https://docs.aws.amazon.com/apigateway/latest/api/API_CreateStage.html) |
| Cache TTL | 300 s default, 0 to 3,600 s (0 disables) | hard | [caching](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-caching.html) |
| Cached response size | 1,048,576 bytes | hard | same; [REST quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-execution-service-limits-table.html) |
| Only GET is cached by default | | behaviour | [caching](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-caching.html) |
| Cache creation or deletion | about 4 minutes | behaviour (not modelled) | same |
| Lambda authorizer result TTL | 300 s default, 3,600 s maximum, 0 disables | hard | [CreateAuthorizer](https://docs.aws.amazon.com/apigateway/latest/api/API_CreateAuthorizer.html), [HTTP Lambda authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-lambda-authorizer.html) |
| Timeout for a Lambda authorizer response (HTTP) | 10,000 ms | hard | [HTTP quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html) |
| JWT public-key cache | up to 2 hours, best effort | behaviour | [JWT authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html) |
| JWKS and OIDC discovery endpoint timeout | 1,500 ms | hard (not modelled) | [HTTP quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html) |
| Gateway response status codes | THROTTLED and QUOTA_EXCEEDED 429; REQUEST_TOO_LARGE 413; INTEGRATION_TIMEOUT 504; ACCESS_DENIED 403; AUTHORIZER_FAILURE and AUTHORIZER_CONFIGURATION_ERROR 500; API_CONFIGURATION_ERROR 500 | hard | [gateway responses](https://docs.aws.amazon.com/apigateway/latest/developerguide/supported-gateway-response-types.html) |
| Idle connection timeout | 310 s | hard (not modelled) | [REST quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-execution-service-limits-table.html) |

Where the AWS pages disagree. The list of reduced regions differs between the developer-guide quotas page (which names the UAE, `me-central-1`) and the General Reference / Service Quotas page (which omits the UAE but adds Taipei, `ap-east-2`, and New Zealand, `ap-southeast-6`). The simulator takes the union, so the UAE keeps the reduced default; check Service Quotas for your account if it matters. The REST quotas page says a raised integration timeout "might require a reduction in your Region-level throttle quota"; no number is published, so only a note from the audit models it.

## Behaviour

**The request path.** A request is checked in this order, and the first thing that says no ends it: payload over 10 MB (413); usage-plan rate for its API key (429); usage-plan quota for its key (429); the stage's limit for its route (429); the account's regional limit (429). A request that passes an earlier layer and fails a later one has spent the earlier token (AWS does not say whether it does; this errs towards throttling). Then the gateway spends its overhead time, authorizes, looks in the cache, and calls the integration. Throttling is checked before authorization, so a throttled request never invokes the authorizer function (assumed: AWS does not publish the order of throttling against authorization), and cache hits count against the throttle limits (assumed).

**Token buckets.** Each layer is `Limiter`'s token bucket: it starts full, refills continuously at `rate` and never holds more than `burst`. For the account the rate is the quota and the burst is 5,000 (1,250 in the reduced regions); every gateway in the same placement shares one bucket. With a 10,000/s rate and 5,000 burst, a spike of 15,000/s is absorbed for one second and then the excess is refused. The stage default applies to each of `routes` buckets separately, and a request's route is `hash(key) mod routes`, so spreading load across routes keeps each under its limit while a hot key (the client's `hotKeys` setting) piles onto one route and is throttled there. Likewise a usage plan splits requests over `clients` API keys, each with its own bucket and quota counter.

**Timeouts.** The wait starts when the request is handed to the integration, not when it arrived, so the gateway's overhead is not counted against it. On expiry the gateway answers 504 (`Timeout`), stops waiting (and stops the edge retrying) and leaves the backend's work running; with `cancelOnTimeout` on the edge to the backend it is cancelled instead. The effective timeout is `min(integrationTimeout, cap)`, with the cap 30 s for HTTP, 29 s for edge-optimized REST and `max(29 s, account.apiGatewayIntegrationTimeout)` for Regional and private REST.

**Mapping backend failures.** Whatever the backend's edge reports comes back as the gateway's own answer: `Timeout` stays a 504, `Rejected` (the backend refused the request, say Lambda's 6 MB payload limit) stays a 4xx, `Unavailable` (the backend is down) is a 503, and `Failed` or `Throttled` from behind it is a 502. The last mapping is the shakiest: AWS documents 502 for responses the gateway cannot use and 503 for an unavailable backend, and is not explicit about a throttled Lambda function. Gateway-made refusals (413, 429, 403, 500) are never retried by a client that reads `Rejected` as final, while 429, 500, 502, 503 and 504 are retried by the edge policy as AWS SDK clients would.

**Authorizers.** For a Lambda authorizer the gateway first looks in its result cache, keyed by the caller's identity (one of `identities`, chosen by the request's key) and living for `ttl`. A hit costs nothing and never calls the function; a miss calls the function connected to the `authorizer` port (a 2 KB synchronous event, so it takes the function's own cold starts, concurrency and throttling), waits at most 10 s, and caches the verdict. `authorizer.deny` makes that share of callers refused with 403, consistently, and the refusal is cached like an allow. A function that fails, throttles or times out is a 500 and nothing is cached, so an outage of the authorizer function takes the API down even though the backend is healthy. With no function connected the check takes `authorizer.latency` instead. JWT, IAM and Cognito checks are done inside API Gateway: they take `authorizer.latency`, are not cached, and a JWT check pays an extra 100 ms (assumed) when it has to fetch the issuer's keys, on the first request and then every two hours. With a 300 s TTL and 1,000 callers, the function sees about 1,000 / 300 = 3.3 calls per second whatever the request rate; cutting the callers or lengthening the TTL cuts it further.

**Cache.** A request asks for entry `hash(key) mod keys`. If the stage cache has it and it is fresh, the gateway answers after its overhead plus `hitLatency` and the integration is not called (CacheHitCount). Otherwise it is a miss (CacheMissCount): the integration is called and a successful answer is stored for `ttl`. Concurrent misses for one entry all go to the backend. The cluster holds `size ÷ responseSize` entries (capped at `keys`); beyond that the oldest entry is evicted, so a working set larger than the cache shows a hit ratio near capacity ÷ keys. Responses over 1,048,576 bytes are never stored. With `invalidate` above zero that share of requests behaves as `Cache-Control: max-age=0`: allowed ones skip the lookup and replace the entry, forbidden ones get 403, ignored ones are served normally. Only calls whose edge into the gateway has Operation: read (a GET) are cached unless `cache.scope` is `all`.

**Where the model departs from AWS.** Exact buckets where AWS is best-effort; routes, clients, callers and cache keys are all derived from one random key per request, not from real paths and headers; usage-plan windows start with the run; one stage cache setting rather than per-method overrides; the cache is ready from the start.

## Connections

| Port | Label | Carries |
| --- | --- | --- |
| `out` (default, many) | Integration | The request after authorization and the cache. Several edges split traffic by weight. Use it for a Lambda function, an HTTP endpoint or any other callee. |
| `authorizer` (one) | Lambda authorizer | A small synchronous event for the Lambda authorizer function, only when `authorizer.type` is `lambda`. |

The gateway is called by clients, CloudFront or anything else with an edge into it; the edge's **Operation** setting says whether the call is a read (a GET, cacheable) or a write, and **Payload size** the request size the 10 MB limit is checked against. The edge's timeout and retry policy on the caller's side apply to the whole gateway call. On the `out` edge, **timeout** is a second timeout in series with the gateway's integration timeout (whichever is shorter wins, and the edge's default is 30 s, so set it above 30 s to see HTTP APIs and raised REST timeouts), **cancelOnTimeout** decides whether a 504 cancels the backend's work, and **retry** makes the gateway call the backend again on failure, which AWS's integrations do not do by default; leave it at one attempt for a faithful model.

CloudFormation import (`importers/cloudformation/apigateway.ts`). It reads `AWS::ApiGateway::*`, `AWS::ApiGatewayV2::*` and SAM `Api`, `HttpApi` and function `Api`/`HttpApi` events (a function event naming no API gets the implicit API SAM would make). The component is one gateway whatever the number of methods, so several per-method facts are folded into one setting, and each fold that could change the result is reported.

- **API:** `AWS::ApiGateway::RestApi`, `AWS::ApiGatewayV2::Api`, `AWS::Serverless::Api` and `HttpApi` give `apiType`; WebSocket APIs are skipped. REST `EndpointConfiguration` (`Types` or SAM's `Type`) gives `endpoint` (`REGIONAL`, `EDGE`, `PRIVATE`; any other value is reported). Integrations come from `AWS::ApiGateway::Method` `Integration.Uri`, `AWS::ApiGatewayV2::Integration` `IntegrationUri`, SAM events and an inline OpenAPI body, as edges on `out` (an `http(s)` URL becomes an external endpoint; a direct AWS-service integration is reported, not drawn). `TimeoutInMillis` gives `integrationTimeout`.
- **Throttle and cache:** `MethodSettings` / `DefaultRouteSettings` `ThrottlingRateLimit` and `ThrottlingBurstLimit` give `stageThrottle.rate` and `.burst` (the `*` entry, else the first). On a REST stage, `CacheClusterEnabled` and `CacheClusterSize` give `cache.enabled` and `cache.size`; `CachingEnabled` with `CacheTtlInSeconds` gives `cache.ttl`, and any `HttpMethod: "*"` entry gives `cache.scope: all` (otherwise only GETs are cached). Caching on methods with no cache cluster is reported.
- **Usage plan:** `AWS::ApiGateway::UsagePlan` (or SAM `Auth.UsagePlan`) gives `usagePlan.enabled`, `rate`, `burst`, `quota`, `period`, with `clients` the number of `UsagePlanKey` resources; a plan with a quota and no `Throttle` sets `rate` 0 (no rate limit).
- **Routes:** the number of methods or routes (CDK's CORS `OPTIONS` methods excluded; SAM events and OpenAPI operations counted when there are no method resources) gives `routes` when above one.
- **MOCK:** `integrationType: mock` is set only when every integration is MOCK; with a mix, the integrations are called and the report says how many were MOCK.
- **Authorizers:** `AWS::ApiGateway::Authorizer` (`TOKEN`/`REQUEST` to `lambda`, `COGNITO_USER_POOLS` to `cognito`), `AWS::ApiGatewayV2::Authorizer` (`JWT` to `jwt`, `REQUEST` to `lambda`) and SAM `Auth.Authorizers` give `authorizer.type`, with `AuthorizerResultTtlInSeconds` (SAM `ReauthorizeEvery`) as `authorizer.ttl`; a Lambda authorizer's function is wired to the `authorizer` port. `AuthorizationType: AWS_IAM` (SAM `AWS_IAM`) gives `authorizer.type: iam`. The component has one authorizer for the whole API and applies it to every call, so an authorizer on only some routes ("N of M routes are authorized"), several authorizers of different kinds (the first is used), an authorizer mixed with IAM, and an authorizer the template doesn't contain are all reported.

Not represented: request validation, WAF, resource policies, custom domains, deployments and API keys (skipped quietly), and per-method differences in throttling, timeout or caching.

## Metrics and state

CloudWatch's names where there is one. Counters are per-second rates in a frame; the node also gets the framework's `in`, `ok`, `fail`, `fail.<Tag>`, `latency` and `inflight`.

| Name | Kind | Meaning |
| --- | --- | --- |
| `in` | rate | CloudWatch Count: requests received, including the ones throttled or refused. |
| `ok`, `fail`, `fail.Throttled`, `fail.Rejected`, `fail.Timeout`, `fail.Failed`, `fail.Unavailable` | rate | Outcomes by the failure that carried them (429, 4xx, 504, 500 and 502, 503). |
| `status.4xx` | rate | CloudWatch 4XXError: throttled (`Throttled`) and refused (`Rejected`) requests. |
| `status.5xx` | rate | CloudWatch 5XXError: timeouts, backend failures, authorizer failures and missing integrations. |
| `latency` | distribution | CloudWatch Latency: from admission to the response, so overhead, authorizer, cache and integration. |
| `integrationLatency` | distribution | CloudWatch IntegrationLatency: from handing the request to the backend to its answer (including the edge to it). Not recorded for gateway timeouts or cache hits. |
| `authLatency` | distribution | How long authorizer checks took (cache hits are not recorded). |
| `cache.hit`, `cache.miss` | rate | CloudWatch CacheHitCount and CacheMissCount. |
| `throttled.usagePlan`, `throttled.quota`, `throttled.stage`, `throttled.account` | rate | Which layer threw the 429. |
| `auth.invocations`, `auth.cacheHit`, `auth.denied`, `auth.failed` | rate | Lambda authorizer calls, cached answers, 403s, and 500s from a failed authorizer. |
| `inflight` | gauge | Requests inside the gateway. |
| `accountTokens` | gauge | Tokens in the account bucket (shared by the region). |
| `cacheEntries` | gauge | Entries held in the cache (including ones that have expired but not been replaced). |

Probe state: `accountTokens`, `stageTokens` (the lowest route bucket; 0 when there is no stage limit), and running totals `served`, `throttled` (all 429s), `quotaExceeded`, `timeouts`, `tooLarge`, `integrationErrors`, `authorizerInvocations`, `authorizerDenied`, `authorizerFailures`, `cacheHits`, `cacheMisses`, `cacheEntries`.

Audits (diagnostics in the region): a stage or usage-plan limit above the account's; an integration timeout longer than the API type allows (it is clamped); a raised integration-timeout quota; usage plans, a cache or an authorizer type that the API type does not have; a cache whose responses are too large to be cached.

## Not yet simulated

In rough order of value:

1. **Per-method overrides** (different stage limits, cache TTLs and authorizers per route). Needs routes as a first-class list, which a flat settings schema cannot express yet; today `routes` spreads one setting evenly.
2. **API key requirement and failures** (403 for a missing or wrong key; key source from an authorizer). Needs a notion of a caller's credentials on the message.
3. **The 401 for a missing identity source and JWT or token validity** (expired tokens, wrong scopes). Needs request metadata the engine's message does not carry.
4. **VPC link private integrations**: latency and the VPC link quotas; depends on the VPC component.
5. **WebSocket APIs**: connection model, frame limits (32 KB frames, 128 KB messages), the connection-rate quota (500 per second).
6. **Cache cluster life cycle**: the 4 minutes to provision, empty after a resize (resize already flushes), cluster-size-dependent throughput.
7. **Calendar-aligned usage-plan windows and the `offset` option**: needs a wall-clock epoch for the simulation.
8. **AWS's regional throttle layer and best-effort overrun of limits.** Not published.
9. **Edge-optimized APIs' CloudFront hop** and TLS/connection costs; the 310 s idle connection timeout.
10. **Gateway response customisation, request validation, WAF, mapping templates** and their cost in latency.
11. **Per-route CloudWatch dimensions and DataProcessed.**

## Assumptions

| Number | Value | Why |
| --- | --- | --- |
| `overhead` | 10 ms mean, CV 0.4 | AWS publishes none; a few to a few tens of ms is the usual experience. |
| `authorizer.latency` | 10 ms mean, CV 0.4 | Same; applies to JWT, IAM and Cognito checks and to a Lambda authorizer with no function connected. |
| `cache.hitLatency` | 2 ms mean, CV 0.4 | A cache read is quick; unpublished. |
| JWT key fetch | 100 ms | The first request, then every two hours. The two-hour life is documented; the cost is not. |
| Authorizer event size | 2 KB | Headers and context, not the body. |
| Authorizer timeout for REST | 10 s | Documented for HTTP APIs only. |
| Throttling before authorization and cache | | The order of throttling against the authorizer and cache is not published. |
| A throttled backend is a 502 | | AWS's mapping for this case is not clearly documented. |
| Eviction order | oldest first | AWS publishes no policy. |
| Usage-plan windows | from the start of the run; month = 30 days | AWS aligns to the calendar. |
| `usagePlan.clients`, `authorizer.identities`, `cache.keys` ceilings | 10,000 (a hard limit), 100,000, 100,000 | The last two bound memory in the simulator. |
| Integration timeout ceiling | 5 minutes | AWS publishes no upper bound for a raised REST timeout. |
| Reduced regions | union of two AWS pages | The pages disagree about the UAE (see Limits). |

## References

- [Amazon API Gateway quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html)
- [REST API quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-execution-service-limits-table.html)
- [HTTP API quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html)
- [API Gateway endpoints and quotas (General Reference)](https://docs.aws.amazon.com/general/latest/gr/apigateway.html)
- [Throttle requests to your REST APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-request-throttling.html)
- [Throttle requests to your HTTP APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-throttling.html)
- [Usage plans and API keys](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-api-usage-plans.html), [QuotaSettings](https://docs.aws.amazon.com/apigateway/latest/api/API_QuotaSettings.html)
- [Cache settings for REST APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-caching.html), [CreateStage](https://docs.aws.amazon.com/apigateway/latest/api/API_CreateStage.html), [MethodSetting](https://docs.aws.amazon.com/apigateway/latest/api/API_MethodSetting.html)
- [Lambda authorizers (REST)](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-use-lambda-authorizer.html), [CreateAuthorizer](https://docs.aws.amazon.com/apigateway/latest/api/API_CreateAuthorizer.html)
- [Lambda authorizers (HTTP)](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-lambda-authorizer.html), [JWT authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html)
- [Gateway response types](https://docs.aws.amazon.com/apigateway/latest/developerguide/supported-gateway-response-types.html)
- [REST metrics](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-metrics-and-dimensions.html), [HTTP metrics](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-metrics.html)
