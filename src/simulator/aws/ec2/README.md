# EC2 Auto Scaling (`aws.ec2`)

An Amazon EC2 Auto Scaling group runs identical EC2 instances across a region's Availability Zones and keeps their number
at a desired capacity between a minimum and a maximum size: it launches instances when the capacity rises or one is lost,
terminates them when it falls, and replaces the ones its health checks find unhealthy. What makes a group interesting is
that **it takes minutes to grow**: an instance goes pending, boots, runs its user data and starts its application before it
serves, so a surge that outruns launch time shows up as errors, and a warm pool, Capacity Rebalancing or a lower CPU target
are the ways out. This component lets you see that, and what the group does when a zone fails, Spot capacity is reclaimed,
a launch template is broken, or the account's vCPU quota runs out.

The group is built on the engine's fleet core (`../../fleet/Fleet.ts`): each instance is a unit with a zone, a life and
workers (its vCPUs). Requests reach it through a plain edge (the fleet's idealised balancer) or, instance by instance,
through a target group (`connector: core.target-group`, or a load balancer's own connector).

| File | What it holds |
| --- | --- |
| `Ec2.ts` | The component: the fleet's options, the request handler, gauges and probe |
| `config.ts` | The settings schema |
| `instanceTypes.ts` | The instance type catalog (vCPUs, memory), also for ECS capacity providers and EKS node groups |
| `vcpus.ts` | The region's vCPU ledger against the On-Demand and Spot quotas, shared through `node.shared` (and with ECS and EKS on EC2) |
| `warmPool.ts` | The warm pool |
| `spot.ts` | The On-Demand/Spot split, Spot interruptions and Capacity Rebalancing |
| `termination.ts` | The termination policies |
| `metrics.ts` | The CPU and request-count metrics target tracking scales on |
| `limits.ts` | Named constants with their sources |
| `quotas.ts`, `audit.ts` | The account's EC2 quotas, and checks of a design against them |

## Coverage

| Feature | Status | Notes |
| --- | --- | --- |
| **Instances** | | |
| Instance types (vCPUs, memory) | ✅ | t3, m5, m6i, m7i, m7g, c6i, c7i, c7g, r6i, from AWS's Instance Types guide. vCPUs × requests per vCPU are an instance's workers. |
| Graviton versus Intel per-vCPU speed | ❌ | A request costs the same service time on any vCPU. AWS publishes no comparable figure. |
| Burstable T3 CPU credits | ❌ | T3 launches in `unlimited` mode by default, which never throttles (surplus credits are billed), so the simulator's T3 is never slowed. Standard mode (credits running out) is not modelled. |
| Launch phases: pending, boot, user data, application start | ✅ | Each a setting; AWS publishes none of these, so all are assumptions (about three minutes in all by default). |
| Health check grace period | ✅ | 300 s (the console's default; 0 from the CLI/SDK). Health reports during it count when it ends. |
| Default instance warmup | ✅ | Instances in warmup are left out of the CPU average. Not set by default in AWS, where policies then use the 300 s default cooldown: the simulator's default. |
| Instance refresh, launch template versions | ❌ | Changing the instance type applies to every instance at once. |
| Lifecycle hooks | ❌ | Fold their time into the launch phases. |
| **Capacity** | | |
| MinSize, MaxSize, DesiredCapacity | ✅ | Desired is clamped to the size; a target-tracking controller drives `desiredCapacity`. |
| Target tracking on average CPU | ✅ | `cpuTotal` per unit, target 0.5: `ceil(in service × warmed average / 0.5)`. See Behaviour. |
| Target tracking on ALB request count per target | ✅ | `requestCount` per unit, target = requests per instance per minute: `ceil(requests a minute / target)`. |
| Scaling cooldowns, alarm datapoints | 🟡 | The controller's (`core.target-tracking`): its window, period and cooldowns stand in for AWS's alarms (3 one-minute datapoints to scale out, 15 to scale in) and its block on scale-in while instances warm up. |
| Step scaling, scheduled actions, predictive scaling | ❌ | A scenario's timeline can set `desiredCapacity` at times. |
| **Health** | | |
| EC2 status checks: an instance that stops answering is replaced | ✅ | After `statusCheckReplace` (3 minutes, assumed: checks run every minute and Auto Scaling waits "a few minutes"). |
| ELB health checks (`healthCheckType: ELB`) | ✅ | The target group's reports replace unhealthy instances; with `EC2` they are ignored, so an instance whose application is broken stays in the group. |
| Broken launches (a bad AMI or launch template) | ✅ | `brokenLaunches`: the share of new instances whose application never becomes healthy; they answer 500 and fail health checks. |
| Replacing at most 10% of the group at a time | ❌ | Every unhealthy instance is replaced at once. |
| **Availability Zones** | | |
| Spread over the group's zones (launch into the emptiest) | ✅ | The fleet core. |
| Zone outage: instances lost, replaced in the other zones | ✅ | Calls on them fail; they are replaced once status checks (or ELB checks) notice. Launches skip a zone that is down. |
| AZRebalance after the zone recovers (launch before terminate) | ✅ | One extra instance in the emptiest zone, then one terminated in the fullest, until even. |
| **Warm pools** | | |
| Pool size (MaxSize or MaxGroupPreparedCapacity minus desired, at least MinSize) | ✅ | |
| Pool states Stopped, Hibernated, Running | ✅ | Stopped skips user data; Hibernated also skips the application start; Running is in service at once. Running pool instances hold On-Demand vCPUs. |
| Warm starts and cold starts, refilling the pool | ✅ | A launch takes a pool instance from its zone; an empty pool is a cold start. Refills launch from scratch. |
| Instance reuse on scale-in | ❌ | AWS's default terminates (as here). |
| Warm pools with Spot | ✅ | Not supported by AWS: with a warm pool the group launches On-Demand only, and the audit warns. |
| **Spot** | | |
| On-Demand base and percentage above base | ✅ | AWS's rounding (up, in favour of On-Demand). |
| Interruptions with a two-minute notice | ✅ | A Poisson rate per Spot instance-hour (assumed). Terminated at the end of the notice, cutting off what it holds; replaced only then (without Capacity Rebalancing). |
| Capacity Rebalancing | ✅ | Replacement launched on the rebalance recommendation (an assumed lead before the notice), the at-risk instance terminated once it is in service. |
| Insufficient Spot capacity | ✅ | A share of Spot launches fails; the group retries Spot, never On-Demand. |
| Allocation strategies, several instance types, weights | ❌ | One instance type per group. |
| **Termination** | | |
| Zones balanced first | ✅ | The fleet core. |
| Default policy | 🟡 | Purchase option out of proportion first, then the instance closest to its next billing hour (ties: launch order, where AWS picks at random). "Outdated configuration" never applies (one launch template). |
| OldestInstance, NewestInstance, ClosestToNextInstanceHour | ✅ | |
| Instance scale-in protection | 🟡 | `scaleInProtection` protects instances launched while it is on; per-instance `SetInstanceProtection` is not modelled. Health replacement and Spot interruptions still take protected instances. |
| **Account quotas** | | |
| Running On-Demand Standard vCPUs | ✅ | Shared by every group in the region (and ECS/EKS on EC2, through `vcpus.ts`). Launches past it wait and retry. |
| Standard Spot vCPUs | ✅ | Likewise for Spot. |
| Auto Scaling groups per region | ✅ | Audit only. |

## Settings

| Path | Default | Range | Kind | What it models |
| --- | --- | --- | --- | --- |
| `instanceType` | `m7i.large` | catalog | hard | vCPUs (workers, quota) and memory |
| `minSize`, `maxSize`, `desiredCapacity` | 2, 10, 2 | 0–10,000 | AWS's own | The group's size. AWS publishes no maximum group size; 10,000 bounds the form. |
| `availabilityZones` | 3 | 1–6 | hard | The first N zones of the region |
| `requestsPerVcpu` | 1 | 1–1,000 | assumed | Requests one vCPU works on at once |
| `serviceTime` | 50 ms, cv 0.5 | | assumed | CPU time per request |
| `queueLimit` | 100 | 0–100,000 | assumed | Requests waiting per instance (one line of this many per serving instance on a plain edge) |
| `errorRate` | 0 | 0–1 | assumed | Application errors (500) |
| `fanOut` | sequential | | | How it calls its outputs |
| `launch.pending`, `.boot`, `.userData`, `.appStart` | 30 s, 30 s, 90 s, 30 s | 0–15 min / 1 h | assumed | Launch phases |
| `healthCheckType` | EC2 | EC2, ELB | AWS default | Whether target-group reports replace instances |
| `healthCheckGracePeriod` | 300 s | 0–2 h | AWS default (console) | Health reports ignored until it ends; 0 from the CLI/SDK |
| `statusCheckReplace` | 180 s | 0–30 min | assumed | Time to replace an instance that stopped answering |
| `defaultInstanceWarmup` | 300 s | 0–1 h | AWS default (via the default cooldown) | Kept out of the CPU average |
| `shutdownGrace` | 30 s | 0–1 h | assumed | Time a terminating instance gets to finish its requests (a target group holds it for its deregistration delay) |
| `terminationPolicy` | Default | Default, OldestInstance, NewestInstance, ClosestToNextInstanceHour | AWS default | Which instance scale-in terminates |
| `brokenLaunches` | 0 | 0–1 | scenario | Share of new instances whose application is broken |
| `warmPool.enabled`, `.poolState`, `.minSize`, `.maxGroupPreparedCapacity` | off, Stopped, 0, 0 (not set) | | AWS defaults | The warm pool |
| `spot.onDemandBaseCapacity` | 0 | 0–10,000 | AWS default | On-Demand base |
| `spot.onDemandPercentageAboveBase` | 100 | 0–100 | AWS default | On-Demand share above the base |
| `spot.interruptionsPerHour` | 0.0000685 | 0–100 | assumed | Interruptions per Spot instance-hour (≈5% a month) |
| `spot.insufficientCapacity` | 0 | 0–1 | assumed | Share of Spot launches EC2 can't fulfil |
| `spot.capacityRebalance` | off | | AWS default | Capacity Rebalancing |
| `spot.rebalanceLead` | 5 min | 0–1 h | assumed | Recommendation lead before the notice |
| `scaleInProtection` | off | | AWS default | NewInstancesProtectedFromScaleIn |

Account quotas (per region, in the Region box): `ec2OnDemandStandardVcpus` (5), `ec2SpotStandardVcpus` (5),
`ec2AutoScalingGroups` (500).

## Limits

| Limit | Value | Kind | Source |
| --- | --- | --- | --- |
| Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances | 5 vCPUs | quota | [EC2 instance quotas](https://docs.aws.amazon.com/ec2/latest/instancetypes/ec2-instance-quotas.html), [On-Demand quotas](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-on-demand-instances.html) |
| All Standard Spot Instance Requests | 5 vCPUs | quota | [EC2 instance quotas](https://docs.aws.amazon.com/ec2/latest/instancetypes/ec2-instance-quotas.html), [Spot quotas](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-spot-limits.html) |
| Auto Scaling groups per region | 500 | quota | [Auto Scaling quotas](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-quotas.html) |
| Spot interruption notice | 2 minutes | hard | [Spot interruption notices](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-instance-termination-notices.html) |
| Over MaxSize while rebalancing | 10% of desired or 1 instance, whichever is greater | hard | [Auto Scaling benefits](https://docs.aws.amazon.com/autoscaling/ec2/userguide/auto-scaling-benefits.html), [Capacity Rebalancing](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-capacity-rebalancing.html) |
| Health check grace period default | 300 s (console), 0 (CLI, SDK) | default | [Grace period](https://docs.aws.amazon.com/autoscaling/ec2/userguide/health-check-grace-period.html) |
| Default instance warmup | not enabled; policies then use the default cooldown | default | [Instance warmup](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-default-instance-warmup.html) |
| Default cooldown | 300 s | default | [Cooldowns](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-scaling-cooldowns.html) |
| EC2 status checks | every minute; Auto Scaling waits "a few minutes" | published, unquantified | [Status checks](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/monitoring-system-instance-status-check.html), [Health checks](https://docs.aws.amazon.com/autoscaling/ec2/userguide/health-checks-overview.html) |
| On-Demand base, percentage above base | defaults 0 and 100; fractions round up for On-Demand | default | [InstancesDistribution](https://docs.aws.amazon.com/autoscaling/ec2/APIReference/API_InstancesDistribution.html), [mixed instances groups](https://docs.aws.amazon.com/autoscaling/ec2/userguide/mixed-instances-groups-set-up-overview.html) |
| Warm pool size | MaxSize (or MaxGroupPreparedCapacity) − desired; MinSize none | default | [Warm pools](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-warm-pools.html) |
| Warm pools with Spot in a mixed instances group | not supported | hard | [Warm pools](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-warm-pools.html) |
| Default termination policy | zones, then outdated configuration, then closest to the next billing hour | default | [Termination policies](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-termination-policies.html) |
| Instance scale-in protection | off by default; doesn't stop health replacement or Spot interruptions | default | [Scale-in protection](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-instance-protection.html) |
| T3 credit specification | `unlimited` by default | default | [Unlimited mode](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/burstable-performance-instances-unlimited-mode.html) |
| Instance vCPUs and memory | per type | hard | [General purpose](https://docs.aws.amazon.com/ec2/latest/instancetypes/gp.html), [compute optimized](https://docs.aws.amazon.com/ec2/latest/instancetypes/co.html), [memory optimized](https://docs.aws.amazon.com/ec2/latest/instancetypes/mo.html) |
| Spot interruption frequency | historically under 5% a month on average | published band | [Spot Instance Advisor](https://aws.amazon.com/ec2/spot/instance-advisor/) |
| Launch, boot and application start times | not published | assumed | |

The vCPU quotas' published default of 5 is small on purpose: "Amazon EC2 automatically increases your On-Demand Instance
quotas based on your usage". An established account has far more, so set yours in the region's quotas; the audit warns
when the groups in a region need more than the quota at their desired or maximum sizes.

## Behaviour

**Requests.** A request waits for a worker (a vCPU, times `requestsPerVcpu`) on an instance, holds it for the service
time, then releases it and calls downstream (the instance stays involved until downstream answers, as an event loop
does). Past an instance's queue it is refused with 503 (`Unavailable`). Called through a plain edge, the group behaves as
an idealised balancer in front of it: one line of `queueLimit × instances serving`, the first free vCPU anywhere; a group
with no instance serving refuses at once. Called through a target group, the balancer there picks the instance and each
instance has its own queue. An instance whose application is broken works for the service time and answers 500.

**Launching.** A new instance is `pending`, then boots, runs its user data and starts its application (four phases, each
a setting), then is InService and in its health check grace period. With the defaults that is three minutes. Each launch
first takes its vCPUs from the region's quota (On-Demand or Spot); refused, it waits as requested and is retried every
30 s (assumed) or as soon as the quota is raised. Instances there when the simulation starts are already in service.

**Scaling.** `desiredCapacity` is a setting, so `core.target-tracking` drives it. The gauges to track:

- `cpuTotal`, per unit, target 0.5 (50%): asks for `ceil(instances in service × average CPU / 0.5)`. The average is over
  instances past their warmup (`cpu`); instances still warming count as capacity at that average, and instances still
  launching aren't counted, so a policy that already asked for them doesn't ask again while they launch. This is a
  target-tracking policy's arithmetic on `ASGAverageCPUUtilization`, and how AWS describes warmup ("considers instances
  that are warming up as part of the capacity of the group when deciding how many instances to add"). CPU can't exceed
  100%, so in an overload the policy can at most double the group per launch: the surge scenario shows it.
- `requestCount`, per unit, target = requests per instance per minute: `ceil(requests a minute / target)`, as
  `ALBRequestCountPerTarget` scales. `requestCountPerTarget` is the per-instance figure for charts.

Tracking `cpu` in total (`per: total`) also works, but multiplies the desired capacity, which includes instances still
launching, so it overshoots during a launch. AWS's alarms (three one-minute datapoints to scale out, fifteen to scale in)
and its block on scale-in while instances warm up are the controller's window, period and cooldowns: the demo uses a
two-minute window decided every minute, no scale-out cooldown and a ten-minute scale-in cooldown.

**Health.** An instance that dies (its zone fails) answers nothing and the requests on it fail; Auto Scaling replaces it
after `statusCheckReplace`. With `healthCheckType: ELB`, a target group's unhealthy report replaces it too (usually much
sooner). Reports during the grace period are acted on when it ends. With `EC2`, a target group stops sending to an
unhealthy instance but the group keeps it.

**Zones.** Instances spread over the group's zones, launching into the emptiest. A zone outage kills its instances; their
replacements launch in the other zones. When the zone is back, the group rebalances new-before-old (it may run one over).

**Warm pool.** The pool holds `MaxSize` (or `maxGroupPreparedCapacity`) minus the desired capacity, at least its minimum.
It is spread so that each zone's group-plus-pool count is even, which puts pool instances where the group launches next. A
launch takes a pool instance from its own zone: Stopped skips user data (pending, boot, application start), Hibernated
also the application start (pending, resume), Running nothing. Without one in the zone it is a cold start. The pool refills
by launching from scratch; while preparing (and while Running) its instances hold On-Demand vCPUs.

**Spot.** Each launch is On-Demand or Spot, whichever is short of `onDemandOf(size) = min(size, base) + ceil((size − base)
× percent / 100)` for the group's size after it. EC2 interrupts serving Spot instances at `interruptionsPerHour` each
(Poisson). An interrupted instance keeps serving through its two-minute notice; then EC2 terminates it, cutting off its
requests, and the group launches the replacement. With Capacity Rebalancing a recommendation comes `rebalanceLead` before
the notice: the group launches the replacement at once (up to 10% or one over its maximum) and terminates the at-risk
instance, draining it, once the replacement is in service; if the replacement is late the interruption takes the old one
anyway. A Spot launch can also fail for capacity (`insufficientCapacity`); the group retries Spot and never falls back to
On-Demand.

**Termination.** Scale-in takes launches not yet started first, then serving instances from the fullest zone, by the
termination policy (see Coverage). Instances it terminates drain for `shutdownGrace` (a target group holds them for its
deregistration delay).

## Connections

- **In**: `invoke`, and `fleet` (it is a fleet). A plain edge gets the idealised balancer; `connector: core.target-group`
  (or an ELB's own target-group connector) puts a target group on the edge: per-instance routing, health checks,
  deregistration delay.
- **`out`** (many): downstream calls after the service time, per `fanOut`.
- In a VPC: yes. It can sit in an `aws.vpc` box (or directly in a region box).

## Metrics and state

Gauges: `desired`, `inService`, `pending` (requested and launching), `draining`, `busy`, `queued`, `utilization` (busy over
serving workers, 0–1), `cpu` (average over warmed instances, 0–1), `cpuTotal` (`cpu` × instances in service),
`requestCount` (requests in the last minute), `requestCountPerTarget`, `onDemand`, `spot`, `vcpus` (the group's and its
pool's), `warm`, `warmPreparing`, `spotNoticed`, `inService.<zone>`.

Counters (rates, or `total.` in assertions): `launches`, `warmStarts`, `launchRefused`, `spotInterruptions`,
`rebalanceRecommendations`; and the node's own `in`, `ok`, `fail`, `fail.<Tag>`.

Probe: the gauges' values, the warm pool, totals (`served`, `errors`, `refused`, `lost`, `launched`, `warmStarts`,
`refusedLaunches`, `replaced`, `spotInterruptions`) and every instance (name, zone, state, phase, purchase option, how it
started, alive, broken, busy, queued).

## Not yet simulated

1. **Instance refresh and launch template versions**: a rolling replacement with a minimum healthy percentage, checkpoints
   and the default termination policy's "outdated configuration" step. Needs a version on each unit and a replacement loop.
2. **Several instance types** in a mixed instances group, with allocation strategies and weights: Spot pools that fail
   independently. Needs per-unit workers in the fleet core (today one number for every unit).
3. **AWS's alarms for target tracking** (3 datapoints to scale out, 15 to scale in, scale-in blocked during warmup) as a
   provider controller, rather than approximating them with the core controller's window and cooldowns.
4. **Replacing at most 10% of the group at a time** (the instance maintenance policy) when many instances are unhealthy.
5. **Standard-mode T3 credits**: CPU throttled to the baseline when credits run out.
6. **Lifecycle hooks** as their own wait, and the warm pool's instance reuse policy.
7. **Startup CPU**: a new instance's slower first minutes (JIT, cold caches), which is what the instance warmup exists for.

## Assumptions

| Number | Value | Why |
| --- | --- | --- |
| Launch phases | 30 s pending, 30 s boot, 90 s user data, 30 s application start | AWS publishes none; three minutes is typical for an AMI that installs its application at boot. |
| Status-check replacement | 3 minutes | Status checks run every minute and Auto Scaling waits "a few minutes". |
| Launch retry after a refusal | 30 s | Not published. |
| Spot interruption rate | 0.05 / 730 per instance-hour | The Spot Instance Advisor's average band (<5% a month). |
| Rebalance recommendation lead | 5 minutes | AWS says it can come earlier than the notice, or with it. |
| Shutdown grace | 30 s | The application's own SIGTERM handling. |
| Hibernated resume | as long as a boot | Restoring memory from EBS. |
| Warm pool spread | even across zones counting the group | AWS doesn't say how it places pool instances. |
| Warm instances count as capacity at the warmed average | | How the docs describe warmup in scaling decisions. |
| Default termination policy ties | launch order | AWS picks at random. |

## References

- [Health checks](https://docs.aws.amazon.com/autoscaling/ec2/userguide/health-checks-overview.html), [grace period](https://docs.aws.amazon.com/autoscaling/ec2/userguide/health-check-grace-period.html)
- [Default instance warmup](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-default-instance-warmup.html), [scaling cooldowns](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-scaling-cooldowns.html)
- [Termination policies](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-termination-policies.html), [instance scale-in protection](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-instance-protection.html)
- [Warm pools](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-warm-pools.html)
- [Mixed instances groups](https://docs.aws.amazon.com/autoscaling/ec2/userguide/mixed-instances-groups-set-up-overview.html), [InstancesDistribution](https://docs.aws.amazon.com/autoscaling/ec2/APIReference/API_InstancesDistribution.html), [allocation strategies](https://docs.aws.amazon.com/autoscaling/ec2/userguide/allocation-strategies.html)
- [Capacity Rebalancing](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-capacity-rebalancing.html), [Spot interruption notices](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-instance-termination-notices.html), [Spot Instance Advisor](https://aws.amazon.com/ec2/spot/instance-advisor/)
- [Zones and rebalancing](https://docs.aws.amazon.com/autoscaling/ec2/userguide/auto-scaling-benefits.html), [Auto Scaling quotas](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-quotas.html)
- [EC2 instance quotas](https://docs.aws.amazon.com/ec2/latest/instancetypes/ec2-instance-quotas.html), [On-Demand quotas](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-on-demand-instances.html), [Spot quotas](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-spot-limits.html)
- [Status checks](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/monitoring-system-instance-status-check.html), [T3 unlimited mode](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/burstable-performance-instances-unlimited-mode.html)
- Instance types: [general purpose](https://docs.aws.amazon.com/ec2/latest/instancetypes/gp.html), [compute optimized](https://docs.aws.amazon.com/ec2/latest/instancetypes/co.html), [memory optimized](https://docs.aws.amazon.com/ec2/latest/instancetypes/mo.html)
