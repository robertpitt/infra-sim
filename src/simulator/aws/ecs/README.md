# Amazon ECS (`aws.ecs`)

An Amazon ECS service keeps a number of copies (tasks) of one task definition running, on AWS Fargate (each task gets
capacity of its own) or on the EC2 instances of an Auto Scaling group (a capacity provider). With this component you can
see what a task's size does to its capacity, why a large image makes scale-out slow, how the account's Fargate quota
caps a surge, what a Fargate Spot interruption costs, how a rolling deployment and its circuit breaker behave when the
new revision is broken, and two-level scaling on EC2: tasks wait in PROVISIONING until managed scaling has launched the
instances they need.

It is built on the fleet core (`../../fleet/`): each task is a unit with a zone, a life and workers of its own; on EC2
the instances are a second fleet and the tasks are placed on them through a host pool (`fleet/Hosts.ts`); deployments are
the core's `Rollout`.

## Coverage

| Feature | Status | Notes |
| --- | --- | --- |
| **Tasks** | | |
| CPU and memory set a task's capacity | ✅ | Workers per task = vCPUs × requests per vCPU (at least 1). Fargate's valid CPU/memory pairs are checked; an invalid pair runs as the next size up and the audit says so. |
| Task start-up: provisioning, image pull, application start | ✅ | Pull time = image size ÷ pull rate (assumed 25 MiB/s); SOCI lazy loading makes it 3 s; an EC2 instance that has the image skips the download. |
| Health check grace period | ✅ | `healthCheckGracePeriodSeconds`: failing checks are acted on only when it ends. |
| Stop timeout | ✅ | A task being stopped takes no new requests and finishes what it holds, cut off after `stopTimeout` (2-120 s). |
| Zones | ✅ | Tasks spread over the service's zones; a zone outage takes its tasks, replaced in the other zones once noticed; AZ rebalancing when the zone returns (not with `maximumPercent` 100). |
| Container health checks | 🟡 | Only as the failure of a broken revision (UNHEALTHY 90 s after RUNNING); no health check settings of their own. |
| **Scaling** | | |
| Service auto scaling | ✅ | A `core.target-tracking` controller on `desiredCount`: CPU per task (`cpuTasks`), or requests per task (`in`, as ALBRequestCountPerTarget). |
| Account Fargate vCPU quotas (On-Demand, Spot) | ✅ | Regional, shared by every service through `node.shared`; tasks past them wait in PROVISIONING. |
| Fargate task launch rate | ✅ | Regional token bucket (burst 100, 20 a second by default) and the service's own 500 a minute. |
| **Fargate Spot** | | |
| Capacity provider strategy (base, weights) | ✅ | Tasks running or starting are split by the strategy; Spot never falls back to On-Demand. |
| Spot interruptions with the two-minute warning | ✅ | SIGTERM at the warning, stopped after the stop timeout, replacement at once. The rate is an assumption (a setting). |
| **Deployments** | | |
| Rolling update within minimum healthy and maximum percent | ✅ | A new revision is a settings change (`task.revision`). A new task counts healthy 40 s after RUNNING, unless it fails its checks. |
| Deployment circuit breaker and rollback | ✅ | Threshold ceil(0.5 × desired) within 3-200; tasks stopping before RUNNING and tasks failing health checks count; a healthy one resets. |
| Revision-specific task size | ❌ | CPU and memory apply to every task at once (the fleet core's workers are fleet-wide). |
| Blue/green, linear, canary deployments | ❌ | |
| **EC2 capacity provider** | | |
| Tasks placed on container instances | ✅ | By CPU and memory, zones first, then spread or binpack (memory). |
| Managed scaling (CapacityProviderReservation, target capacity) | ✅ | Out after one minute's data point, in after 15 minutes below target and 15 minutes after a scale-out; step sizes; scale out from zero launches two. |
| Managed termination protection | ✅ | Only instances without tasks are scaled in. |
| Managed instance draining | ✅ | A terminating instance's tasks are replaced elsewhere and stop gracefully; off, they stop with it. |
| EC2 vCPU quota | ✅ | The region's Standard On-Demand vCPUs, shared with every EC2 instance (`../ec2/Vcpus.ts`). |
| ENI limits per instance (awsvpc), instance warm-up | ❌ | See the backlog. |
| **Load balancers** | ✅ | A fleet: an ALB's or NLB's target group picks tasks one by one, checks their health, and reports unhealthy ones, which ECS replaces (and the circuit breaker counts). |

## Settings

| Path | Default | Range | Kind | What it models |
| --- | --- | --- | --- | --- |
| `desiredCount` | 2 | 0-5,000 | hard | Tasks the service keeps running; what service auto scaling drives. |
| `launchType` | FARGATE | FARGATE, EC2 | | Fargate, or an EC2 Auto Scaling group capacity provider. Fixed when the simulation starts. |
| `zones` | 3 | 1-6 | | The zones of its subnets (the region's first ones). |
| `task.revision` | 1 | | | The task definition revision; changing it starts a deployment. |
| `task.cpu` | 1024 | 256-32768 | hard | Task CPU units (Fargate's sizes). |
| `task.memory` | 2048 MiB | 512-249,856 | hard | Task memory; Fargate's valid values depend on the CPU. |
| `task.requestsPerVcpu` | 10 | 1-10,000 | assumed | Requests a task works on at once per vCPU. |
| `task.serviceTime` | 50 ms, cv 0.5 | | assumed | How long a request keeps a worker busy. |
| `task.imageSize` | 300 MiB | 1-20,000 | | The image, compressed. |
| `task.lazyLoading` | off | | | SOCI lazy loading (Fargate). |
| `task.pullRate` | 25 MiB/s | 1-10,000 | assumed | Image download and unpack rate. |
| `task.appStart` | 5 s | 0-30 min | assumed | From container start to serving. |
| `task.failure` | none | none, crash, unhealthy | | What is wrong with this revision. |
| `queueLimit` | 100 | 0-10,000,000 | assumed | Requests waiting for a worker (one line for plain calls, per task behind a target group). |
| `fanOut` | sequential | | | Downstream calls after the task's own work. |
| `healthCheckGracePeriod` | 0 | 0-7 days | hard | `healthCheckGracePeriodSeconds` (AWS allows up to 2,147,483,647 s). |
| `stopTimeout` | 30 s | 2-120 s | hard | SIGTERM to SIGKILL. |
| `lostTaskDetection` | 60 s | 0-1 h | assumed | How long until ECS replaces a task lost with its host or zone. |
| `deployment.minimumHealthyPercent` | 100 | 0-100 | hard | Rounded up. |
| `deployment.maximumPercent` | 200 | 100-1,000 | hard | Rounded down. AWS publishes no upper bound; 1,000 is the simulator's. |
| `deployment.circuitBreaker` | off | | | The API's default. |
| `deployment.rollback` | on | | | With the circuit breaker. |
| `fargate.base` | 0 | 0-100,000 | hard | Tasks always on FARGATE. |
| `fargate.weight`, `fargate.spotWeight` | 1, 0 | 0-1,000 | hard | The strategy's weights. |
| `fargate.spotInterruptionsPerTaskHour` | 0.0000685 | 0-1,000 | assumed | EC2's Spot Instance Advisor's under 5% a month; raise it for a wave. |
| `ec2.instanceType` | m7i.large | the EC2 catalog | | `../ec2/InstanceTypes.ts`. |
| `ec2.minSize`, `ec2.maxSize` | 0, 10 | 0-5,000 | hard | Container instances per cluster: 5,000. |
| `ec2.desiredSize` | 2 | | | Instances at the start; a live change sets the group's desired size. |
| `ec2.managedScaling` | on | | | |
| `ec2.targetCapacity` | 100% | 1-100 | hard | |
| `ec2.minimumScalingStepSize`, `ec2.maximumScalingStepSize` | 1, 10,000 | 1-10,000 | hard | |
| `ec2.managedTerminationProtection` | off | | | |
| `ec2.managedDraining` | on | | | |
| `ec2.placement` | spread | spread, binpack | | Within a zone. |
| `ec2.pending`, `ec2.boot`, `ec2.register` | 30 s, 30 s, 15 s | | assumed | Instance launch, boot, ECS agent registration. |
| `ec2.replaceAfter` | 180 s | 0-1 h | assumed | EC2 status checks finding a dead instance (`../ec2/Limits.ts`). |

Account quotas (`Quotas.ts`, in the Region box): `fargateOnDemandVcpus` 6, `fargateSpotVcpus` 6, `fargateLaunchRate` 20/s,
`fargateLaunchBurst` 100. On EC2, the instances count against EC2's `ec2OnDemandStandardVcpus` (5 by default).

## Limits

| Limit | Value | Kind | Source |
| --- | --- | --- | --- |
| Fargate Linux task sizes | 0.25 vCPU: 0.5/1/2 GB; 0.5: 1-4 GB; 1: 2-8 GB; 2: 4-16 GB; 4: 8-30 GB (1 GB steps); 8: 16-60 GB (4 GB); 16: 32-120 GB (8 GB); 32: 60/120/244 GB | hard | [fargate-tasks-services.html](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-tasks-services.html#fargate-tasks-size) |
| Fargate On-Demand vCPU resource count | 6 per Region | quota | [ecs-service.html](https://docs.aws.amazon.com/general/latest/gr/ecs-service.html) |
| Fargate Spot vCPU resource count | 6 per Region | quota | same |
| Fargate task launch rate | burst 100, 20/s sustained (25 and 5 in newer Regions) | quota | same; [throttling.html](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/throttling.html) |
| Tasks a service launches per minute | 500 (125 on Fargate in newer Regions) | hard | ecs-service.html |
| Tasks per service | 5,000 | hard | ecs-service.html |
| Container instances per cluster | 5,000 | hard | ecs-service.html |
| Tasks in PROVISIONING per cluster | 500 (EC2 capacity providers) | hard, not enforced | ecs-service.html |
| Fargate Spot interruption warning | 2 minutes | hard | [fargate-capacity-providers.html](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-capacity-providers.html) |
| Strategy base / weight | 0-100,000 / 0-1,000 | hard | [API_CapacityProviderStrategyItem](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_CapacityProviderStrategyItem.html) |
| maximumPercent / minimumHealthyPercent | 200 / 100 by default; rounded down / up | hard | [API_DeploymentConfiguration](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_DeploymentConfiguration.html), [service_definition_parameters.html](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service_definition_parameters.html) |
| A task without health checks counts healthy | 40 s after RUNNING | hard | same |
| healthCheckGracePeriodSeconds | 0 by default, up to 2,147,483,647 | hard | service_definition_parameters.html |
| Circuit breaker threshold | ceil(0.5 × desired), 3-200 | hard | [deployment-circuit-breaker.html](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-circuit-breaker.html) |
| stopTimeout | 30 s by default; 2-120 s on Fargate | hard | [API_ContainerDefinition](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ContainerDefinition.html) |
| Container health check | interval 30 s, retries 3, timeout 5 s, no start period | hard | [API_HealthCheck](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_HealthCheck.html) |
| Managed scaling | targetCapacity 1-100 (100); steps 1 and 10,000; scale-out from zero launches 2; scale-in after 15 data points and 15 min after a scale-out | hard | [API_ManagedScaling](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ManagedScaling.html), [cluster-auto-scaling.html](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/cluster-auto-scaling.html) |
| Managed instance draining | on by default, up to 48 h | hard | [managed-instance-draining.html](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/managed-instance-draining.html) |
| Service auto scaling metrics | ECSServiceAverageCPUUtilization, ALBRequestCountPerTarget (1-minute averages), cooldown 300 s | defaults of the `core.target-tracking` controller's settings, not the component's | [service-autoscaling-targettracking.html](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-autoscaling-targettracking.html) |
| AZ rebalancing | on by default since September 2025; not with maximumPercent 100 | hard | [service-rebalancing.html](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-rebalancing.html) |

## Behaviour

**A task's life.** A task is launched when the service needs one (`desiredCount`, a replacement, a deployment). It first
needs capacity: the service's launch pace (500 a minute) and, on Fargate, the region's launch bucket and the vCPU quota of
the capacity the strategy picks (Fargate or Fargate Spot, counted in the task's vCPUs); on EC2, room on an instance. Without
it the task waits in PROVISIONING (`provisioning` gauge) and is tried again every 5 s, or as soon as an instance has room.
Then it is provisioned (its ENI: 10 s on Fargate, 5 s on an instance), activated (the image pull: size ÷ rate, or 3 s
with SOCI, or 1 s on an instance that has it, or the rest of a pull already under way there) and started (`appStart`).
Then it is RUNNING and serves; during `healthCheckGracePeriod` failed checks are noted but acted on only when it ends.
A task being stopped takes no new requests and stops when it holds none, or after `stopTimeout`.

**Capacity.** A task works on `max(1, floor(vCPUs × requestsPerVcpu))` requests at once, each for the service time, then
calls downstream with its worker free. Plain calls wait in one line in front of the service (an idealised balancer); a
target group picks a task per request and each task has its own line. `cpu` is busy workers over the workers of running
tasks, which is what CloudWatch's CPUUtilization stands in for. It can't go past 100%: a saturated service's CPU target
tracking sees only what the tasks can do, so it scales out by at most a factor of 1/target per decision. Tracking requests
per task (`in`, per unit) doesn't saturate.

**Fargate Spot.** Beyond the base, each new task goes where the running and starting tasks stay closest to the weights.
Spot tasks are interrupted at random (a Poisson process at `spotInterruptionsPerTaskHour` per running Spot task): SIGTERM
with the two-minute warning, no new requests, stopped after `stopTimeout`, a replacement launched at once (placed by the
strategy again). A Spot task past the Spot quota waits; it never runs On-Demand.

**Zones.** Tasks spread over the zones, the emptiest first. A zone outage kills its tasks (their requests fail). ECS
replaces them after `lostTaskDetection`, or sooner when a target group's health checks report them. When the zone is
back, AZ rebalancing starts a task there, waits for it, and stops one in the fullest zone, until even.

**Deployments.** Changing `task.revision` starts a rolling deployment. Each revision keeps the image, start-up and failure
it had when it was current. ECS starts new tasks while the old and new together stay within `floor(desired ×
maximumPercent / 100)`, and stops old ones while at least `ceil(desired × minimumHealthyPercent / 100)` stay healthy
(unhealthy old ones first). A new task counts as healthy 40 s after RUNNING, unless its revision fails its checks. With
100% and 100% nothing can move (the audit warns). A broken revision: `crash` stops 5 s after its container starts
(stage 1 of the circuit breaker); `unhealthy` runs, answers 500 and is marked UNHEALTHY 90 s after RUNNING (3 container
checks 30 s apart), or sooner by a target group (stage 2). ECS replaces failed tasks. With the circuit breaker, at
`max(3, min(200, ceil(desired / 2)))` failures the deployment fails: it rolls back to the last completed revision, or, with
rollback off, starts no more new tasks. A healthy new task resets the count. Without it, a broken revision is retried
forever (ECS's throttle back-off for failing tasks is not modelled).

**EC2 capacity provider.** The instances are a fleet of their own (pending, boot, agent registration; zones; vCPUs from
the EC2 quota). Tasks are placed zones first, then on the instance with the most room (spread) or the least memory left
that fits (binpack). Managed scaling looks every minute: M = instances running tasks + ceil(tasks in PROVISIONING ÷ tasks
per instance), N = instances running or launching, CapacityProviderReservation = M / N × 100; the group's desired size
becomes ceil(M × 100 / targetCapacity) (two from zero), out at once by at least the minimum step and at most the maximum,
in only after 15 minutes below and 15 minutes after a scale-out. Instances launching count in N, so tasks waiting for them
don't launch more. With managed termination protection only empty instances are scaled in; with managed draining a
terminating instance's tasks are replaced elsewhere first; without it they stop with the instance (their requests lost).

## Connections

- **In:** any `invoke` edge. A plain edge is the idealised balancer; an ALB's or NLB's target group (`aws.alb.target-group`,
  `core.target-group`) addresses tasks one by one and reports unhealthy ones to the service, which replaces them.
- **Out:** `out` (many): downstream calls after the task's own work, as `fanOut` says.
- It belongs in a VPC (`aws.vpc`): tasks use awsvpc networking.

## Metrics and state

Gauges: `desired`, `running`, `pending` (launching), `provisioning` (waiting for capacity), `draining`, `busy`, `queued`,
`cpu` (0-1), `cpuTasks` (tasks' worth of CPU in use: target tracking per task divides it), `spot`, `fargate` (tasks on
Fargate On-Demand; on Fargate only), `oldTasks` (tasks of an older revision during a deployment), `newTasks` (tasks of the revision being
deployed), `revision` (the revision being deployed or run), `breakerFailures`, `breakerThreshold`, `running.<zone>`; on
EC2 also `instances`, `instancesLaunching`, `instancesDesired`, `capacityReservation` (%), `capacityProviderReservation`
and `targetCapacity` (the same and managed scaling's target, 0-1, 1 being 100%), `cpuReservation` and
`memoryReservation` (0-1). Counters: `taskLaunches`, `taskStops` (tasks that launched and stopped), `taskFailures` (tasks
that crashed or failed their health checks, once each), `spotInterruptions`. Rates and latency as every node (`in`,
`ok`, `fail`, `fail.<Tag>`, `latency`).

The dashboard (`internal/dashboard.ts`) charts them as the console, CloudWatch (`AWS/ECS`) and Container Insights do:
`RunningTaskCount`, `PendingTaskCount` and `DesiredTaskCount`; `CPUUtilization`; requests and response time as the load
balancer counts them; the deployment (tasks per revision, the circuit breaker); task launches, stops, failures and Spot
interruptions; tasks per Fargate capacity provider; and on EC2 `ContainerInstanceCount`, `CPUReservation`,
`MemoryReservation` and `CapacityProviderReservation`. Not charted, because nothing here models them: `MemoryUtilization`
(tasks use no memory here), network and storage bytes, `RestartCount`, ephemeral storage, and Service Connect's metrics.

Probe: running, pending, provisioning, draining, busy, queued, served, errors, refused, lost, replaced, interrupted, spot,
onDemand; `deployment` (state COMPLETED, IN_PROGRESS, FAILED or ROLLED_BACK, revision, stable revision, failures and
threshold, old and new tasks, rollbacks); on EC2 `instances` (running, launching, desired, reservation, CPU and memory
reservation); and up to 200 tasks (zone, state, phase, revision, capacity, instance, busy workers).

## Not yet simulated

1. **Several services sharing a cluster's instances.** The capacity provider belongs to the service; a cluster's services
   would share a host pool through `node.shared` (the pool is ready for several tenant fleets).
2. **ENI limits on EC2.** An awsvpc task takes an ENI; an instance without ENI trunking holds (ENIs − 1) tasks. Needs ENI
   counts in the EC2 catalog; the pool's `slots` is where they go.
3. **Revision-specific task sizes.** A deployment that changes CPU changes every task at once: per-unit workers in the core.
4. **The service throttle logic** (`service-throttle-logic.html`): a task that keeps failing to start backs off up to 27
   minutes. A crash-looping deployment without the circuit breaker retries at full speed here.
5. **Scale-in suspended during deployments** (service auto scaling does that) and replacing an unhealthy task before
   stopping it when maximumPercent allows: both small changes to the rollout's bounds.
6. **Blue/green, linear and canary deployments**, deployment alarms, bake time.
7. **Instance warm-up and Spot capacity on the EC2 capacity provider.**
8. **Fargate Spot capacity shortages** (tasks waiting for Spot capacity that isn't there).
9. **Memory**: tasks never run out of memory; memory only sizes Fargate tasks and fills instances.
10. **Application Auto Scaling's CPU arithmetic.** AWS scales on the service's average CPU times its desired count and
    counts capacity it added during the scale-out cooldown; `core.target-tracking` divides `cpuTasks` by the running
    tasks, and with `cpu` in total keeps adding while new tasks are still pending. Backlog per task (the controller's
    `source` on the queue) and ALB request count per target behave as AWS's do.
11. **A queue drained by the service.** `core.poller` (what a queue wired to an ECS service gets) has a fixed pool of
    workers that doesn't follow the service's task count, and what it holds isn't in the queue's depth.

## Assumptions

| Number | Value | Why |
| --- | --- | --- |
| Fargate PROVISIONING | 10 s | AWS: the ENI "adds an overhead of several seconds". |
| PROVISIONING on an instance | 5 s | The ENI attachment alone. |
| Pull rate | 25 MiB/s | AWS publishes none; a large image on EC2 "might take 10-20 seconds". |
| SOCI pull | 3 s | AWS: "containers only spend a few seconds on the image pull". |
| Cached image | 1 s | A manifest check. |
| Lost task noticed | 60 s | Unpublished. |
| Launch retry | 5 s | How soon the scheduler tries again after a quota or rate refusal. Unpublished. |
| Crash after container start | 5 s | A bad revision's process exiting. |
| Instance pending, boot | 30 s, 30 s | As `aws.ec2`'s defaults. |
| ECS agent registration | 15 s | Unpublished. |
| Spot interruption rate | under 5% a month | EC2's Spot Instance Advisor; Fargate publishes none. |
| Requests per vCPU | 10 | Your application's. |

## References

- Fargate task sizes, Spot, pull behaviour: fargate-tasks-services.html, fargate-capacity-providers.html, fargate-pull-behavior.html, pull-behavior.html (ECS developer guide)
- Quotas: https://docs.aws.amazon.com/general/latest/gr/ecs-service.html, throttling.html
- Task lifecycle: task-lifecycle-explanation.html; task networking overhead: task-recommendations.html
- Services and deployments: service_definition_parameters.html, API_DeploymentConfiguration, deployment-circuit-breaker.html, service-rebalancing.html, service-throttle-logic.html
- Containers: API_ContainerDefinition, API_HealthCheck
- Capacity providers: API_ManagedScaling, API_CapacityProviderStrategyItem, cluster-auto-scaling.html, managed-termination-protection.html, managed-instance-draining.html, task-placement-strategies.html
- Service auto scaling: service-autoscaling-targettracking.html
