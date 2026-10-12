# Fleets and load balancers (`fleet/`)

The engine's model of a **fleet of identical units** (EC2 instances in an Auto Scaling group, ECS tasks, Kubernetes pods,
a Deployment's replicas) and of a **load balancer's target group** in front of one. It is provider-neutral: it has no
settings and no AWS numbers of its own. A service component (EC2 Auto Scaling, ECS, EKS, `common.service`) builds a
`Fleet` in its `make` and decides which of its numbers are settings; a load balancer component (ALB, NLB) puts a target
group on the edge to the fleet and keeps only listener-level behaviour for itself.

| File | What it is |
| --- | --- |
| `Fleet.ts` | The fleet: units, their life, zones, desired capacity, scale-in and draining, replacement, interruptions, and the two ways calls reach units. |
| `Unit.ts` | Its pieces: `Member` (a unit as the fleet keeps it), `Ticket` (one call's place on the fleet), `Job` (what the component does with a call), `Line`. |
| `TargetGroup.ts` | A load balancer's target group: registration, health checks, choosing a unit per call (round robin, least outstanding requests, random, flow hash), slow start, cross-zone, fail open, deregistration delay. |
| `../connectors/TargetGroup.ts` | `core.target-group`, the connector that puts a `TargetGroup` on an edge. |
| `../Protocol.ts` (`fleet`) | What a fleet offers the connector on an edge into it: `Fleet`, `Unit`, `UnitChange`, `HealthAnswer`. |
| `Hosts.ts` | Units placed on hosts: a `HostPool` over a fleet of hosts, which a fleet of tenants uses as its `Options.hosts` (ECS tasks on container instances, pods on nodes). See **Units on hosts** below. |
| `Rollout.ts` | A rolling replacement of a fleet's units by a new version within min-healthy and max-total bounds (ECS deployments, Kubernetes rolling updates, instance refresh). See **Rolling replacement** below. |
| `testing.ts` | The worked example below as real code (`test.workers`, `test.balancer`), and `sim` for tests that use them. |
| `Fleet.test.ts`, `TargetGroup.test.ts` | Behaviour tests (zones, draining, quotas, interruptions, health checks, algorithms, slow start, cross-zone). |

## A unit's life

```
 requested ──▶ starting ──▶ grace ──▶ inService ──▶ draining ──▶ terminated
 (capacity,    (phases:     (up and    (up and       (no new calls,
  a zone)       launch,      serving;   serving)      finishes what it
                boot, ...)   health                   holds, then goes)
                             reports
                             ignored)
```

- **requested**: waiting for capacity (an account quota through `Options.capacity`) or a zone that is up. Retried after
  `capacity.retryMs` and whenever zones change.
- **starting**: through the `phases` the component gives it, each a timer (0 ms phases are skipped). A unit whose zone goes
  down while it starts simply failed to launch: it is terminated at once and launched again elsewhere.
- **grace**: up and serving, but bad health reports are ignored until it ends (Auto Scaling's and ECS's health-check grace
  period). What was reported meanwhile is acted on when it ends.
- **inService**: up and serving.
- **draining**: let go (scale-in, replacement, an interruption). Takes no new calls; finishes the ones it holds; stops as soon
  as it holds none, or is cut off when its drain time runs out (the calls still on it fail with `Unavailable`). A load
  balancer can keep it longer (`holdDraining`, its deregistration delay); an interruption's notice can't be extended.
- **terminated**: gone; its account capacity is given back and balancers forget it.

A unit can also **die** while serving (its zone goes down, or the component calls `fleet.kill(unit)`): it answers nothing,
the calls on it fail at once, and it stays in its state until someone notices: the fleet itself after `Options.detect`, or a
balancer's health checks (`report`). Then it is terminated and replaced. Gauges never count a dead unit as serving.

The fleet exists before the simulation starts: its first `desired` units begin **in service**, in their zones, with no
start-up, as a load balancer's first targets begin healthy.

## Building a component on it

```ts
const fleet = new Fleet(node, {
  desired: () => fast.settings().desired,                         // a setting, so an autoscaler can drive it
  zones: () => node.zones.all.slice(0, fast.settings().zones),     // spread over the first N zones of the region
  phases: () => [{ name: "launch", ms: 30_000 }, { name: "boot", ms: 20_000 }],
  grace: () => 300_000,
  workers: () => fast.settings().workersPerUnit,
  line: () => fast.settings().queueLimit,    // plain calls: one line in front of the fleet
  backlog: () => fast.settings().queueLimit, // calls a balancer addressed to a unit: one line per unit
  drain: () => 30_000,
  detect: () => 60_000,                      // the fleet notices a dead unit by itself after a minute
  capacity: { take, give, retryMs: 10_000 }, // an account quota: refuse launches past it
  name: (id) => `i-${id}`
})
```

Calls reach units two ways, and a component handles both with one handler:

```ts
const handle = (message: Message, unit: Unit | undefined): Call =>
  Effect.callback((resume) => {
    let timer: TimerHandle | undefined
    const job: Job = {
      // A worker on `ticket.unit` is yours.
      start: (ticket) => {
        timer = fast.after(serviceMs, () => {
          ticket.release() // the worker is free (do this before calling downstream, if you call downstream)
          ticket.finish()  // the call is over
          resume(Effect.void)
        }, undefined)
      },
      // Its unit was lost (zone down, cut off at the end of a drain, an injected zone error): the ticket is finished.
      fail: (failure) => {
        timer?.cancel()
        resume(Effect.fail(failure))
      }
    }
    const admitted = fleet.admit(job, unit)
    if (typeof admitted === "string") {   // refused: the line or the unit's backlog is full, or the unit is gone
      resume(Effect.fail(Unavailable({ node: node.id, reason: admitted })))
      return Effect.void
    }
    return Effect.sync(() => { timer?.cancel(); admitted.finish() })  // the caller gave up
  })

return {
  call: (message) => handle(message, undefined),                      // a plain edge: the idealised balancer
  fleet: fleet.offer((unit, message) => handle(message, unit)),        // a target group picks the unit
  probe: Effect.sync(() => ({ units: fleet.snapshot() }))
}
```

and declares itself a fleet (`fleet: true` in `Component.make`), so a target group can be wired to it. Tell the fleet when
settings change, so it reconciles (launches, scales in, re-reads workers):

```ts
yield* node.spawn(SubscriptionRef.changes(node.config).pipe(Stream.runForEach(() => Effect.sync(() => fleet.refresh()))))
```

`testing.ts` has this whole component (`Workers`, with a quota, Spot-like interruptions and one deliberately slow unit),
and `../common/Service.ts` is the production one: it does its work, then calls downstream while still on its unit
(`release` after its own part, `finish` when downstream answers). On a busy path write the job as a small class, as
`Service.ts`'s `Request` is (its methods are `Job`'s, its timer callback is a module-level function given the request as
its argument): one object a call instead of a handful of closures, which is what kept `common.service` as cheap as before
it was built on the fleet.

### The two ways in

- **A plain call** (`admit(job)`) waits in the fleet's one line (limit `line`) and runs on the first unit with a free
  worker, units taking turns. This is an idealised balancer: it knows at once which units are dead and never sends them
  anything. It is what a client calling a service directly gets, and `common.service` behaves exactly as before it was
  built on the fleet (the cluster and retry-storm examples' scenarios give bit-identical results).
- **A call addressed to a unit** (`admit(job, unit)`, from `Offer.serve`) runs on that unit or waits in its own backlog
  (limit `backlog`). A dead or terminated unit refuses it (`REFUSED_UNIT_GONE`, "connection refused"): what a load balancer
  that hasn't noticed yet runs into.

A unit's free worker takes from its own backlog first, then (if it is serving) from the fleet's line.

### Zones

`Options.zones()` is the list to spread over: usually the first N of `node.zones.all`, the zones of the node's region
(`us-east-1a`..., or `eu-west-a`... for places outside any cloud). Then:

- **Launches go to the zone with the fewest units** among those that are up (ties: the first in the list).
- **A zone that goes down** (an `Outage` on `zone:<placement>:<zone>`) takes its units with it: they die, their calls fail,
  units still starting there are relaunched elsewhere at once. Once noticed, the dead are replaced in the other zones.
- **When it comes back**, the fleet rebalances as EC2 Auto Scaling's AZRebalance does: it launches one extra unit in the
  emptiest zone and, when that one is up, drains one from the fullest; again, until no zone has two more than another. New
  before old, so the fleet is never short while it rebalances (it may run one over `desired`, as Auto Scaling may).
- **Scale-in** takes from the zone with the most units, so zones stay even.
- **A slow or failing zone** (`Slow`, `Errors` on a zone) slows or fails the calls its units run: the fleet delays the start
  of the work by the extra latency, and fails the given share (`Failed`, "injected error"). The region's faults reach the
  node itself through the node's guard, like any node's.

`node.zones.watch` tells the fleet when faults change; it checks its own zones (at most six lookups) and acts only on a change.

### Desired, minimum, maximum, capacity

`desired()` is clamped to `min()` and `max()`. Each launch first asks `capacity.take()`; refused, the unit waits as
`requested` and is tried again after `retryMs`. Termination gives the capacity back (`give`). Use it for an account quota
shared by several fleets (EC2's On-Demand vCPUs, Fargate's tasks) through `node.shared`, and count in units of what the
quota counts (vCPUs per instance type).

### Scale-in

Units not yet started go first (newest first), then serving ones from the zone with the most, the newest (Kubernetes'
choice, and the default) or the oldest (`scaleIn: () => "oldest"`). They drain for `drain()`. A component with a rule
of its own passes `pick`: it is given the fullest zone's serving, unprotected units (oldest first) and answers the one to
let go, or `undefined` to leave it to `scaleIn` (EC2 Auto Scaling's termination policies use it: the purchase option out
of proportion first, then the instance closest to its next billing hour). Rebalancing uses the same choice.

### Health and replacement

- `detect()`: how long until the fleet notices a dead unit by itself (Kubernetes' node controller, EC2 status checks).
  `Infinity` or absent: never by itself.
- `report(unit, healthy)` (from a balancer, see below): an unhealthy report gets an in-service unit replaced if
  `replaceUnhealthy()` (default true); in its grace period, when the grace ends.
- `setHealthy(unit, false)`: the unit is up but its health endpoint fails (an application that is wedged). Balancers'
  checks find it; it still runs what reaches it. Use it to model application-level failures.
- `kill(unit)`: the unit dies (a crash, an instance retired).

### Interruptions

`interrupt(unit, noticeMs)` gives a unit notice, as Spot does (two minutes) or Fargate Spot: it stops taking new calls at
once, a replacement is launched at once, and it is cut off when the notice runs out. `Options.interruptions` makes them
happen at random (a Poisson process at `perUnitHour` for each serving unit, from the fleet's own seeded stream).

### Gauges

The fleet keeps counts; a component registers the gauges it wants (names are its contract with autoscalers and people):
`fleet.count[state]`, `fleet.serving` (alive, in grace or in service), `fleet.pending` (requested + starting), `fleet.busy`
(workers busy), `fleet.waiting` (in the line and in backlogs), `fleet.utilization` (busy over serving workers),
`fleet.servingIn(zone)`, and `fleet.totals` (launched, terminated, replaced, interrupted, refused launches, lost calls).
`common.service` maps them to `ready`, `starting`, `busy`, `queued`, `utilization`, `draining` and `ready.<zone>`.

An autoscaler that tracks busy workers per unit should divide by `desired` (the setting), which counts units still starting
as idle; that is what keeps target tracking from overshooting while units start.

## Units on hosts (`Hosts.ts`)

ECS on EC2 and EKS run units on other units: tasks on the container instances of an Auto Scaling group, pods on the nodes
of a node group. That is two fleets and a `HostPool` between them; each fleet stays an ordinary `Fleet`.

```ts
let pool: HostPool | undefined
const instances = new Fleet(node, {
  desired: () => group.desired, phases: () => [...], workers: () => 0, line: () => 0, backlog: () => 0, // hosts serve nothing
  drain: () => 15 * 60_000,                       // a draining host waits this long for its tenants to leave
  protect: (u) => pool!.occupied(u),              // managed termination protection: only empty hosts are scaled in
  ...
})
pool = new HostPool(instances, { room: () => ({ cpu: 2, memory: 8192, slots: 29 }), strategy: () => "binpack", now: fast.now })
const tasks = new Fleet(node, { ..., hosts: pool.tenants({ demand: () => ({ cpu: 0.5, memory: 1024 }), spread: () => "zones" }) })
```

- **Placement.** Before a tenant launches (after the account's `capacity`), the pool finds it a host with room for its
  `demand` (CPU, memory, a slot). Zones come first: the fleet passes its zones that are up, the one with the fewest of its
  units first; `spread` is `zones` (best effort, ECS's default spread over AZs and Kubernetes' ScheduleAnyway), `strict`
  (only the emptiest zones: maxSkew 1 with DoNotSchedule) or `none`. Within a zone the `strategy` picks the fullest host
  that fits (`binpack`, Kubernetes' MostAllocated) or the emptiest (`spread`, LeastAllocated). The tenant lives in its
  host's zone. No room: it stays `requested` (PROVISIONING, Pending) until the pool tells its fleet room was made
  (`Fleet.retry`): a host came up, a tenant left one, a host was uncordoned.
- **A host's life reaches its tenants.** The pool `observe`s the host fleet (which, unlike a balancer, hears of deaths):
  up, its room is offered; **draining** (scaled in, interrupted), it is cordoned and its tenants are evicted (each
  `Fleet.stop`ped: drains while a replacement is placed elsewhere), and the host waits for them (`Fleet.hold` per tenant)
  until its own drain runs out; **dead**, its tenants die too (their fleet notices after its `detect`); **gone**, whatever
  is still on it is cut off and replaced.
- **What an autoscaler needs.** `occupied(host)` (scale-in protection), `cordon(host)`, `evict(host)`, `evacuable(host)`
  (would its tenants fit on the other hosts: the check a cluster autoscaler makes before removing a node),
  `HostPool.perHost(room, demand)` (tenants a new host adds), `totalsNow()` (room and requests over the live hosts:
  ECS's CPUReservation, Kubernetes' requested share), `hostOf(tenant)`.

What it added to `Fleet` (all optional, existing fleets unchanged): `Options.hosts`, `Options.protect` (scale-in
protection), `Options.rebalance` (off for Kubernetes, which never moves running pods), `capacity.take(unit)`/`give(unit)`
told which unit (Fargate and Fargate Spot take from different quotas), and `observe`, `retry`, `stop(unit)` (let one unit
go: lower `desired` first to remove it, or leave it to have it replaced), `hold`/`unhold`. Rebalancing also gives up when its
extra unit could only be placed in a zone no emptier than the rest. `Hosts.test.ts` covers binpack and spread, pending until a
host comes up, strict zone spread, a dead host's tenants, eviction from a draining host with nothing lost, and protection.

## Rolling replacement (`Rollout.ts`)

ECS deployments (`minimumHealthyPercent`, `maximumPercent`), Kubernetes rolling updates (`maxUnavailable`, `maxSurge`)
and EC2 instance refresh are one algorithm: replace every unit of an old version, with at most `maxTotal(desired)` live
and at least `minHealthy(desired)` healthy. Give the fleet `desired: () => rollout.target()`, stamp units with
`rollout.stamp(unit)` in `phases`, and call `rollout.step()` when settings change. Each step names the old units it stops
(`Fleet.stop`, never scale-in's choice) and launches new ones into the room left; a new unit is healthy once up for
`healthyAfter` (ECS: 40 s after RUNNING) and passing `ok`. `replaceInKind` (Kubernetes) makes a lost old unit come back
old, as its ReplicaSet recreates it, and bounds old units' removal by every unit less the minimum less new units not yet
available, as the Deployment controller does. `Rollout.test.ts` covers both bounds, a configuration that can't move, a
desired count changing mid-rollout, and replacement in kind.

## Load balancers: the `fleet` protocol and the target group

A fleet's node offers its units (`Instance.fleet`, a `Protocol.Fleet`): `each` unit that is up or draining, `watch` for units
coming `up`, starting to drain and `gone` (a unit **dying** is not announced: a balancer finds out as a real one does),
`check` a unit as a health check would, `serve` a call on a unit, `report` health, `holdDraining`.

A connector whose `to` end is `{ protocol: "fleet" }` gets that offer as `ctx.target`, picks a unit per call, and sends the
call through the edge's transport addressed to it: `ctx.sink.call(message, policy, done, unit, extraMs)`. So latency, the
edge's faults and the edge's metrics apply as on any edge, and the node's guard applies the node's own faults and metrics,
then runs the call with the fleet's `serve`. Health checks go through `ctx.sink.ping(answer, timeoutMs, done)`: the same
transport and faults, none of the metrics.

The registry picks connectors as before (`Connector.pick`): a fleet accepts `invoke` and also `fleet` (`Query.to.also`), and
`core.link` is registered before `core.target-group`, so a plain edge into a fleet stays a plain call and gets the idealised
balancer. An edge gets a target group when the document names it (`connector: core.target-group`) or when a more specific
connector fits: a load balancer registers its own, naming its component, e.g.

```ts
import * as Group from "../../fleet/TargetGroup.ts"
import { shapeCall } from "../../connectors/Link.ts"

export const AlbTargetGroup = Connector.make({
  type: "aws.elb.target-group",
  provider: "aws",
  title: "Target group",
  from: { protocol: "invoke", component: "aws.alb" },   // more specific than core.link: picked for ALB → fleet edges
  to: { protocol: "fleet" },
  config: Schema.Struct({
    weight: Edge.Policy.fields.weight,
    request: Edge.Policy.fields.request,
    timeout: Edge.Policy.fields.timeout,               // redeclare it for the listener's idle timeout, if that is the rule
    cancelOnTimeout: Edge.Policy.fields.cancelOnTimeout,
    ...Group.fields({ healthCheck: { interval: "30 seconds", timeout: "5 seconds", healthyThreshold: 5, unhealthyThreshold: 2 }, deregistrationDelay: "300 seconds" })
  }),
  state: Group.State,
  make: (ctx) => Effect.sync(() => {
    const group = new Group.TargetGroup({ to: ctx.to, fleet: ctx.target, sink: ctx.sink, fast: ctx.fast, meter: ctx.meter }, shapeCall)
    return { send: (m, done) => group.send(m, done), probe: Effect.sync(() => group.status()) }
  })
})
```

`../connectors/TargetGroup.ts` is the same thing with generic defaults: copy it.

An ALB → Lambda edge then stays a plain link (Lambda is not a fleet), which is right: ALB can target functions.

### What the target group does (`TargetGroup.ts`)

| Behaviour | How |
| --- | --- |
| Registration | Units `up` register as `initial` and get requests once they pass one check, whatever the healthy threshold (as an ALB's do); units there at the start are `healthy`. `draining` units are deregistered (no new requests) and kept at least `deregistrationDelay` unless they finish first; `gone` units are forgotten. |
| Health checks | Per target every `interval`, through the edge, given up after `timeout` (at most the interval). `unhealthyThreshold` failures in a row: unhealthy; `healthyThreshold` passes: healthy. A dead unit gets requests (which fail: 502 at the listener) until its checks catch it. |
| Replacement | With `replaceUnhealthy`, the fleet hears of unhealthy targets (`report`), as an ECS service or an Auto Scaling group with ELB health checks does. |
| Algorithms | `round-robin`; `least-outstanding` (its own count of requests sent and unanswered, ties taking turns); `random`; `flow-hash` (the message's key: one key, one target, while the set doesn't change). |
| Slow start | A target that just became healthy gets a share growing linearly to a full one over `slowStart` (smooth weighted round robin; weights also bias the other algorithms). |
| Zones | A request reaches the balancer in one of the zones that have targets in the pool, or in the zone the balancer names (`send(message, done, arrival)`: an ELB load balancer models its own nodes and DNS). Cross-zone off: it is sent only to targets there; with a named zone, to that zone's healthy targets, or all its registered ones when none is healthy (routing failover), or nowhere (503) when it has none. A target in another zone costs `CROSS_ZONE_MS` (0.5 ms, assumed) each way. Targets in a zone the balancer has no node in (`Context.zones`) are unused: they get nothing, even cross-zone. `healthyIn(zone)` and `registeredIn(zone)` count targets, for a balancer's DNS failover. |
| Fail open | With no healthy target at all, send to every registered one (as ALB and NLB do); otherwise a request finds no target and fails at once with `NO_HEALTHY_TARGETS` (no network). |
| Metrics | Edge gauges `targets.healthy`, `targets.unhealthy`, `targets.initial`, `targets.draining`; counter `noTarget`; probe lists each target's health and outstanding requests. |

Requests carry the edge's `timeout` and are never retried (a load balancer doesn't retry a request). What a listener makes of
failures is the load balancer component's business; `testing.ts`'s `Balancer` shows the mapping: `isNoTarget(failure)` →
503, `Timeout` → 504, anything else (connection refused, reset, a target's 5xx) → 502. A target that answers 503 itself (its
backlog full: `Unavailable` with reason `Fleet.REFUSED_UNIT_BUSY`) is a response an ALB passes on, not a 502; a listener that
cares can tell it by the reason.

## For the services built on this

- **EC2 Auto Scaling** (`aws.ec2`): a `Fleet` with phases (pending: launch; boot; application start), the
  group's MinSize, MaxSize and DesiredCapacity (desired as a setting, so `core.target-tracking` drives it), the health-check
  grace period, `detect` as EC2 status checks, `replaceUnhealthy` for HealthCheckType ELB, `capacity` against the regional
  On-Demand vCPU quota (shared with `node.shared`, counted in the instance type's vCPUs), Spot interruptions with a two-minute
  notice, the default termination policy (zones first: built in), warm pools and instance refresh as further work.
- **ELB** (`aws.alb`, `aws.nlb`): the listener component (its own LCU or connection limits, 502/503/504) with an invoke port
  for targets, and its own connector over `TargetGroup` with AWS's defaults. Checked for this README (Oct 2026): ALB targets
  are checked every 30 s with a 5 s timeout, 5 passes and 2 failures (a new target needs one pass), fail open, a 300 s
  deregistration delay (0-3600), slow start 30-900 s (0 is off), algorithms round robin (default), least outstanding requests
  and weighted random
  ([health checks](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html),
  [target groups](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-target-groups.html));
  an NLB keeps a flow on one target and has cross-zone off by default
  ([NLB](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/network-load-balancers.html)). Check NLB's health
  check defaults yourself; ALB's per-zone DNS and routing failover thresholds are not modelled (a zone with no healthy
  target leaves the pool, and the whole group fails open).
- **ECS** (`aws.ecs`, built: `aws/ecs/`): a `Fleet` of tasks; phases (provisioning, activating: the image pull, starting),
  the desired count, `healthCheckGracePeriodSeconds` as `grace`, rolling deployments and the circuit breaker on `Rollout`,
  the Fargate vCPU quotas and launch rate through `capacity`, Fargate Spot interruptions; on EC2, the tasks on a host pool
  over the capacity provider's instances, with managed scaling.
- **EKS** (`aws.eks`, built: `aws/eks/`): pods on a host pool over the node group's nodes; readiness as a start-up phase,
  `detect` as the node controller's grace period plus the eviction toleration (5 min 50 s), rolling updates on `Rollout`
  in kind, and the Cluster Autoscaler or Karpenter adding nodes for Pending pods.

## Seeing faults, and reaching the far end

Two engine APIs sit beside the fleet and are documented in `SIMULATOR.md` ("Faults", "Edges"):

- `node.faults` (`own()`, `zone()`, `active()`, `watch`) lets a component see the faults that reach it, and
  `handlesZoneFaults: true` keeps the engine from refusing its calls when the zone its node is placed in goes down, so a
  Multi-AZ resource (a database with a standby, a cache with replicas, a search domain across zones) can fail over and keep
  serving. A fleet doesn't need either: its node has no zone, and it watches its units' zones through `node.zones`.
- `Instance.offer` (read as `ctx.offer()` by the connectors on edges into the node and as `link.offer()` by its callers)
  and `ctx.shared(key, build)` (a resource shared with the nodes of the target's placement) let a connector reach its
  target's state without a side channel. The fleet's own offer is the typed `Instance.fleet`.

## Pitfalls

- **Call `fleet.refresh()` when settings change**, or new `desired` values and worker counts apply only at the next launch.
- **Release before calling downstream** if a unit's worker is free while it waits (an event loop); call `finish` when the
  call is answered. A ticket that is never finished keeps its unit draining until it is cut off.
- **`Job.fail` comes with the ticket already finished**: don't finish it again (it is safe, but pointless), and cancel your
  own timers.
- **`admit` may call `job.start` before it returns** (a free worker): keep what `start` needs in the job, not in the ticket
  variable.
- **Units are only valid with their own fleet**: `serve(unit)` from another fleet's offer is refused.
- **Determinism**: the fleet draws randomness only from its own forked stream (`fork("fleet")`), and only for random
  interruptions and zone error rates, so a fleet adds no draws to its node's stream.
- **Cost**: per call, one `Ticket` and O(1) work; least outstanding requests scans the pool (about 1 µs more a request at
  500 targets); events (launch, health change, drain) are O(units). A 500-unit fleet at 5,000 requests a second costs about
  7 µs a request end to end, like a plain service.

## Assumptions

| Number | Value | Why |
| --- | --- | --- |
| Cross-zone latency | +0.5 ms one way | AWS: zones up to ~100 km apart with single-digit millisecond latency; 100 km of fibre is 0.5 ms. |
| Zones of a place outside any cloud | 3 (`eu-west-a`...) | So a self-hosted fleet can spread over failure domains; most cloud regions have three. |
| `core.target-group` defaults | 10 s interval, 5 s timeout, 3/3 thresholds, 30 s deregistration delay, round robin, cross-zone on, fail open | A generic balancer; a provider's own target group brings its published defaults. |
| Capacity retry | 10 s | How often a refused launch is tried again unless the component says. |
| Slow start floor | 1% of a share | A target at the very start of slow start still gets a request now and then. |
| A dead unit refuses at once | connection refused | A unit whose host is gone more often times out; that is a `Blackhole` on the edge, if you want it. |
