# AWS WAF (`aws.waf`)

AWS WAF is a web application firewall: a **web ACL** (the console now calls it a protection pack) is a list of rules that
inspects every request to a CloudFront distribution, an Application Load Balancer, an API Gateway REST API or another
protected resource, and lets it through, counts it or blocks it (403 by default). The component is one web ACL in front of
the resource it protects. What it lets you learn: a **rate-based rule** stops one address flooding you, but only after AWS
WAF's detection lag, and it cannot stop a flood spread thin over many addresses, which has to be absorbed by what is
behind it; managed rule groups block what they recognise and nothing else, cost capacity units, and miss what sits past the
part of a body they inspect.

## Coverage

| Feature | Status | Notes |
| --- | --- | --- |
| **Placement** | | |
| Associated with a resource | 🟡 | Modelled as a hop in front of the resource (`clients → waf → cloudfront`), which adds the inspection latency. In AWS it is not a hop; see *Behaviour*. |
| Global (CloudFront) and regional web ACLs | 🟡 | `protects` says which. A CloudFront web ACL lives in us-east-1 and sits outside region boxes; an audit warns if it is placed in another region. That a regional one is in its resource's region, and that a CloudFront one really fronts a distribution, is not checked (audits see no edges). |
| One web ACL for several resources | ✅ | Several edges on `out`, chosen by weight. The rate-based rule counts across all of them: AWS tracks a rule instance per web ACL and rule (its list of limited addresses is asked for by web ACL and rule, not by resource). |
| **Rate-based rule** | | |
| Count per client IP over the evaluation window | ✅ | 1, 2, 5 or 10 minutes, counted in 10-second slices, so an address's count at a check is exact. |
| Limit (10 to 2,000,000,000 per window) | ✅ | Hard bounds of the setting. Rate limited while the count is over the limit, not at it. |
| Checked about every 10 seconds, plus propagation delay | ✅ | A check every 10 s; what it decides takes effect after `rateRule.lag` (assumed 10 s). The same lag on the way out. |
| Blocked requests still count | ✅ | The rule counts every request it sees, so a flooding address stays limited while it floods. |
| At most 10,000 addresses rate limited, highest rates first | ✅ | Past it the busiest 10,000 are limited and the rest get through. |
| Scope-down statement | 🟡 | On the HTTP method only (all, writes, reads): a request has no URL or headers. |
| Action Block or Count | ✅ | Count only counts (`counted`). CAPTCHA and Challenge are not modelled. |
| Changing the rule resets its counts | ✅ | A new limit, window or address count starts counting from zero and lifts every block (AWS: "can pause the rule's rate limiting activities for up to a minute"). |
| Client IP from the request | 🟡 | A request carries no address: each traffic source sends from `traffic.addresses` addresses, a request's key picking one. A client's hot key is one address. See *Behaviour*. |
| Aggregating on forwarded IP or custom keys | ❌ | IP address only. |
| More than one rate-based rule (up to 10) | ❌ | One. |
| **Rules and rule groups** | | |
| AWS Managed Rules rule groups and their capacities | 🟡 | The twelve groups as toggles with AWS's published WCUs. What they match is a share setting, not their rules. |
| Your own rules | 🟡 | Their capacity (`rules.customWcu`); they match like the managed groups. |
| What the rules match | 🟡 | Assumed shares: `rules.match` of ordinary requests, `rules.attackMatch` of requests from the sources named in `traffic.attackSources`. |
| Core rule set SizeRestrictions_BODY (bodies over 8 KB) | ✅ | Blocks writes with bodies over 8,192 bytes; can be overridden to Count. |
| Override rule groups to Count | ✅ | `rules.action: count`. |
| Rule priority | 🟡 | Fixed: rate-based rule, the oversize rule, the managed groups, your rules, then the default action (Allow). |
| Default action Block, Allow rules, IP sets as rules, geo match, labels | ❌ | The default action is Allow. |
| Bot Control, ATP, ACFP, Anti-DDoS behaviour | ❌ | Bot Control is a toggle with its capacity; its own rate limiting and token checks are not modelled. |
| **Body inspection** | | |
| Inspection limit (8 KB fixed for ALB and AppSync; 16 to 64 KB for the others) | ✅ | Requests are inspected up to the limit. |
| Attacks hidden past the limit | 🟡 | Caught in proportion to the share of the body inspected (assumed: the payload is equally likely to be anywhere). |
| Blocking oversized bodies (AWS's recommendation) | ✅ | `body.blockOversize`: a size constraint rule (1 WCU) ahead of the rule groups. |
| Oversize handling per rule (Continue, Match, No match) | 🟡 | Managed groups use Continue, which is what is modelled; Match is `blockOversize`. |
| Headers and cookies limits (8 KB, 200) | ❌ | Requests carry no headers. |
| **Capacity and quotas** | | |
| Web ACL capacity units | ✅ | Summed from the rules; over 5,000 is a design error, over 1,500 an info (it costs more). |
| Requests per second per web ACL (100,000) | ✅ | Regional web ACLs. Past it: 500, or through uninspected with ALB fail-open (what happens is assumed). |
| Web ACLs per account per Region (100, regional and CloudFront apart) | ✅ | Account quotas, checked by the audit. |
| **Failure modes** | | |
| Protected resource's answers | ✅ | Passed through unchanged: the web ACL is transparent. |
| ALB fail-open (`waf.fail_open.enabled`) | ✅ | Only when AWS WAF cannot take the request (the quota). |
| AWS WAF itself down | 🟡 | A node fault (`Outage`) answers 503 for everything; ALB fail-open does not apply to it. |
| **Metrics** | | |
| AllowedRequests, BlockedRequests, CountedRequests | ✅ | Counters `allowed`, `blocked`, `counted`, and blocked by cause. |
| Addresses rate limited, busiest address, blocked share, capacity | ✅ | Gauges. |

## Settings

Every setting is editable while the simulation runs and applies to the next request (a change to the rate-based rule's
limit, window or addresses also resets its counts). `A` marks an assumption (AWS publishes nothing); `H` a hard AWS limit;
`Q` an adjustable quota default; `default` AWS's own default for a setting AWS lets you choose; `-` a choice that is yours.

| Path | Default | Range | Kind | Models |
| --- | --- | --- | --- | --- |
| `protects` | cloudfront | cloudfront, alb, apigateway, appsync, cognito, apprunner, verifiedaccess | - | The associated resource: global or regional, body limit, quota, fail-open. |
| `latency` | 1 ms, cv 0.5 | | A | What evaluating the web ACL adds to a request. |
| `requestRate` | 100,000 req/s | 1 to 100,000,000 | Q | Requests per second per regional web ACL (a one-second bucket, assumed). |
| `failOpen` | off | | default | ALB's `waf.fail_open.enabled`. |
| `rateRule.enabled` | on | | - | The rate-based rule. |
| `rateRule.limit` | 2,000 | 10 to 2,000,000,000 | H (bounds) | Requests per address per window. AWS has no default; 2,000 is an example. |
| `rateRule.window` | 5 minutes | 1, 2, 5, 10 minutes | H (choices), default | The evaluation window. |
| `rateRule.scope` | all | all, write, read | - | Scope-down on the method (2 WCUs). |
| `rateRule.action` | block | block, count | - | What a rate-limited address gets. |
| `rateRule.lag` | 10 s | 0 to 5 min | A | Propagation delay after each 10-second check. |
| `traffic.addresses` | 1,000 | 1 to 50,000 | A | Addresses each traffic source sends from. |
| `traffic.attackSources` | (none) | node ids | - | Traffic sources whose requests are attacks. |
| `managed.<group>` | off | | H (capacities) | The twelve AWS Managed Rules rule groups (see *Limits*). |
| `managed.coreBodySize` | block | block, count | - | The Core rule set's SizeRestrictions_BODY rule, or its override to Count. |
| `rules.customWcu` | 0 | 0 to 5,000 | - | Capacity your own rules use. |
| `rules.action` | block | block, count | - | Block, or override every rule to Count. |
| `rules.match` | 0 | 0 to 1 | A | Share of ordinary requests some rule matches. |
| `rules.attackMatch` | 0.9 | 0 to 1 | A | Share of attack requests the rules catch, fully inspected. |
| `body.inspectionLimit` | 16 KB | 16, 32, 48, 64 KB | H (choices), default | Body inspected for CloudFront, API Gateway, Cognito, App Runner, Verified Access (8 KB fixed for ALB, AppSync). |
| `body.blockOversize` | off | | - | A size constraint rule blocking bodies over the inspection limit (1 WCU). |

Account quotas (Region box): `wafWebAcls` (100 regional web ACLs per Region) and `wafCloudFrontWebAcls` (100 CloudFront web
ACLs, which all live in us-east-1).

## Limits

| Limit | Value | Kind | Source |
| --- | --- | --- | --- |
| Web ACL capacity units per web ACL | 5,000 | hard | https://docs.aws.amazon.com/waf/latest/developerguide/limits.html, https://docs.aws.amazon.com/waf/latest/developerguide/aws-waf-capacity-units.html |
| WCUs included in the base web ACL price | 1,500 | pricing | https://docs.aws.amazon.com/waf/latest/developerguide/aws-waf-capacity-units.html |
| Requests per second per web ACL | 100,000 | quota | https://docs.aws.amazon.com/waf/latest/developerguide/limits.html (regional; for CloudFront "set by CloudFront"), https://docs.aws.amazon.com/general/latest/gr/waf.html (100,000 for CloudFront too) |
| Web ACLs per account per Region (regional; CloudFront) | 100; 100 | quota | https://docs.aws.amazon.com/general/latest/gr/waf.html |
| Rate-based rule limit | 10 to 2,000,000,000 per window | hard | https://docs.aws.amazon.com/waf/latest/APIReference/API_RateBasedStatement.html |
| Rate-based rule evaluation window | 60, 120, 300 (default), 600 s | hard | same, and https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based-high-level-settings.html |
| Rate check frequency | about every 10 s | hard | https://docs.aws.amazon.com/waf/latest/APIReference/API_RateBasedStatement.html |
| Detection and release delay | usually under 30 s, up to several minutes | documented range | https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based-caveats.html |
| Addresses rate limited per rate-based rule | 10,000, the highest rates first | hard | https://docs.aws.amazon.com/waf/latest/developerguide/listing-managed-ips.html |
| Rate-based rules per web ACL / per rule group | 10 / 4 | hard | https://docs.aws.amazon.com/waf/latest/developerguide/limits.html |
| Rate-based rule capacity | 2 WCUs, +30 per custom key, + the scope-down's | hard | https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based.html |
| String match (exact) capacity, size constraint capacity | 2 WCUs, 1 WCU | hard | https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-string-match.html, https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-size-constraint-match.html |
| Body inspection, ALB and AppSync | 8 KB, fixed | hard | https://docs.aws.amazon.com/waf/latest/developerguide/web-acl-setting-body-inspection-limit.html |
| Body inspection, CloudFront, API Gateway, Cognito, App Runner, Verified Access | 16 KB default; 16, 32, 48 or 64 KB | hard | same |
| Headers and cookies inspected | first 8 KB or 200 | hard | https://docs.aws.amazon.com/waf/latest/developerguide/waf-oversize-request-components.html (not modelled) |
| Core rule set (700), Known bad inputs (200), Admin protection (100) | WCUs | hard | https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-baseline.html |
| SQL database (200), Linux (200), POSIX (100), Windows (200), PHP (100), WordPress (100) | WCUs | hard | https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-use-case.html |
| Amazon IP reputation list (25), Anonymous IP list (50) | WCUs | hard | https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-ip-rep.html |
| Bot Control (50) | WCUs | hard | https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-bot.html |
| Core rule set SizeRestrictions_BODY | bodies over 8,192 bytes | hard | https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-baseline.html |
| Block response | 403 Forbidden by default | default | https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-action.html |
| Where web ACLs live | CloudFront: us-east-1 (Global); others: the resource's Region | hard | https://docs.aws.amazon.com/waf/latest/developerguide/how-aws-waf-works-resources.html |
| ALB when the web ACL fails | 500; routed uninspected with `waf.fail_open.enabled` (default false) | hard | https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-troubleshooting.html, https://docs.aws.amazon.com/elasticloadbalancing/latest/application/application-load-balancers.html |

The two quota pages disagree on CloudFront: the developer guide says the request rate for AWS WAF on CloudFront is set by
CloudFront, while Service Quotas lists 100,000 per CloudFront web ACL. The simulator follows the developer guide and applies
the quota to regional web ACLs only; CloudFront's own 250,000 requests per second per distribution applies at the
distribution behind it.

## Behaviour

**A hop in front of the resource.** In AWS a web ACL is associated with a resource and runs inside it; nothing is wired.
Here the WAF is drawn in front of the resource (`clients → waf → cloudfront`, `clients → waf → alb`) and adds its
inspection latency (`latency`, assumed 1 ms). The edge from the WAF to the resource adds the usual edge latency (1 ms
inside a region); set it to 0 to model the association exactly. A CloudFront web ACL is global: like CloudFront, leave it
outside region boxes (its placement is then us-east-1, where AWS keeps it). A regional web ACL goes in the region box of its
resource.

**Order.** A request that AWS WAF cannot take (past `requestRate`, regional web ACLs) never reaches the rules: it gets 500,
or, for an ALB with fail-open, goes through uninspected. Every other request is evaluated in a fixed priority order, and the
first terminating match decides:

1. the rate-based rule (if the request is in its scope);
2. the oversize rule (`body.blockOversize`): a write whose body is over the inspection limit;
3. the Core rule set's SizeRestrictions_BODY: a write whose body is over 8,192 bytes;
4. the managed rule groups and your own rules: a request from an attack source matches with probability
   `attackMatch × inspected share`, any other with probability `match` (nothing matches if the web ACL has no groups and
   no capacity of your own);
5. the default action: Allow, through `out`.

A Count action (rate rule or rules) counts the request (`counted`) and carries on. A blocked request is answered with
`Rejected` (403, never retried) after the inspection latency. A read is a GET with no body; a write's body is its `bytes`.

**Who is an address.** A message carries no IP. Each traffic source (the client node a request came from, its `origin`)
is taken to send from `traffic.addresses` addresses, and a request's key picks one: address = ⌊key × addresses⌋. A
client's hot key (`hotKeys`) always picks the same one, which is one IP flooding; the rest of its requests spread evenly.
Sources never share addresses, so a botnet's addresses are not your users'. The address count matters only for sources
that send enough to approach the limit: a source sending *r* requests a second gives each address
`r × window / addresses` requests per window.

**The rate-based rule.** Each address's requests are counted in 10-second slices over the window. Every 10 seconds the
rule looks at every address: those whose count over the window is above the limit are to be rate limited, the busiest
10,000 if there are more; the decision takes effect `rateRule.lag` later, replacing the previous one. So a flood is first
blocked between `lag` and `lag + 10 s` after its count passes the limit (the next check, then the delay), and an address is
released as long after its count falls back under it, which for a flood that stops is about a window later. Requests the rule
blocks still count, so a flooding address stays blocked while it floods. Out-of-scope requests are neither counted nor
limited. Worked example (the demo): a bot at 200 requests a second from one address against 2,000 per 5 minutes passes the
limit after 10 s; the next check catches it and it is blocked 10 s later, 20 to 30 s after it started, while 150 real users a
second never see an error. A botnet of 2,000 requests a second over 20,000 addresses sends 30 per address per 5 minutes and
is never blocked: the whole flood reaches the backend.

**Body inspection.** A body over the inspection limit (8 KB on an ALB or AppSync, 16 to 64 KB elsewhere) is inspected only
up to the limit. An attack request whose body is larger is caught with probability `attackMatch × limit / body`: padding
an attack to 32 KB halves what a 16 KB limit catches. Raising the limit (it costs more for bodies over 16 KB) or blocking
oversized bodies closes the gap; the second also blocks legitimate large uploads, as does the Core rule set's 8 KB rule.

**Capacity.** The web ACL's WCUs are the sum of the managed groups' published capacities, the rate-based rule (2, plus 2
for a method scope-down), the oversize rule (1) and your own rules. AWS may charge a little less when rules share work; the
sum is the ceiling. Over 5,000 the design has an error (AWS refuses the web ACL); over 1,500 an info (the price goes up).

## Connections

- **In**: anything that sends web requests: clients, or another component. The source of a request is its `origin`, the
  node that created it; put the WAF directly behind the clients so each client is its own set of addresses (behind
  CloudFront, the requests' keys are object numbers, not callers).
- **`out` (Protected resource, many)**: the resource the web ACL is associated with: CloudFront, API Gateway, an HTTP
  endpoint or service standing in for an ALB. Allowed requests are sent as they came; the resource's answer (success,
  partial batch failures, any failure) goes back to the caller unchanged. With several edges, a request goes to one by
  weight. With none, the web ACL answers allowed requests itself, so it can be tried on its own.
- Edge settings on `out` are the usual ones; their latency is the association's cost on top of `latency`.
- CloudFormation: not imported yet (`AWS::WAFv2::WebACL` and `AWS::WAFv2::WebACLAssociation` would map onto it).

## Metrics and state

Counters (per second in frames): `allowed`, `blocked`, `counted` (AllowedRequests, BlockedRequests, CountedRequests);
`blocked.rateBased`, `blocked.rules`, `blocked.bodySize` (Core rule set), `blocked.oversize` (BlockedRequests by Rule);
`counted.rateBased`, `counted.bodySize`, `counted.rules` (CountedRequests by Rule: a Count rule matched); `overQuota`
(past the request quota) and `uninspected` (of those, routed by ALB fail-open). The framework's `in`, `ok`, `fail.Rejected` (403s),
`fail.Failed` (500s) and `latency` include the protected resource's time.

Gauges: `rateLimitedAddresses` (addresses the rate-based rule limits now), `busiestAddress` (the highest count over the
window of any address at the last check, to compare with the limit), `blockedShare` (share of requests blocked between the
last two checks), `wcu` (capacity in use), `rateLimit` (the rate-based rule's limit per window, 0 without the rule, to read
`busiestAddress` against).

The dashboard (`dashboard.ts`) charts allowed, blocked and counted requests, overall and by rule, the blocked share, the
rate-based rule's busiest address against its limit, the addresses limited, requests past the quota, and latency.

Probe state: `allowed`, `blocked`, `counted`, `blockedByRateRule`, `blockedByRules`, `blockedBodySize`, `blockedOversize`,
`overQuota`, `uninspected` (totals), `rateLimitedAddresses`, `busiestAddressCount`, `trackedSources`, `wcu`.

## Not yet simulated

1. **Who the caller is.** A message has no client address, no URL and no headers, so addresses are derived from the key
   per source and rules match by share. A client setting for "bad traffic" (a share of its requests that are attacks, or a
   label on the message) would replace `traffic.attackSources`, and a client address count would replace
   `traffic.addresses`; both need a change to `common.client` and `Message`.
2. **CAPTCHA and Challenge.** The actions Bot Control and many rate-limiting setups use: a browser solves them and carries
   a token, a bot does not. Needs a notion of a client being a browser and a token's immunity time.
3. **Bot Control and the fraud groups' own behaviour** (targeted rate limits per session, token reuse, ML coordinated
   activity), and their per-request fees.
4. **More than one rate-based rule**, custom aggregation keys, forwarded IP (the address behind a proxy, which matters
   when a regional web ACL sits behind CloudFront), and the `CONSTANT` aggregation (a global limit on a scope-down).
5. **Default action Block and Allow rules** (an allow list of addresses ahead of the rest), IP sets, geo match, labels.
6. **Rule priority as a setting.** Today the order is fixed; putting the rule groups first would change what the rate
   rule counts.
7. **Edge-aware checks.** That a CloudFront web ACL fronts a CloudFront distribution and a regional one fronts a resource
   in its own Region (and not an HTTP API, which AWS WAF cannot protect) needs audits to see edges.
8. **AWS WAF unavailable** as a fault of its own, so ALB fail-open could apply to it, rather than only to the quota.
9. **Logging and sampled requests**, Firewall Manager, Shield Advanced.

## Assumptions

| Number | Value | Why |
| --- | --- | --- |
| Inspection latency | 1 ms, cv 0.5 | AWS publishes nothing; evaluation is in-process at the resource. |
| Propagation delay | 10 s | AWS: checks about every 10 s, delay "usually below 30 seconds". 10 s check + 10 s delay keeps the total under 30 s. |
| Addresses per source | 1,000 | A request has no address; a modelling choice. |
| Match shares | 0 (ordinary), 0.9 (attacks) | They describe your traffic and rules, not AWS. |
| An attack past the inspection limit | caught in proportion to the share inspected | The payload is taken to be equally likely anywhere in the body. |
| Past the request quota | 500, or uninspected with ALB fail-open; a one-second bucket | AWS documents the quota, not what exceeding it looks like; this is what an ALB documents for a web ACL that fails. |
| Rate limit example | 2,000 per 5 minutes | AWS has no default. |
| Unwired web ACL | answers allowed requests | Lets a WAF be tried on its own. |

## References

- AWS WAF quotas: https://docs.aws.amazon.com/waf/latest/developerguide/limits.html
- AWS WAF endpoints and quotas (Service Quotas): https://docs.aws.amazon.com/general/latest/gr/waf.html
- Web ACL capacity units: https://docs.aws.amazon.com/waf/latest/developerguide/aws-waf-capacity-units.html
- Rate-based rule statements, settings, caveats, request limiting, managed keys:
  https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based.html,
  https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based-high-level-settings.html,
  https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based-caveats.html,
  https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based-request-limiting.html,
  https://docs.aws.amazon.com/waf/latest/developerguide/listing-managed-ips.html
- RateBasedStatement API: https://docs.aws.amazon.com/waf/latest/APIReference/API_RateBasedStatement.html
- Body inspection and oversize handling: https://docs.aws.amazon.com/waf/latest/developerguide/web-acl-setting-body-inspection-limit.html,
  https://docs.aws.amazon.com/waf/latest/developerguide/waf-oversize-request-components.html
- AWS Managed Rules: https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-list.html (baseline,
  use-case, IP reputation, Bot Control pages)
- Rule actions and default action: https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-action.html,
  https://docs.aws.amazon.com/waf/latest/developerguide/web-acl-default-action.html
- Resources and Regions: https://docs.aws.amazon.com/waf/latest/developerguide/how-aws-waf-works-resources.html
- Metrics: https://docs.aws.amazon.com/waf/latest/developerguide/waf-metrics.html
- ALB and AWS WAF: https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-troubleshooting.html,
  https://docs.aws.amazon.com/elasticloadbalancing/latest/application/application-load-balancers.html
