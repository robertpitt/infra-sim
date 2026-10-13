# Elastic Load Balancing (`aws.alb`, `aws.nlb`)

Elastic Load Balancing puts one address in front of many targets. An **Application Load Balancer** (layer 7) terminates
HTTP: its listener routes each request to a target group (weighted target groups for blue/green and canaries, rules by
path or host), the target group picks a healthy target (round robin, least outstanding requests, weighted random), and
what goes wrong becomes 502, 503 or 504. A **Network Load Balancer** (layer 4) passes connections through: a flow hash
keeps each connection on one target, there are no HTTP errors (only resets), and it adds next to no latency. Both have a
node in each of their Availability Zones, reached through DNS, and both check their targets' health.

What the simulator lets you learn: **how long a dead or hung instance keeps getting traffic** (until two health checks 30
seconds apart have failed, and the requests it held come back 504 a minute later); **what cross-zone load balancing does
in a zone outage** (on: the surviving nodes keep sending to the dead zone's instances until checks catch them; off: they
never do, but a zone with no instances answers 503); **why a zone's node is still reached for a minute after it is gone**
(clients' 60-second DNS answers); **round robin against least outstanding requests with one slow target**; **blue/green
by target group weights**; and **why a sudden surge can find the ALB itself short** (it scales with the traffic, with a lag;
an LCU reservation pre-warms it).

Each edge out of a load balancer is a target group, carried by a connector of this folder (`Targets.ts`) over the core
target group (`../../fleet/TargetGroup.ts`) with AWS's defaults and ranges. The fleets behind it are the EC2, ECS and EKS
components, or `common.service`, built on `../../fleet/` (its README explains units, zones and the `fleet` protocol).

## Coverage

| Feature | Status | Notes |
| --- | --- | --- |
| **Listener and target groups** | | |
| Each `out` edge a target group | ✅ | Into a fleet: `aws.alb.target-group` / `aws.nlb.target-group`. Into a Lambda function: `aws.alb.lambda-target`. Anything else: an IP target (`aws.alb.ip-target`, `aws.nlb.ip-target`), one address, no health checks. Picked automatically. |
| Weighted target groups (blue/green, canary) | ✅ | ALB `routing: weighted`: each request picks an edge at random by the edges' `weight`, read live. Weights 0 to 1,000 here (AWS: 0 to 999, at most 5 target groups an action, not enforced). All 0: 503. As in AWS, a target group that is empty or all unhealthy is not failed over to another: it keeps its share. |
| Listener rules (path, host) | 🟡 | ALB `routing: rules`: an edge's weight is the share of requests its rule matches; a request's key decides which, so one path (key) always reaches one target group. Conditions themselves are not modelled; `rules` only counts towards LCUs. |
| Target group stickiness (group-level) | 🟡 | `routing: rules` keeps a key on one target group; weighted routing doesn't (no group stickiness cookie). |
| The caller's read or write passed on | ✅ | `request.operation: caller` on every ELB edge: a GET stays a read (a plain link would make it a write). |
| **Target group (into a fleet)** | | |
| Registration as units come up, deregistration as they go | ✅ | Core: one passing check to start, `deregistrationDelay` (300 s) for draining units. |
| Targets in a zone with no load balancer node are unused | ✅ | They get nothing, even with cross-zone on. |
| Health checks: 30 s, 5 s timeout (NLB 10 s), 5 healthy, 2 unhealthy | ✅ | AWS's ranges are hard limits: interval 5 to 300 s, timeout 2 to 120 s, thresholds 2 to 10. Always on for instance and IP targets, as AWS has them. Checks cross the edge (latency, edge faults) and aren't requests. |
| Fail open | ✅ | No healthy target: send to every registered one (ALB and NLB both do). Not a setting. |
| Routing failover per zone (cross-zone off) | ✅ | A zone whose targets are all unhealthy sends to all of them (the default threshold, 1). Thresholds other than the default are not settings. |
| Round robin, least outstanding requests, weighted random | ✅ | ALB `algorithm`. Least outstanding counts the requests this target group has in flight on each target. NLB: a flow hash, fixed. |
| Anomaly mitigation (weighted random) | ❌ | |
| Slow start | ✅ | 30 to 900 s (0 off); a linear ramp. Round robin only (AWS refuses it otherwise; ignored here); 1-29 s counts as 30. |
| Sticky sessions | 🟡 | `stickiness`: a hash of the key over the targets, so a client stays on its target while the targets don't change. A cookie would only move the clients of a target that went away; this moves some others too. Duration not modelled. |
| Cross-zone per target group | ✅ | ALB default on, NLB default off. Off: each node sends only to its zone's targets; a zone with none answers 503 (ALB) or resets (NLB). Crossing zones costs `CROSS_ZONE_MS` each way. |
| Replacing unhealthy targets | ✅ | `replaceUnhealthy` tells the fleet (EC2 with health check type ELB, ECS); the fleet decides. |
| Deregistration delay cut-off | ✅ | A request still on a target when the delay runs out fails: 502. |
| NLB connection termination (unhealthy, deregistration) | ❌ | Established connections to an unhealthy target are not reset. |
| **Responses (ALB)** | | |
| 502 | ✅ | Target refused or closed the connection (dead unit, zone down, cut off at the end of the deregistration delay); any Lambda failure (error, timeout, throttle). |
| 503 | ✅ | No registered target; a request entering an empty zone with cross-zone off; no target group (nothing wired, or all weights 0). |
| 504 | ✅ | Nothing from the target within the idle timeout (60 s, 1 to 4,000 s); the target is not told and keeps working. |
| 460 | 🟡 | The client closed its connection first: counted when the client's edge cancels on timeout (`cancelOnTimeout`). By default a client that times out just walks away and the ALB carries on to its idle timeout. |
| 413 | ✅ | A Lambda target's request body over 1 MB, refused without invoking. |
| The target's own errors | ✅ | Its 500s, its own 503s (a full backlog), 429s and 4xx are passed on and counted as target errors. |
| Connection timeout to a target (10 s, 504) | ❌ | A black-holed target times out at the idle timeout instead. |
| **Responses (NLB)** | | |
| No HTTP errors of its own | ✅ | Whatever the target answered passes through as it is (a refused connection stays `Unavailable`, a 500 stays `Failed`). |
| Resets: no target, idle timeout | ✅ | `Unavailable`. TCP idle timeout 350 s (60 to 6,000 s). |
| **Zones and DNS** | | |
| A node in each enabled zone | ✅ | `zones`: the first N of the region's (ALB at least 2). |
| Clients spread over nodes by DNS, a client stays on its node | ✅ | A request's node follows a hash of its key, by each node's DNS share: one client (a hot key) goes through one node. |
| A zone outage takes its node away | ✅ | Requests reaching it fail at once (`deadNode`). |
| DNS failover, 60 s TTL | ✅ | A zone leaves DNS when its node is down or no target group has a healthy target for it; clients holding an older answer keep using it until it expires, so its share falls linearly over a minute (see Behaviour). All zones unhealthy: every zone whose node is up. |
| Zone Slow and Errors faults on the node | ❌ | They reach the zone's instances (the fleets apply them), not the load balancer's node. |
| Zonal shift, zonal autoshift | ❌ | |
| **Capacity (LCUs)** | | |
| LCU accounting | ✅ | ALB: new connections (25/s), active connections (3,000), bytes (1 GB/h; 0.4 GB/h to Lambda), rule evaluations (1,000/s past the first 10). NLB: 800/s, 100,000, 1 GB/h. Response sizes and idle keep-alive connections aren't known: lower bounds. |
| ALB scaling with a lag | 🟡 | Assumed model (AWS doesn't publish it): starts sized to its first second of traffic, scales towards demand ÷ 0.7 at most doubling a minute, halves at most every ten minutes, never below its minimum (10 LCU, assumed). Requests past capacity are rejected connections. Off with `capacity.model: false`. |
| LCU reservation | ✅ | `capacity.reserved`: at least 100 (1-99 count as 100), at most 15,000 per ALB (quota); the Region's quota is 0 until raised (audited). |
| NLB scaling | ❌ | Unlimited; only its LCUs are measured. |
| **Other** | | |
| Lambda targets | ✅ | Invoked synchronously; the ALB waits for the function (no idle timeout; at most 15 minutes). |
| ALB as an NLB target | ✅ | An NLB edge into an ALB is an `aws.nlb.ip-target`. |
| HTTP/2, gRPC, WebSockets, TLS, authentication, WAF integration, redirects, fixed responses | ❌ | |
| Placement in a VPC | ✅ | Both are VPC resources. |

## Settings

### `aws.alb`

| Setting | Default | Range | Kind | What it models |
| --- | --- | --- | --- | --- |
| `zones` | 3 | 2-6 | hard (min) | Availability Zones with a node: the first N of the region's. |
| `routing` | weighted | weighted, rules | | How a request picks its target group (see Behaviour). |
| `rules` | 0 | 0-100 | quota | Listener rules evaluated a request; past 10 they count towards LCUs. |
| `idleTimeout` | 60 s | 1-4,000 s | hard | `idle_timeout.timeout_seconds`: how long it waits for a target before 504. |
| `overhead` | 1 ms, cv 0.5 | | assumed | The ALB's own processing time. |
| `requestsPerConnection` | 10 | 1-100,000 | assumed | Requests a client sends on one connection: turns the request rate into new connections for LCUs. |
| `capacity.model` | on | | assumed | Model ALB scaling (off: unlimited capacity). |
| `capacity.reserved` | 0 | 0-15,000 LCU | quota | LCU reservation (at least 100). |
| `capacity.minimum` | 10 LCU | 1-1,000,000 | assumed | The capacity it keeps when idle. |
| `capacity.scaleUpPerMinute` | 2 | 1.1-100 | assumed | How much capacity can grow in a minute. |

### `aws.nlb`

| Setting | Default | Range | Kind | What it models |
| --- | --- | --- | --- | --- |
| `zones` | 3 | 1-6 | | Availability Zones with a node. |
| `idleTimeout` | 350 s | 60-6,000 s | hard | TCP idle timeout: a request unanswered this long is reset. |
| `overhead` | 0 | | assumed | The NLB's own time (AWS: "ultra-low", no figure). |
| `requestsPerConnection` | 10 | 1-100,000 | assumed | For NLCUs' new-connection dimension. |

### Target group edges

| Setting | ALB default | NLB default | Range | Kind | What it models |
| --- | --- | --- | --- | --- | --- |
| `weight` | 1 | 1 | 0-1,000 | | The target group's weight in the forward action, or its rule's share of requests. |
| `request.operation` | caller | caller | caller, read, write | | What the request does to the target; `caller` keeps the client's. |
| `request.payload` | 0 | 0 | KB | | Overrides the request's size; 0 keeps it. |
| `algorithm` | round robin | (flow hash) | round robin, least outstanding, weighted random | | `load_balancing.algorithm.type`. |
| `slowStart` | 0 | (none) | 0, 30-900 s | hard | `slow_start.duration_seconds`. |
| `stickiness` | off | (none) | | | `stickiness.enabled` (see Coverage). |
| `crossZone` | on | off | | | `load_balancing.cross_zone.enabled`. |
| `deregistrationDelay` | 300 s | 300 s | 0-3,600 s | hard | `deregistration_delay.timeout_seconds`. |
| `replaceUnhealthy` | on | on | | | Report unhealthy targets to the fleet. |
| `healthCheck.interval` | 30 s | 30 s | 5-300 s | hard | `HealthCheckIntervalSeconds`. |
| `healthCheck.timeout` | 5 s | 10 s | 2-120 s | hard | `HealthCheckTimeoutSeconds` (at most the interval). |
| `healthCheck.healthyThreshold` | 5 | 5 | 2-10 | hard | `HealthyThresholdCount` (a new target needs one pass). |
| `healthCheck.unhealthyThreshold` | 2 | 2 | 2-10 | hard | `UnhealthyThresholdCount`. |

Lambda and IP target edges have `weight` and `request` only.

### Account quotas (per Region)

| Quota | Default | Source |
| --- | --- | --- |
| `elbApplicationLoadBalancers` | 50 | [ALB quotas](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-limits.html) |
| `elbNetworkLoadBalancers` | 50 | [NLB quotas](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/load-balancer-limits.html) |
| `elbReservedAlbLcus` | 0 | [ALB quotas](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-limits.html) |

## Limits

| Limit | Value | Kind | Source |
| --- | --- | --- | --- |
| ALB Availability Zones | at least 2 | hard | [ALBs](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/application-load-balancers.html) |
| ALB idle timeout | 60 s default, 1-4,000 s | hard | [ALB attributes](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html) |
| NLB TCP idle timeout | 350 s default, 60-6,000 s | hard | [NLBs](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/network-load-balancers.html) |
| DNS TTL of a load balancer's records | 60 s | hard | [How ELB works](https://docs.aws.amazon.com/elasticloadbalancing/latest/userguide/how-elastic-load-balancing-works.html) |
| ALB health checks | 30 s interval, 5 s timeout, 5 healthy, 2 unhealthy; Lambda 35 s, 30 s | hard ranges | [ALB health checks](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html) |
| NLB health checks | 30 s interval, 10 s timeout (TCP and HTTPS; 6 s HTTP), 5 healthy, 2 unhealthy | hard ranges | [NLB health checks](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/target-group-health-checks.html) |
| Health check ranges | interval 5-300 s, timeout 2-120 s, thresholds 2-10; always on for instance, IP and ALB targets | hard | [CreateTargetGroup](https://docs.aws.amazon.com/elasticloadbalancing/latest/APIReference/API_CreateTargetGroup.html) |
| Deregistration delay | 300 s, 0-3,600 s | hard | [ALB target groups](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-target-groups.html), [NLB target groups](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/load-balancer-target-groups.html) |
| Slow start | 0 (off), 30-900 s; round robin only | hard | [ALB target group attributes](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-target-group-attributes.html) |
| Stickiness duration | 1 s - 7 days, default 1 day | hard | [ALB target groups](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-target-groups.html) |
| Target group health (DNS and routing failover) | minimum 1 healthy target by default | default | [ALB target groups](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-target-groups.html) |
| Lambda request body and response | 1 MB each | hard | [Lambda targets](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/lambda-functions.html) |
| Target groups per action | 5 | hard | [ALB quotas](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-limits.html) |
| Target group weight in a forward action | 0-999 | hard | [Rule actions](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/rule-action-types.html) |
| Target groups per ALB | 100 | hard | ALB quotas |
| Targets per ALB | 1,000 | quota | ALB quotas |
| Rules per ALB | 100 | quota | ALB quotas |
| NLB targets | 500 per zone (500 per NLB cross-zone), 3,000 per NLB | quota | [NLB quotas](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/load-balancer-limits.html) |
| LCU reservation | at least 100 LCUs; 15,000 per ALB; 0 per Region by default | hard / quota | [Reservations](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/capacity-unit-reservation.html), ALB quotas |
| LCU dimensions | ALB: 25 new conn/s, 3,000 active, 1 GB/h (0.4 GB/h Lambda), 1,000 rule evals/s, 10 rules free. NLB (TCP): 800/s, 100,000, 1 GB/h | hard | [ELB pricing](https://aws.amazon.com/elasticloadbalancing/pricing/) |
| Connection timeout to a target | 10 s (504) | hard, not modelled | [ALB troubleshooting](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-troubleshooting.html) |

Two AWS pages disagree on the ALB health check timeout: the ALB guide says 5 s for instance and IP targets, the
CreateTargetGroup reference says 6 s for HTTP target groups. The ALB guide (and the reference's own example response, 5 s)
is used; 6 s is NLB's HTTP check. On DNS failover with several target groups the ALB guide says both that one unhealthy
target group takes the nodes out of DNS (cross-zone page) and that one healthy target group keeps a zone in (target group
health page); the simulator follows the second, which is the more specific.

## Behaviour

**A request through an ALB.** It picks a target group (an edge): by weight at random, or by its key with `rules`. It
reaches the node in one zone: the client's DNS answer named it (a hash of the key, by each zone's DNS share). A node that
is down fails the request at once (`deadNode`). The ALB counts its cost in LCUs and, if it has no capacity left, rejects
the connection (`rejectedConnections`). After its own processing time it sends the request through the edge, telling the
target group which zone it arrived in, and starts the idle timeout. The target group picks a target (cross-zone off: in that
zone), and the answer comes back, or the idle timeout runs out (504, the target keeps working), or the client goes away
(460, when its edge cancels).

**Mapping failures (ALB).** No target in the target group: 503. A connection refused, reset or cut off: 502 (refused ones
also count as `targetConnectionErrors`). A Lambda function's failure of any kind: 502. A failure whose reason starts with a
status (a full backlog's "503 ...") and any `Failed`, `Throttled` or `Rejected`: the target's own answer, passed on.

**Health and fail open.** Targets that come up register as `initial` and get requests after one passing check. A target
that fails `unhealthyThreshold` (2) checks in a row, `interval` (30 s) apart, gets no new requests; requests sent to it
before then fail as they would (a dead instance: 502 at once; a hung one: 504 an idle timeout later). If no target is
healthy the ALB sends to all of them anyway. So a target that dies right after a check gets requests for up to
`interval × unhealthyThreshold` = 60 s (plus a check timeout, if it hangs rather than refuses).

**DNS.** Each zone's share of new requests is what clients' cached answers hold: an answer is DNS as it was when the
client resolved, some time in the last TTL (60 s). Averaged over that minute, a zone's share is
`(1 / TTL) ∫ [zone in S(τ)] / |S(τ)| dτ`. A zone that leaves DNS (its node down, or no target group with a healthy target
for it) goes from `1/N` to 0 over a minute; the others grow to `1/(N-1)`. Example: three zones, one goes down: 10 s later
its share is `(5/6)/3`, 45 s later `(1/4)/3`, after 60 s nothing. A zone whose node is up but has no targets at all (cross-zone
off) is not failed over by an ALB: it answers 503, as AWS warns about empty subnets. An NLB counts an empty zone as
unhealthy, and takes it out of DNS.

**Cross-zone in a zone outage.** The dead zone's node is gone either way, its share decaying over the TTL. With cross-zone
on, the other nodes also send `1/N` of their requests to the dead zone's targets until their checks fail (502s for up to
60 s). With it off they never do, but each zone's targets carry their own zone's share alone, and when the zone comes back
its node is in DNS before an Auto Scaling group has rebalanced instances into it: requests entering it get 503 meanwhile.

**ALB capacity (assumed).** Demand, measured each second, is the LCU-seconds of the requests that arrived (admitted or not)
plus active connections ÷ 3,000. Capacity starts at demand ÷ 0.7 after the first second (a load balancer that has been
running at this traffic), never below `capacity.minimum` or the reservation; it grows towards demand ÷ 0.7 by at most
`scaleUpPerMinute` a minute (continuously) and shrinks with a ten-minute half-life. Requests are admitted against a bucket
holding one second of capacity: past it, rejected connections. A 10× jump at doubling a minute is turned away in part for
about three minutes; a reservation large enough removes it.

**NLB.** A flow (a key) picks its target group by weight and its target by a flow hash; cross-zone is off by default. It
adds no time of its own (by default) and has no HTTP errors: what the target answered passes through. It resets a
connection with no target and one idle past its timeout (`elb.resets`).

## Connections

- In: anything that calls (clients, CloudFront, API Gateway's HTTP integration, an NLB). The caller's operation is passed on.
- `out` (many): one edge per target group. Into a fleet: the target group connector (health checks, algorithm...). Into
  `aws.lambda` (ALB): `aws.alb.lambda-target`. Into anything else, including an ALB behind an NLB: an IP target. The
  connectors have no timeout or retries of their own: the load balancer doesn't retry.
- The load balancer and its target groups share a small object in the Region (`internal/listener.ts`): the zone each request arrived
  in, the zones the load balancer is in, and each target group's health for DNS. A fleet in another place (a
  `common.service` outside AWS) still works, without zones: the target group then picks a zone among its targets'.

## Metrics and state

ALB node (CloudWatch name in brackets):

| Metric | Kind | Meaning |
| --- | --- | --- |
| `requests` | rate | Requests sent to a target group [RequestCount]. |
| `elb.5xx`, `elb.502`, `elb.503`, `elb.504` | rate | The ALB's own errors [HTTPCode_ELB_5XX_Count, _502_, _503_, _504_]. |
| `elb.4xx`, `elb.460` | rate | 413s and 460s [HTTPCode_ELB_4XX_Count]. |
| `target.5xx`, `target.4xx` | rate | The targets' own errors, passed on [HTTPCode_Target_5XX_Count, _4XX_]. |
| `targetConnectionErrors` | rate | Connections a target refused [TargetConnectionErrorCount]. |
| `rejectedConnections` | rate | Turned away for lack of capacity [RejectedConnectionCount]. |
| `deadNode` | rate | Requests that reached a node whose zone is down (no CloudWatch metric: the node is gone). |
| `lambda.userError`, `lambda.internalError` | rate | Lambda target failures [LambdaUserError, LambdaInternalError]. |
| `processedBytes` | rate | Bytes of the requests taken (requests carry the only sizes; responses have none) [ProcessedBytes]. |
| `targetResponseTime` | distribution | From a request leaving the load balancer to its target's answer, good or the target's own error; not the load balancer's 502, 503, 504 [TargetResponseTime]. |
| `activeConnections` | gauge | Requests in flight [ActiveConnectionCount, approximately]. |
| `healthyHosts`, `unhealthyHosts` | gauge | Targets passing and failing health checks, summed over the target groups [HealthyHostCount, UnHealthyHostCount]. |
| `capacity.lcu`, `consumed.lcu`, `peak.lcu`, `reserved.lcu` | gauge | Capacity, last second's demand [ConsumedLCUs], the most so far [PeakLCUs], the reservation [ReservedLCUs]. |
| `capacityUtilization` | gauge | Demand over capacity, 0-1 [CapacityUtilization]. |
| `zones.inDns` | gauge | Zones DNS answers with [HealthyStateDNS, roughly]. |

NLB node: `requests` [NewFlowCount], `elb.resets` [TCP_ELB_Reset_Count], `target.resets` (refused or reset by the target,
passed on) [TCP_Target_Reset_Count], `client.resets` [TCP_Client_Reset_Count], `deadNode`, `processedBytes`
[ProcessedBytes], gauges `activeFlows` [ActiveFlowCount], `consumed.lcu` [ConsumedLCUs], `peak.lcu`, `zones.inDns`
[ZonalHealthStatus, roughly], `healthyHosts`, `unhealthyHosts` [HealthyHostCount, UnHealthyHostCount, summed over the
target groups].

Target group edge (with the edge's own `calls`, `ok`, `fail`, `latency`, `inflight`): `targets.healthy`, `targets.unhealthy`,
`targets.initial`, `targets.draining` [HealthyHostCount, UnHealthyHostCount], `noTarget`, and `requestCountPerTarget`
[RequestCountPerTarget]: requests a minute per healthy target (per registered target when none is healthy), at the
current rate, in AWS's unit (a target value of 1,000 means 1,000 requests a minute per target).

Lambda target edge: `processedBytes` [LambdaTargetProcessedBytes]; its LambdaUserError and LambdaInternalError are the
edge's own `fail.*` (an `Unavailable` is internal, anything else the function's). IP target edges record nothing beyond
transport's.

Dashboards (`internal/dashboard.ts`): the ALB's requests and rejected connections, its own errors and its targets', target response
time, healthy hosts, LCUs against capacity and reservation, capacity utilization, active connections, processed bytes and
zones in DNS; the NLB's new and active flows, resets, healthy hosts, bytes, LCUs, zones and connection time; each target
group's target health (and, for an ALB, RequestCountPerTarget) and requests with no target; a Lambda target's errors and bytes.

**Scaling a fleet on RequestCountPerTarget.** A target-tracking controller reads its own node's metrics, so it watches the
fleet, not the edge: the requests a fleet receives are the requests its target group sent. `aws.ec2` publishes
`requestCount` (a minute's requests) and `requestCountPerTarget`; track `requestCount` per unit with AWS's target value
(ALBRequestCountPerTarget 1,000 is `{ metric: requestCount, per: unit, targetValue: 1000, setting: desiredCapacity }`).
On any fleet, `in` per unit is the same per second (target value ÷ 60).

Probes: the ALB reports its zones (in DNS, share, node up), capacity, consumed, peak and reserved LCUs, requests in flight,
running totals (requests, 502, 503, 504, 4xx, target 5xx, rejected connections) and each edge's kind (fleet, lambda,
address). The NLB reports zones, LCUs, flows and resets. A target group edge reports each target's health and requests
outstanding (the core target group's state).

## Not yet simulated

1. **One unit hanging.** A unit that crashes is the `Crash` fault on its fleet's node (`Crash(1)`: calls on it fail, and the
   target group's checks catch it); one that hangs (accepts calls and never answers) still has no fault of its own, so a
   zone slowdown stands in for it.
2. **Connection timeout to a target (10 s, 504).** A black-holed target waits out the idle timeout instead; it would need the
   transport to say when a call has arrived.
3. **Target group health thresholds** (`target_group_health.*`: a count or percentage for DNS and routing failover) as
   settings; today the default (1 healthy target) is built in.
4. **NLB connection termination** for unhealthy targets (on by default) and deregistered ones (off): resetting the requests in
   flight on them. Needs the core target group to track a target's requests, not only their count.
5. **Anomaly mitigation** (weighted random): the ALB's own detection of targets with high error rates. A per-target error
   ratio in the core target group and a weight cut every 5 s.
6. **Group-level stickiness and cookie stickiness proper** (keep a client's target until it goes, instead of a hash).
7. **Zone faults other than outages on the nodes** (Slow, Errors); zonal shift and autoshift.
8. **NLB scaling and NLCU reservations**; UDP, TLS listeners.
9. **ALB features with no load story yet**: authentication, redirects, fixed responses, HTTP/2 and gRPC, WebSockets,
   mutual TLS, WAF (a WAF node in front works today).
10. **Lambda targets' 1 MB response limit** (502): responses have no size in the simulator.

## Assumptions

| Number | Value | Why |
| --- | --- | --- |
| Node failure detection for DNS | immediate | AWS publishes no timing for its zonal health checks; the 60 s TTL is what clients see. |
| How clients use DNS answers | evenly over the addresses, resolved uniformly over the last TTL | Many clients and resolvers that honour the TTL. |
| A client stays on one node | by its key | Keep-alive connections; one client is one key. |
| ALB processing time | 1 ms (cv 0.5) | Not published (the access log's request and response processing times); a small number beside the network. |
| NLB processing time | 0 | "Ultra-low latency"; the edges' network is the cost. |
| Requests per connection | 10 | Clients mostly reuse connections; only matters for LCUs and ALB capacity. |
| ALB scaling | starts sized to its first second; target utilisation 0.7; doubles at most a minute; halves at most every 10 min; minimum 10 LCU; a second of burst | AWS publishes LCU dimensions, not scaling behaviour. |
| A dead target refuses at once | connection refused | As the fleet core has it; a host that is gone and drops packets is a `Blackhole` on the edge. |
| Sticky sessions as a flow hash | | See Coverage. |

## References

- [What is an Application Load Balancer?](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/introduction.html)
- [Application Load Balancers](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/application-load-balancers.html) and [editing their attributes](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html)
- [Target groups for ALBs](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-target-groups.html), [their attributes](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-target-group-attributes.html), [health checks](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html)
- [Listener rule actions](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/rule-action-types.html) (weighted forward actions)
- [Lambda functions as targets](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/lambda-functions.html)
- [Troubleshoot your ALBs](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-troubleshooting.html)
- [CloudWatch metrics for ALBs](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-cloudwatch-metrics.html)
- [ALB quotas](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-limits.html), [LCU reservations](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/capacity-unit-reservation.html)
- [Network Load Balancers](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/network-load-balancers.html), [their target group attributes](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/edit-target-group-attributes.html), [health checks](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/target-group-health-checks.html), [quotas](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/load-balancer-limits.html)
- [How Elastic Load Balancing works](https://docs.aws.amazon.com/elasticloadbalancing/latest/userguide/how-elastic-load-balancing-works.html)
- [CreateTargetGroup](https://docs.aws.amazon.com/elasticloadbalancing/latest/APIReference/API_CreateTargetGroup.html)
- [Elastic Load Balancing pricing](https://aws.amazon.com/elasticloadbalancing/pricing/) (LCU dimensions)
