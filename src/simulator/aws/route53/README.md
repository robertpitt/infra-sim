# Route 53 (`aws.route53`)

Amazon Route 53 is DNS: it answers the question "where is `api.example.com`?", and with routing policies and health checks
it can give different callers different answers (a weighted split, a failover pair, the nearest region). It is not in the
data path. A caller asks its resolver, the resolver caches Route 53's answer for the record's TTL, and the caller then
connects to the endpoint directly. The component is one record name (a group of records with one name, type and routing
policy); each edge on its `out` port is one record pointing at one endpoint. What it lets you learn: **DNS failover is
slow, and you can say exactly how slow.** Route 53 must first notice (health check interval × failure threshold), and
then every resolver must let its cached answer expire (one TTL), so traffic moves over gradually, and resolvers that
ignore TTLs keep sending some of it to the dead endpoint for longer still. You can also see how a weighted canary is a
split of resolvers rather than of requests, how simple routing keeps sending traffic to a dead value, and how a TCP check
passes an endpoint that answers every request with a 500.

## Where the callers are

Route 53 picks answers by where the query comes from (latency and geolocation routing), and the simulator's engine does not
tell a component where its callers are. So **a Route 53 node stands with its callers**: its region is where they and their
resolvers are, and the edges from it to the endpoints carry the network distance from the callers to each endpoint (the
engine estimates an edge's latency from the two placements unless you set it). Place the node in the AWS Region nearest
the callers wired into it, outside any Region box. Two consequences:

- the call path costs what a direct call would: the caller's edge to the node is the last mile, the node's edge to the
  endpoint is the rest of the way, and the node adds nothing but a lookup when a resolver cache has run out;
- callers in two places want two nodes (the same records seen from two places). One node shared by both answers both as
  if they were where the node is. See *Not yet simulated* for the engine change that would remove this.

Route 53 is a global component (`global: true`): a region's or zone's fault doesn't take it down, only a fault on the node
itself. Its placement still sets its edges' default latency and keys its quotas. It has no errors alarm of its own: the
failures its callers see are the endpoints', and alarm there.

## Coverage

| Feature | Status | Notes |
| --- | --- | --- |
| **Resolution** | | |
| Not in the data path | ✅ | A call answered from a cache goes straight to the endpoint; the node adds no time. |
| Lookup on a cache miss | ✅ | `resolvers.lookup` (assumed 20 ms) on the calls whose cache has run out. |
| Resolver caches with a TTL | ✅ | `resolvers.count` caches, each holding one answer until it expires. A call uses the cache its key falls in, so a retry asks the same cache and one caller (a hot key) sits behind one cache. |
| Staggered expiry (traffic moves over one TTL) | ✅ | A cache filling for the first time gets a random part of its TTL, as if it had asked before the run began, so expiries are spread evenly. |
| Resolvers that ignore TTLs | ✅ | `resolvers.ignoreTtlShare` keep answers for `resolvers.ignoreTtlFor`. An assumption; off by default. |
| TTL 0 | ✅ | Every call asks, and pays the lookup. |
| No answer (NXDOMAIN, no record for a location) | ✅ | `Rejected`, which callers don't retry. |
| Negative caching (SOA minimum TTL) | ❌ | A no-answer is not cached. |
| **Routing policies** | | |
| Simple | ✅ | One value at random per query (Route 53 returns them in random order and the client takes one). No health checks, weights ignored. At most 400 values. |
| Weighted | ✅ | Weight 0 to 255; share = weight / total. Zero-weight records only when every weighted record is unhealthy; all zero is an even split. At most 100 records. |
| Failover | ✅ | Primary while healthy; secondary while the primary is unhealthy and it is not; primary when both are unhealthy; a secondary without a health check is always answered when the primary is down. Several records of one role share it by weight (AWS has one of each). |
| Latency | ✅ | The healthy record with the lowest latency from the callers (the edge's latency), then the next. See *Where the callers are*. |
| Geolocation | 🟡 | By continent: the callers' continent (from the node's Region), then the default record; no answer without one. Countries and US states, and unmapped IP addresses, are not modelled. |
| Multivalue answer, geoproximity, IP-based, traffic flow | ❌ | See *Not yet simulated*. |
| Alias records and Evaluate Target Health | ❌ | A record's health comes only from its health check. |
| **Health checks** | | |
| Checkers in several regions, each on its own clock | ✅ | `regions × checkersPerRegion` checkers per endpoint (16 by default), phases random, interval measured from each response. |
| Request interval 30 s or 10 s | ✅ | `healthCheck.interval`. |
| Failure threshold (consecutive checks, both ways) | ✅ | `healthCheck.failureThreshold`, 1 to 10, default 3. |
| The 18% rule | ✅ | Healthy while more than 18% of checkers say so. Recovery is therefore noticed sooner than failure. |
| Probes cross the edge | ✅ | A probe is a real call through the record's edge to the endpoint: an outage, a region that is out, errors, slowness or a black-holed edge fail it. Probes count in the edge's and the endpoint's metrics. |
| HTTP(S) check: connect within 4 s, 2xx/3xx within 2 s | ✅ | A probe fails on any failure, or when it takes longer than the round trip plus 2 s (4 s if the round trip alone is longer). |
| TCP check: connect within 10 s | 🟡 | Passes on any answer but `Unavailable` or `Timeout`, within 10 s. A slow but reachable endpoint fails here where AWS would pass it once connected. |
| A new health check is healthy until there is data | ✅ | |
| No healthy record means all are healthy | ✅ | For every policy. |
| Health checks per account (200) | ✅ | Account quota `route53HealthChecks`, shared by the records in a placement; past it a record has no health check and is always healthy. |
| String matching, calculated, CloudWatch alarm and recovery control checks, invert, disable | ❌ | |
| Checker regions as places (their own network paths) | ❌ | Every probe crosses the record's own edge. A partition between some checker regions and the endpoint can't be shown. |
| **Quotas and limits** | | |
| Records with one name and type (100), values in a simple record (400) | ✅ | Edges past the cap are never answered or checked. |
| Hosted zones (500), records per zone (10,000), query rates | ❌ | A node is one record; Route 53 publishes no query limit for authoritative DNS, and query volume is not the point. |

## Settings

Every setting is editable while the simulation runs and applies to the next query (a TTL change to answers given from then
on, as in AWS). `A` marks an assumption; `H` a hard AWS limit; `Q` an adjustable quota default; `default` AWS's own default.

| Path | Default | Range | Kind | Models |
| --- | --- | --- | --- | --- |
| `policy` | simple | simple, weighted, failover, latency, geolocation | - | The routing policy of the record group. Simple is DNS without Route 53's extras. |
| `ttl` | 60 s | 0 to 2,147,483,647 s | H (range); 60 s is AWS's recommended ceiling with health checks | How long resolvers cache an answer. |
| `healthCheck.type` | http | http, tcp | default | HTTP(S) needs a 2xx/3xx; TCP only a connection. |
| `healthCheck.interval` | 30 | 30, 10 | H (two values), default 30 | Seconds between a checker's response and its next request. |
| `healthCheck.failureThreshold` | 3 | 1 to 10 | H, default 3 | Consecutive checks to change a checker's mind. |
| `healthCheck.regions` | 8 | 3 to 8 | H, default all 8 | Health checker regions. |
| `healthCheck.checkersPerRegion` | 2 | 1 to 10 | A | Checkers in each region (from AWS's "about every two seconds"). |
| `resolvers.count` | 1,000 | 1 to 100,000 | A | DNS caches the callers are spread over. |
| `resolvers.lookup` | 20 ms, cv 0.5 | | A | What a call waits when its cache has to ask. |
| `resolvers.ignoreTtlShare` | 0 | 0 to 1 | A | Share of caches that keep answers past the TTL. |
| `resolvers.ignoreTtlFor` | 15 min | 0 to 1 day | A | How long those keep them (never less than the TTL). |

Per record (settings on the edge leaving `out`, before the connection's and transport's):

| Path | Default | Range | Kind | Models |
| --- | --- | --- | --- | --- |
| `weight` | 1 | 0 to 255 | H | Weighted routing share (and the split between several records of one failover role). |
| `role` | primary | primary, secondary | | Failover role. |
| `location` | default | default, AF, AN, AS, EU, NA, OC, SA | | Geolocation: the continent the record answers. |
| `healthCheck` | on | | | Whether a health check is associated with the record. |

The edge's connector, `aws.route53.connection`, is the caller's own connection to the endpoint: `request.operation`
(`caller` by default: the operation the caller sent; or `read`, `write`), `request.payload`, `timeout`, `cancelOnTimeout`,
`retry`. Transport's `latency` is the network distance from the callers to the endpoint.

Account quota (Region box): `route53HealthChecks` (200).

## Limits

| Limit | Value | Kind | Source |
| --- | --- | --- | --- |
| Health checks | 200 active per account | quota | https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/DNSLimitations.html |
| Geolocation, latency, multivalue, weighted and IP-based records with the same name and type | 100 | hard | same |
| Records in a record set (values of a simple record) | 400 | hard | same |
| Hosted zones / records per hosted zone | 500 per account / 10,000 per zone | quota | same (not modelled) |
| Child health checks of a calculated check | 255 | hard | same (not modelled) |
| TTL | 0 to 2,147,483,647 s | hard | https://docs.aws.amazon.com/Route53/latest/APIReference/API_ResourceRecordSet.html |
| TTL with a health check | 60 s or less recommended | advice | https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-values-shared.html |
| Weight | 0 to 255; 0 never answered unless all are 0 or every weighted record is unhealthy | hard | API_ResourceRecordSet.html, https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-policy-weighted.html |
| Failover | primary if healthy; secondary if primary unhealthy and secondary healthy; primary if both unhealthy; secondary without a health check always healthy | hard | API_ResourceRecordSet.html, https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/health-checks-how-route-53-chooses-records.html |
| Records without a health check are healthy; no healthy record means all are | | hard | health-checks-how-route-53-chooses-records.html |
| Simple routing: values in random order, not health checked | | hard | https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-policy-simple.html |
| Latency routing: lowest latency between the user and the record's Region | | hard | https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-policy-latency.html |
| Geolocation: smallest region first, then larger, then default; no default means no answer | | hard | https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-policy-geo.html, resource-record-sets-values-geo.html |
| Request interval | 10 or 30 s, default 30 | hard | https://docs.aws.amazon.com/Route53/latest/APIReference/API_HealthCheckConfig.html |
| Failure threshold | 1 to 10, default 3; consecutive checks to change status either way | hard | same, and https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/health-checks-creating-values.html |
| Health checker regions | at least 3 of 8 (us-east-1, us-west-1, us-west-2, eu-west-1, ap-southeast-1, ap-southeast-2, ap-northeast-1, sa-east-1); all if none chosen | hard | API_HealthCheckConfig.html |
| Healthy verdict | more than 18% of health checkers report healthy | hard | https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-failover-determining-health-of-endpoints.html |
| HTTP(S) check | TCP connection within 4 s, then 2xx or 3xx within 2 s | hard | same |
| TCP check | connection within 10 s | hard | same |
| New health check | healthy until there is enough data | hard | same |
| Check rate | about one request every 2 s at a 30 s interval; more than once a second at 10 s | published | health-checks-creating-values.html |

## Behaviour

**A call.** The call's key picks a resolver cache (`floor(key × count)`). If that cache holds a live answer, the call goes
to that record's endpoint at once. Otherwise the cache asks Route 53: the call waits `resolvers.lookup`, Route 53 picks a
record by the policy and the current health verdicts, and the cache keeps it for the TTL (or `ignoreTtlFor`, for the
first `ignoreTtlShare × count` caches). The call then goes through the record's edge, the caller's own connection, with
that edge's timeout and retries; the endpoint's answer (or failure) comes back unchanged. Route 53 is asked about
`count / TTL` times a second when every cache is busy, whatever the traffic.

**Weighted is a split of caches.** Each cache draws a record when it asks, so the traffic share of a record is the share of
caches holding it, which moves by a few percent from one TTL to the next with 1,000 caches and a lot more with ten. A
single client behind one cache goes to one record for a whole TTL.

**Health checks.** Each health-checked record has N = `regions × checkersPerRegion` checkers (16 by default). Each sends a
request through the record's edge, waits for the answer (or its deadline), and sends the next one an interval after.
A checker changes its mind after `failureThreshold` consecutive results that disagree with it. Route 53 calls the endpoint
healthy while more than 18% of its checkers do. When an endpoint fails at time T, checker j sees its first failure at
T + u_j (u_j spread evenly over an interval I) and changes its mind after k − 1 more, at T + u_j + (k − 1)·I. Route 53
calls it unhealthy once all but floor(0.18·N) checkers have (14 of 16): the 14th of 16 even draws, about 14/17 of an
interval. So:

- detection ≈ (k − 1)·I + 0.82·I: about **85 s** with the defaults (3 × 30 s), **28 s** with fast checks, **25 s** with a
  threshold of 1;
- recovery ≈ (k − 1)·I + 0.18·I, because 3 of 16 are enough: about **65 s** with the defaults. Recovery is seen sooner
  than failure.

A probe takes its round trip, so a check against an endpoint that is reachable but slow (or a black-holed edge) adds its
deadline to each interval.

**The TTL lag.** At the moment Route 53 changes its answer, every cache still holds the old one, with lifetimes spread
evenly over [0, TTL]. The share of traffic still going to the old endpoint falls in a straight line from 1 to 0 over one
TTL (gauge `cachedUnhealthy`). So a failover takes **detection + TTL**: about 145 s with the defaults. Failing back takes
recovery + TTL, about 125 s after the endpoint is back (it is noticed in about 65 s, then the caches holding the secondary
expire).
Caches that ignore TTLs keep their share on the old endpoint for `ignoreTtlFor`, falling linearly over that.

**Failures.** A call with no answer fails `Rejected` (`NXDOMAIN` with no records; "no answer" for a location without a
record or a default). Everything else is the endpoint's own outcome; Route 53 adds no failure of its own.

**Departures from AWS.** One node per caller location (see *Where the callers are*). The record's health check settings
apply to all its records (AWS configures each health check on its own). Several records of one failover role are allowed
and share by weight. Latency routing uses the edge's latency, which the engine estimates from the placements as AWS uses
its measurements between the caller's network and the record's Region.

## Connections

- **In:** any caller (a client, a function, a service) calls the record as it would call the endpoint. Set the caller's
  edge as you would for the endpoint: its operation, timeout and retries. Its latency is the last mile to the resolver.
- **Out (`out`, many):** one edge per record, to the endpoint (an API, a load balancer stand-in, a bucket, a distribution,
  another record). The edge carries the record's fields (`weight`, `role`, `location`, `healthCheck`), then the
  `aws.route53.connection` connector's (the caller's connection), then transport's latency. The connector passes the
  caller's operation through unless set, and sends health checks as one try with no retries.
- CloudFormation: `AWS::Route53::RecordSet` and `HealthCheck` are not imported yet.

## Metrics and state

Counters (per second in frames): `queries` (lookups that reached Route 53: DNSQueries), `cacheHits` (calls answered from
a resolver's cache), `noAnswer`, `probes` (health check results), `probeFailures`, `healthChanges` (Route 53 changing its
verdict on an endpoint). Sampler `healthCheckTime`: how long the checks an endpoint answered took (TimeToFirstByte for HTTP
checks, ConnectionTime for TCP). Gauges: `unhealthyRecords`, `healthyChecks` (health-checked records that are healthy:
HealthCheckStatus summed), `lowestPercentageHealthy` (the lowest HealthCheckPercentageHealthy over the records' health
checks, 0 to 1; 1 when no record has one), `healthyThreshold` (the 18% a check must stay above, to chart against),
`cachedUnhealthy` (of the caches holding a live answer, the share pointing at an unhealthy record: the TTL lag),
`healthChecks` (records with a health check). The node's own `in`/`ok`/`fail`/`latency` are the callers' calls through it.

Each edge (`aws.route53.connection`) shows its record's traffic (`calls`, health checks included) and its own health check
as CloudWatch reports one: gauges `healthCheckStatus` (HealthCheckStatus, 1 or 0; 1 without a health check, as Route 53
treats it) and `healthCheckPercentageHealthy` (HealthCheckPercentageHealthy, 0 to 1), `healthyThreshold`, the counter
`healthChecks` (checks that crossed it) and the sampler `healthCheckTime`. The connector finds its record's health check
by the identity of the edge's settings, which the record and the connector share.

The dashboards (`dashboard.ts`) chart these: DNS queries and the resolvers' cache, health check status and percentage
healthy against the threshold, the checkers' requests and time, and the answers still cached to unhealthy records.

Probe state: `policy`, `ttlSeconds`, `records` (per record: edge, endpoint, `healthChecked`, `healthy`, `checkersHealthy` of
`checkers`, `changedAt`, `cachedShare`), `resolvers`, `cached`, `cachedUnhealthy`, and totals `queries`, `cacheHits`,
`noAnswer`, `probes`, `probeFailures`, `healthChecks`, `healthChecksRefused`.

## Not yet simulated

1. **One record for callers in many places.** Latency and geolocation routing (and the network distance through a record)
   need the caller's location per call. With an engine change (the placement of a message's origin available to a
   component, and an edge's default latency computed from the caller's placement for a pass-through), one node could serve
   every caller and answer each by its own location, and the per-location node workaround would go.
2. **Alias records with Evaluate Target Health.** The most common setup: an alias to a load balancer or distribution whose
   health is the target's. It would read the target's health (an outage on the node, its healthy targets) instead of a
   health check, with its own detection delay.
3. **Multivalue answer.** Up to eight healthy values per answer, the client trying another when one fails. Needs a cache
   to hold a set and the connection to try a second value.
4. **Health checks as their own resources.** Per-record interval, threshold and type; calculated health checks; CloudWatch
   alarm checks (which would let a design fail over on an error rate instead of a dead endpoint); invert and disable.
5. **Checker regions as places.** Probes from each checker region over its own path, so a partition between some regions
   and an endpoint shows the 18% rule protecting it.
6. **Countries, US states and unmapped addresses** for geolocation; geoproximity bias; IP-based routing.
7. **Negative caching** of a no-answer for the zone's SOA minimum TTL.
8. **CloudFormation import** of record sets and health checks.

## Assumptions

| Number | Value | Why |
| --- | --- | --- |
| Checkers per region | 2 | AWS: at a 30 s interval an endpoint gets a check "about every two seconds", about 15 checkers; 2 in each of 8 regions. |
| Resolver caches | 1,000 | Enough that a share moves smoothly and a weighted split lands within a few percent. |
| Lookup on a miss | 20 ms, cv 0.5 | A recursive resolver's round trip to Route 53's anycast name servers. AWS publishes no figure. |
| Resolvers that ignore TTLs | 0%, 15 minutes when on | Measurement studies find a few percent of resolvers stretch TTLs; no AWS number. Off so that the documented behaviour is what you see first. |
| First-fill expiry | uniform over the TTL | The run starts in a steady state: caches asked at random moments before it. |
| HTTP check timing | round trip + 2 s, or 4 s | The model can't separate connecting from answering. |
| Caller location | the node's Region | See *Where the callers are*. |
| Continent of a Region | by prefix (us, ca, mx: NA; sa: SA; eu: EU; af: AF; ap, me, il: AS; Sydney, Melbourne, New Zealand: OC) | Route 53's continent lists. |

## References

- Quotas: https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/DNSLimitations.html
- How Route 53 determines whether a health check is healthy: https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-failover-determining-health-of-endpoints.html
- Values for health checks: https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/health-checks-creating-values.html
- HealthCheckConfig (API): https://docs.aws.amazon.com/Route53/latest/APIReference/API_HealthCheckConfig.html
- ResourceRecordSet (API): https://docs.aws.amazon.com/Route53/latest/APIReference/API_ResourceRecordSet.html
- How Route 53 chooses records when health checking is configured: https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/health-checks-how-route-53-chooses-records.html
- Simple, weighted, latency and geolocation routing: https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-policy-simple.html, routing-policy-weighted.html, routing-policy-latency.html, routing-policy-geo.html
- Geolocation record values (continents, fallback): https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-values-geo.html
- Values common to all routing policies (TTL): https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-values-shared.html
