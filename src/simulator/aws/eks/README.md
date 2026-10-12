# Amazon EKS (`aws.eks`)

Amazon EKS runs Kubernetes: AWS manages the control plane, and workloads run as pods on the nodes of managed node groups
(EC2 instances in Auto Scaling groups) or on nodes Karpenter launches. This component is one workload: a Deployment of
pods scheduled onto its node group. It lets you learn **two-level scaling**: the Horizontal Pod Autoscaler adds pods in
seconds, but pods no node has room for are Pending until a node autoscaler (the Cluster Autoscaler or Karpenter) has
added a node, which takes minutes; and the other way, nodes stay long after the pods have gone. Also: how requests (not
use) decide where pods go, what the EKS AMI keeps back on a node, why a node failure takes Kubernetes almost six minutes
to act on, and how a crashing rollout stalls rather than rolls back.

It is built on the fleet core (`../../fleet/`): pods are a fleet placed through a host pool (`fleet/Hosts.ts`) onto a
second fleet, the nodes; rolling updates are the core's `Rollout`, replacing pods in kind as ReplicaSets do.

## Coverage

| Feature | Status | Notes |
| --- | --- | --- |
| **Pods** | | |
| CPU and memory requests; scheduling by requests | ✅ | A pod goes to a node with that much allocatable left; none: Pending. |
| Node allocatable (EKS AMI) and max pods | ✅ | vCPUs and memory less kube-reserved (6%/1%/0.5%/0.25% of cores; 11 MiB a pod + 255 MiB) and the 100 MiB eviction threshold; `maxPods` a setting (29 for a large instance). |
| Scheduler scoring | ✅ | LeastAllocated (default) or MostAllocated, within a zone. |
| Topology spread over zones | ✅ | Best effort (ScheduleAnyway), or maxSkew 1 with DoNotSchedule. |
| Image pull once per node | ✅ | IfNotPresent: the first pod on a node pulls; later ones don't. |
| Readiness probe | ✅ | Ready at the first probe after the application is up (initial delay, period); no traffic before. |
| Liveness probe | 🟡 | Only as CrashLoopBackOff of a crashing revision (restarts with back-off, never ready). |
| termination grace period | ✅ | A pod being stopped takes no new requests and finishes what it holds. |
| **Scaling** | | |
| Horizontal Pod Autoscaler | 🟡 | A `core.target-tracking` controller on `replicas` with metric `cpuPods`. See "The HPA as target tracking" for what differs. |
| Cluster Autoscaler | ✅ | 10 s scans, scale-up for unschedulable pods counting nodes already launching, scale-down under 50% after 10 min, 10 min after a scale-up, empty nodes in bulk. |
| Karpenter | ✅ | Batching (1 s idle, 10 s max), direct launches, consolidation (WhenEmpty, WhenEmptyOrUnderutilized), consolidateAfter, 10% budget. One instance type (no right-sizing). |
| EC2 vCPU quota | ✅ | Nodes count against the region's Standard On-Demand vCPUs, shared with every instance (`../ec2/vcpus.ts`). |
| **Failures** | | |
| Node failure and eviction | ✅ | A dead node's pods die with it; Kubernetes replaces them after the node monitor grace period (50 s) plus the toleration (300 s), or when the node is replaced. |
| Zone outage | ✅ | Its nodes and pods die; nodes added afterwards go to the other zones. |
| Rolling update (maxSurge, maxUnavailable) | ✅ | Stalls on a crashing or never-ready revision; never rolled back; progress deadline reported. |
| PodDisruptionBudgets | ❌ | Node removals and drains are unlimited. |
| **Control plane** | ❌ | Managed by AWS; its API limits aren't the point. |

## Settings

| Path | Default | Range | Kind | What it models |
| --- | --- | --- | --- | --- |
| `replicas` | 3 | 0-100,000 | | The Deployment's replicas; what the HPA drives. |
| `zones` | 3 | 1-6 | | The node group's subnets. |
| `pod.revision` | 1 | | | The pod template; changing it starts a rolling update. |
| `pod.cpu` | 500m | 1-192,000 | | CPU request. |
| `pod.memory` | 512 MiB | | | Memory request. |
| `pod.requestsPerCore` | 10 | 1-10,000 | assumed | Requests a pod works on at once per core of request. |
| `pod.serviceTime` | 50 ms, cv 0.5 | | assumed | |
| `pod.imageSize`, `pod.pullRate` | 300 MiB, 25 MiB/s | | assumed rate | |
| `pod.appStart` | 5 s | | assumed | |
| `pod.failure` | none | none, crash, unready | | A bad revision. |
| `readiness.initialDelay`, `readiness.period` | 0, 10 s | | hard | Probe defaults. |
| `queueLimit` | 100 | | assumed | |
| `fanOut` | sequential | | | |
| `terminationGracePeriod` | 30 s | | hard | |
| `rollingUpdate.maxSurge`, `rollingUpdate.maxUnavailable` | 25%, 25% | | hard | Rounded up, rounded down. |
| `topologySpread` | zones | zones, strict, none | | |
| `nodeFailure.monitorGracePeriod` | 50 s | | hard | `--node-monitor-grace-period` (40 s before 1.32). |
| `nodeFailure.tolerationSeconds` | 300 s | | hard | DefaultTolerationSeconds. |
| `nodes.instanceType` | m7i.large | the EC2 catalog | | |
| `nodes.minSize`, `nodes.maxSize` | 1, 10 | | quota (450 nodes a group) | Karpenter ignores the minimum; the maximum stands in for its NodePool limits. |
| `nodes.desiredSize` | 3 | | | Nodes at the start. |
| `nodes.maxPods` | 29 | 1-737 | hard | ENIs × (IPs per ENI − 1) + 2 for the type. |
| `nodes.scheduling` | spread | spread, binpack | | LeastAllocated, MostAllocated. |
| `nodes.autoscaler` | cluster-autoscaler | cluster-autoscaler, karpenter, none | | |
| `nodes.pending`, `nodes.boot`, `nodes.join` | 30 s each | | assumed | A managed node group's node to Ready. |
| `nodes.karpenterLaunch` | 50 s | | assumed | Karpenter's node to Ready ("under a minute"). |
| `nodes.replaceAfter` | 180 s | | assumed | A dead instance replaced by its Auto Scaling group. |
| `clusterAutoscaler.*` | 10 s, 10 min, 10 min, 0.5 | | hard (flags) | scan interval, unneeded time, delay after add, utilization threshold. |
| `karpenter.*` | 1 s, 10 s, WhenEmptyOrUnderutilized, 0, 10% | | hard (defaults) | batch idle and max, consolidation policy, consolidateAfter, budget. |

EKS contributes no account-level quotas of its own; nodes count against EC2's `ec2OnDemandStandardVcpus`.

## Limits

| Limit | Value | Kind | Source |
| --- | --- | --- | --- |
| HPA | desired = ceil(current × metric / target); tolerance 0.1; every 15 s; scale-down stabilization 300 s, scale-up 0; scale up max(100%, 4 pods) per 15 s, down 100% per 15 s; unready pods count 0% on scale-up | hard (defaults) | [horizontal-pod-autoscale](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/) |
| Node monitor grace period | 50 s (40 s before v1.32) | hard (default) | [kube-controller-manager](https://kubernetes.io/docs/reference/command-line-tools-reference/kube-controller-manager/) |
| Toleration of not-ready / unreachable | 300 s | hard (default) | [taint-based evictions](https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/#taint-based-evictions) |
| Probes | period 10 s, timeout 1 s, success 1, failure 3, initial delay 0 | hard (defaults) | [probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/) |
| CrashLoopBackOff | 10 s doubling, capped at 300 s | hard | [pod lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/) |
| terminationGracePeriodSeconds | 30 s | hard (default) | pod lifecycle |
| Rolling update | maxSurge 25% (up), maxUnavailable 25% (down), minReadySeconds 0, progressDeadlineSeconds 600 (reported, no rollback) | hard (defaults) | [deployment](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/) |
| Topology spread | DoNotSchedule by default when written; built-in ScheduleAnyway by zone (maxSkew 5) and host (3) | hard | [topology spread](https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/) |
| Scheduler scoring | LeastAllocated by default; MostAllocated | hard | [resource bin packing](https://kubernetes.io/docs/concepts/scheduling-eviction/resource-bin-packing/) |
| Cluster Autoscaler | scan 10 s; unneeded 10 min; delay after add 10 min; threshold 0.5; max node provision 15 min; empty bulk delete 10 | hard (flags) | [FAQ](https://github.com/kubernetes/autoscaler/blob/master/cluster-autoscaler/FAQ.md) |
| Karpenter | batch idle 1 s, max 10 s; consolidateAfter 0; budget 10% | hard (defaults) | [disruption](https://karpenter.sh/docs/concepts/disruption/), [settings](https://karpenter.sh/docs/reference/settings/) |
| Managed node groups | 30 per cluster, 450 nodes each | quota | [eks.html](https://docs.aws.amazon.com/general/latest/gr/eks.html) |
| Max pods (VPC CNI) | ENIs × (IPs per ENI − 1) + 2; m5.large 29; managed groups cap at 110 under 30 vCPUs, 250 above | hard | [choosing-instance-type](https://docs.aws.amazon.com/eks/latest/userguide/choosing-instance-type.html) |
| Allocatable | 11 MiB × max pods + 255 MiB; 6% / 1% / 0.5% / 0.25% of cores; 100 MiB eviction | hard | [amazon-eks-ami nodeadm](https://github.com/awslabs/amazon-eks-ami/blob/main/nodeadm/internal/kubelet/config.go) |
| Node bootstrap | within 15 min | hard | [managed node groups](https://docs.aws.amazon.com/eks/latest/userguide/managed-node-groups.html) |

## Behaviour

**Scheduling.** A pod asks for `pod.cpu` and `pod.memory`. The scheduler looks for a node that is up, not cordoned, has
fewer than `maxPods` pods, and has that much allocatable left; zones first (the zone with the fewest of the Deployment's
pods; with strict spread only those zones), then the emptiest node (LeastAllocated) or the fullest (MostAllocated). None:
the pod is Pending (`pending`). Use doesn't count: a node full of idle pods is full.

**A pod's start.** Scheduled on a node, it pulls its image unless the node has it (size ÷ rate; a pod placed while another
is pulling the same image waits for that pull), starts its container (1 s), and is Ready at the first readiness probe after
its application is up (`initialDelay + ceil((appStart − initialDelay) / period) × period`). Only then does it get traffic.

**Capacity.** A pod works on `max(1, floor(cpu request in cores × requestsPerCore))` requests at once. `cpu` is busy over
the workers of ready pods (utilization of the request); `cpuPods` is pods' worth of CPU in use. Pods don't burst past their
request here (real pods without a CPU limit can, which lets the HPA see more than 100%).

**The HPA as target tracking.** `core.target-tracking` with `metric: cpuPods, per: unit, targetValue: 0.6` computes
`ceil(cpuPods / 0.6)`, which is the HPA's `ceil(replicas × utilization / target)` with unready pods at 0%. Its tolerance is
the HPA's (10%) and its period the HPA's sync (15 s). What differs: the HPA reads the current metric (metrics-server,
about 15 s resolution), the controller averages over its `window`; the HPA's scale-down is a stabilization window (the
highest recommendation of the last 5 minutes), the controller's a cooldown after its last change (set `scaleInCooldown: 5
minutes` for the same effect after a single peak); and the HPA limits each scale-up to max(100%, 4 pods) per 15 s, which
the controller doesn't. With CPU capped at the request, a saturated Deployment's HPA grows by a factor of 1/target per
step, as a real one with CPU limits does.

**Node autoscaling.** The Cluster Autoscaler looks every 10 s. Pending pods: it asks the node group for as many nodes as
they need beyond the room on nodes already launching (`ceil(pods / pods per node)`), and the nodes take
pending + boot + join (90 s) to be Ready; then the pods pull, start and become ready. Scale-down: it doesn't look for 10
minutes after a scale-up; a node is unneeded while its pods request less than half its allocatable CPU and memory and
would fit elsewhere; after 10 minutes unneeded, empty nodes go together, a node with pods one at a time (cordoned and
drained: its pods are evicted and recreated elsewhere). Karpenter looks every second: pending pods start a batch that
closes after 1 s with no new pod or 10 s in all, then it launches the nodes they need directly, Ready in 50 s.
Consolidation, every 10 s once nothing is pending: empty nodes go, and (WhenEmptyOrUnderutilized) the least used node whose
pods fit elsewhere, within 10% of the nodes at a time.

**Node failure.** A node that dies (its zone goes down) takes its pods with it; requests on them fail. Kubernetes marks
the node NotReady after `monitorGracePeriod` and evicts its pods after `tolerationSeconds`: only then does the ReplicaSet
create replacements (5 min 50 s in all). If the Auto Scaling group replaces the dead instance first (`replaceAfter`), its
pods go with it and are replaced then. A load balancer's health checks stop sending them requests sooner; with
`replaceUnhealthy` off on the edge (as with the AWS Load Balancer Controller) they don't replace pods.

**Rolling updates.** Changing `pod.revision` starts one: at most `replicas + ceil(replicas × maxSurge)` pods and at least
`replicas − floor(replicas × maxUnavailable)` available; old pods are scaled down only within `all − minAvailable − new
unavailable`, unhealthy first, as the Deployment controller does; an old pod evicted meanwhile is recreated as an old pod
(its ReplicaSet's). A crashing revision (CrashLoopBackOff, restarts counted with the back-off) or one that is never ready
stalls the rollout with maxUnavailable old pods gone; after 600 s the probe says the progress deadline is exceeded;
nothing rolls back.

## Connections

- **In:** any `invoke` edge. Plain calls reach the Service's ready pods (an idealised balancer); an ALB's or NLB's target
  group addresses pods one by one (IP targets). Set `replaceUnhealthy: false` on that edge: Kubernetes, not the load
  balancer, owns the pods.
- **Out:** `out` (many): downstream calls after a pod's own work, as `fanOut` says.
- It belongs in a VPC (`aws.vpc`): nodes and pods have VPC addresses.

## Metrics and state

Gauges: `replicas`, `ready`, `pending`, `starting`, `terminating`, `busy`, `queued`, `cpu`, `cpuPods`, `oldPods`, `newPods`
(pods of the template being rolled out), `crashLooping` (pods in CrashLoopBackOff), `nodes`, `nodesLaunching`,
`nodesDesired`, `requestedCpu` and `requestedMemory` (requests over allocatable, 0-1), `nodeCpu` (CPU the pods use over
the nodes' allocatable, 0-1: a busy worker is its share of its pod's request), `ready.<zone>`, `nodes.<zone>`. Rates and
latency as every node.

The dashboard (`dashboard.ts`) charts them as Container Insights does: pods by status (`pod_status_ready`,
`pod_status_pending`) against the replicas; `pod_cpu_utilization_over_pod_limit` (taking the limit to be the request)
and `node_cpu_utilization`; requests and response time as the load balancer counts them; `cluster_node_count` with the
node autoscaler's desired size; `node_cpu_reserved_capacity` and `node_memory_reserved_capacity`;
`node_number_of_running_pods` as pods per node; and the rollout with
`pod_container_status_waiting_reason_crash_loop_back_off`. Not charted, because nothing here models them: memory use,
network and filesystem metrics, `cluster_failed_node_count` (node conditions are not modelled), container restarts as a
count, GPU metrics, and the API server's metrics.

Probe: ready, pending, starting, terminating, busy, queued, served, errors, refused, lost, replaced, evicted; `rollout`
(revision, rolling, old and new pods, progress deadline exceeded); `nodes` (ready, launching, desired, requested CPU and
memory); the autoscaler's last 20 decisions with reasons; up to 200 nodes (zone, state, pods, CPU and memory requested,
cordoned) and pods (zone, node, state, phase, revision, restarts).

## Not yet simulated

1. **Karpenter's instance choice.** It picks instance types to fit the pending pods; here every node is `instanceType`.
   Needs per-host room in the pool (it has it) and a choice from the EC2 catalog.
2. **Consolidation and topology spread.** Consolidating underutilized nodes (`WhenEmptyOrUnderutilized`) packs pods onto
   fewer nodes without looking at zones, so it can undo a spread that `topologySpread` asked for; real Karpenter honours
   the spread when it decides what to consolidate. `WhenEmpty` doesn't have the problem. A downed zone also drops out of
   a strict spread's count at once, where Kubernetes may still count it.
3. **Spot nodes** and their interruptions (Karpenter cordons and drains on the two-minute notice).
4. **PodDisruptionBudgets**, which would hold back node drains and consolidation.
5. **The HPA's exact algorithm** (stabilization window, scale-up policies, the readiness delays) as a controller of its own.
6. **CPU bursting past requests**, and memory pressure and OOM kills.
7. **Max pods from the instance type** (needs ENI data in the EC2 catalog) and prefix delegation.
8. **Liveness failures of a running pod** (restart in place on its node) and startup probes.
9. **Several Deployments sharing a node group** (a pool shared through `node.shared`), DaemonSets taking room on every node.
10. **The Cluster Autoscaler's zone blindness** with strict topology spread: here new nodes always go to the emptiest zone.

## Assumptions

| Number | Value | Why |
| --- | --- | --- |
| Node pending, boot, join | 30 s each | EKS says "multiple minutes"; nodes must bootstrap within 15. |
| Karpenter node to Ready | 50 s | The EKS docs say Karpenter provisions "in under a minute". |
| Karpenter consolidation period | 10 s | Unpublished. |
| Instance replaced after | 180 s | `aws.ec2`'s assumption for status checks ("a few minutes"). |
| Pull rate | 25 MiB/s | As ECS. |
| Container start | 1 s | |
| Requests per core | 10 | Your application's. |

## References

- Kubernetes: horizontal-pod-autoscale, deployment, configure-liveness-readiness-startup-probes, pod-lifecycle, taint-and-toleration, kube-controller-manager, topology-spread-constraints, resource-bin-packing (kubernetes.io/docs)
- Cluster Autoscaler FAQ: https://github.com/kubernetes/autoscaler/blob/master/cluster-autoscaler/FAQ.md
- Karpenter: https://karpenter.sh/docs/concepts/disruption/, https://karpenter.sh/docs/reference/settings/
- EKS: managed-node-groups.html, choosing-instance-type.html, https://docs.aws.amazon.com/general/latest/gr/eks.html, best-practices/karpenter.html, best-practices/cas.html
- EKS AMI: https://github.com/awslabs/amazon-eks-ami/blob/main/nodeadm/internal/kubelet/config.go
