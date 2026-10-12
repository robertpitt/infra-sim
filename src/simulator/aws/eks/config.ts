import { Schema } from "effect"
import * as Setting from "../../Setting.ts"
import { DEFAULT_INSTANCE_TYPE, INSTANCE_TYPE_NAMES } from "../ec2/instanceTypes.ts"
import { STATUS_CHECK_REPLACE_S } from "../ec2/limits.ts"
import {
  CA_DELAY_AFTER_ADD_S,
  CA_SCAN_S,
  CA_UNNEEDED_S,
  CA_UTILIZATION,
  KARPENTER_BATCH_IDLE_S,
  KARPENTER_BATCH_MAX_S,
  KARPENTER_BUDGET_PERCENT,
  KARPENTER_NODE_MS,
  MAX_PODS_LARGE,
  MAX_SURGE_PERCENT,
  MAX_UNAVAILABLE_PERCENT,
  NODE_BOOT_MS,
  NODE_JOIN_MS,
  NODE_MONITOR_GRACE_S,
  NODE_PENDING_MS,
  NODES_PER_GROUP,
  PAGES,
  PROBE_PERIOD_S,
  PULL_MIB_PER_S,
  TERMINATION_GRACE_S,
  TOLERATION_S
} from "./limits.ts"

const seconds = (s: number) => `${s} seconds` as const

/**
 * An EKS workload's settings: a Deployment of pods (replicas, requests, image, probes, rolling update, how it spreads over
 * zones), the managed node group they are scheduled onto, and what adds nodes when pods are pending (the Cluster
 * Autoscaler or Karpenter).
 */
export const Config = Schema.Struct({
  replicas: Setting.int({
    default: 3,
    min: 0,
    max: 100_000,
    unit: "pods",
    label: "Replicas",
    help: "The Deployment's replicas. The Horizontal Pod Autoscaler (a target-tracking controller, setting: replicas) drives it."
  }),
  zones: Setting.int({
    default: 3,
    min: 1,
    max: 6,
    unit: "zones",
    label: "Availability Zones",
    help: "The node group's subnets are in this many zones of its region (the first ones); nodes spread over them, and pods over the nodes."
  }),
  pod: Setting.group(
    {
      revision: Setting.int({
        default: 1,
        min: 1,
        max: 1_000_000,
        label: "Pod template revision",
        help: "Change it to roll out a new pod template: a rolling update replaces every pod, at most maxSurge over and maxUnavailable under the replicas. The image, start-up and failure below belong to the revision current when they are set."
      }),
      cpu: Setting.int({
        default: 500,
        min: 1,
        max: 192_000,
        unit: "millicores",
        label: "CPU request",
        help: "What the scheduler reserves on a node for each pod, and what CPU utilization is relative to (the HPA's target is a share of the request). It also sets how many requests a pod works on at once."
      }),
      memory: Setting.int({ default: 512, min: 1, max: 1_536_000, unit: "MiB", label: "Memory request", help: "What the scheduler reserves on a node for each pod." }),
      requestsPerCore: Setting.int({
        default: 10,
        min: 1,
        max: 10_000,
        unit: "requests",
        label: "Requests per core",
        help: "How many requests a pod works on at once per core of its CPU request (at least one per pod). An assumption about your application. Pods don't burst past their request here."
      }),
      serviceTime: Setting.latency({ mean: "50 millis", cv: 0.5, label: "Service time", help: "How long a request keeps one of the pod's workers busy, before any downstream calls." }),
      imageSize: Setting.int({
        default: 300,
        min: 1,
        max: 20_000,
        unit: "MiB",
        label: "Image size",
        help: "The container image, compressed. A node pulls it once (imagePullPolicy IfNotPresent): the first pod on a new node waits for the whole download, later ones start at once."
      }),
      pullRate: Setting.int({ default: PULL_MIB_PER_S, min: 1, max: 10_000, unit: "MiB/s", label: "Pull rate", help: "How fast a node downloads and unpacks an image. An assumption." }),
      appStart: Setting.duration({
        default: "5 seconds",
        min: 0,
        max: "30 minutes",
        label: "Application start",
        help: "From the container starting until the application would pass its readiness probe. An assumption about your application."
      }),
      failure: Setting.choice(["none", "crash", "unready"], {
        default: "none",
        labels: { none: "None: it works", crash: "Crashes (CrashLoopBackOff)", unready: "Never ready" },
        label: "What's wrong with it",
        help: "A bad revision. Crashes: the container exits as it starts and the kubelet restarts it with a back-off (10 s, 20 s, 40 s... up to 5 minutes), so the pod never becomes ready. Never ready: it runs but fails its readiness probe. Either way it takes no traffic, and a rolling update stalls with maxUnavailable old pods gone; Kubernetes doesn't roll back."
      })
    },
    { label: "Pods" }
  ),
  readiness: Setting.group(
    {
      initialDelay: Setting.duration({ default: 0, min: 0, max: "1 hour", label: "Initial delay", help: "initialDelaySeconds: no probe before it. Default 0.", limit: Setting.hard(PAGES.probes) }),
      period: Setting.duration({
        default: seconds(PROBE_PERIOD_S),
        min: "1 second",
        max: "1 hour",
        label: "Period",
        help: "periodSeconds: a pod is ready at the first probe after its application is up. Default 10 s.",
        limit: Setting.hard(PAGES.probes)
      })
    },
    { label: "Readiness probe" }
  ),
  queueLimit: Setting.int({
    default: 100,
    min: 0,
    max: 10_000_000,
    unit: "requests",
    label: "Queue limit",
    help: "Requests that may wait for a free worker: in one line in front of the Service when it is called directly, or per pod when a load balancer's target group picks pods. Beyond it, 503. An assumption about your application."
  }),
  fanOut: Setting.choice(["sequential", "parallel", "weighted", "none"], {
    default: "sequential",
    label: "Downstream calls",
    help: "After its own work, call every output one after another, all at once, pick one by weight, or call none."
  }),
  terminationGracePeriod: Setting.duration({
    default: seconds(TERMINATION_GRACE_S),
    min: 0,
    max: "1 hour",
    label: "Termination grace period",
    help: "terminationGracePeriodSeconds: a pod being stopped (scaled in, evicted, rolled over) takes no new requests and has this long to finish what it holds. Default 30 s.",
    limit: Setting.hard(PAGES.podLifecycle)
  }),
  rollingUpdate: Setting.group(
    {
      maxSurge: Setting.int({ default: MAX_SURGE_PERCENT, min: 0, max: 1_000, unit: "%", label: "Max surge", help: "Pods over replicas during a rollout, as a share rounded up. Default 25%.", limit: Setting.hard(PAGES.deployment) }),
      maxUnavailable: Setting.int({
        default: MAX_UNAVAILABLE_PERCENT,
        min: 0,
        max: 100,
        unit: "%",
        label: "Max unavailable",
        help: "Pods under replicas that may be unavailable during a rollout, as a share rounded down. Default 25%. It can't be 0 when max surge is.",
        limit: Setting.hard(PAGES.deployment)
      })
    },
    { label: "Rolling update" }
  ),
  topologySpread: Setting.choice(["zones", "strict", "none"], {
    default: "zones",
    labels: { zones: "Across zones, best effort", strict: "Across zones, maxSkew 1 (DoNotSchedule)", none: "None" },
    label: "Topology spread",
    help: `How pods spread over zones. Best effort: the zone with the fewest first, others if it has no room (the scheduler's default constraint, ScheduleAnyway). Strict: a topology spread constraint with maxSkew 1 and whenUnsatisfiable DoNotSchedule: a pod waits as Pending rather than skew the zones (${PAGES.topologySpread}).`
  }),
  nodeFailure: Setting.group(
    {
      monitorGracePeriod: Setting.duration({
        default: seconds(NODE_MONITOR_GRACE_S),
        min: 0,
        max: "1 hour",
        label: "Node monitor grace period",
        help: "--node-monitor-grace-period: a node that stops reporting is NotReady after this long. 50 s since Kubernetes 1.32 (40 s before).",
        limit: Setting.hard(PAGES.controllerManager)
      }),
      tolerationSeconds: Setting.duration({
        default: seconds(TOLERATION_S),
        min: 0,
        max: "1 day",
        label: "Toleration of a NotReady node",
        help: "tolerationSeconds for the not-ready and unreachable taints, 300 s by default: how long a pod stays bound to a failed node before it is evicted and the ReplicaSet replaces it. Pods on a dead node are replaced this long after it is NotReady (5 min 50 s in all), or sooner if the node is replaced.",
        limit: Setting.hard(PAGES.taints)
      })
    },
    { label: "Node failure" }
  ),
  nodes: Setting.group(
    {
      instanceType: Setting.choice(INSTANCE_TYPE_NAMES, {
        default: DEFAULT_INSTANCE_TYPE,
        label: "Instance type",
        help: "The managed node group's instances. Pods are packed into what each has allocatable (its vCPUs and memory less what the EKS AMI reserves), and they count against the region's EC2 On-Demand vCPU quota."
      }),
      minSize: Setting.int({ default: 1, min: 0, max: NODES_PER_GROUP, unit: "nodes", label: "Minimum size" }),
      maxSize: Setting.int({
        default: 10,
        min: 0,
        max: 100_000,
        unit: "nodes",
        label: "Maximum size",
        help: "What the autoscaler may grow to: the node group's maximum size, or Karpenter's NodePool limit. 450 nodes per managed node group by default (adjustable).",
        limit: Setting.quota(PAGES.quotas, "Nodes per managed node group: 450 by default.")
      }),
      desiredSize: Setting.int({ default: 3, min: 0, max: 100_000, unit: "nodes", label: "Nodes at the start", help: "How many nodes run when the simulation starts. The autoscaler moves it from there." }),
      maxPods: Setting.int({
        default: MAX_PODS_LARGE,
        min: 1,
        max: 737,
        unit: "pods",
        label: "Max pods per node",
        help: "The VPC CNI gives each pod an address, so a node holds ENIs × (IPs per ENI − 1) + 2 pods: 29 for a large instance (m5.large, m7i.large), more for bigger ones. Set it for your instance type. It also sets the memory the kubelet reserves (11 MiB a pod).",
        limit: Setting.hard(PAGES.maxPods)
      }),
      scheduling: Setting.choice(["spread", "binpack"], {
        default: "spread",
        labels: { spread: "Least allocated (spread)", binpack: "Most allocated (bin packing)" },
        label: "Scheduler scoring",
        help: `Within a zone, the node with the most room (the scheduler's default, LeastAllocated) or the least (MostAllocated), which empties nodes for scale-down (${PAGES.scoring}).`
      }),
      autoscaler: Setting.choice(["cluster-autoscaler", "karpenter", "none"], {
        default: "cluster-autoscaler",
        labels: { "cluster-autoscaler": "Cluster Autoscaler", karpenter: "Karpenter", none: "None" },
        label: "Node autoscaler",
        help: "What adds nodes when pods are Pending and removes the ones not needed. Cluster Autoscaler: scans every 10 s and changes the node group's size; removes a node under 50% requested after 10 minutes. Karpenter: batches pending pods (1-10 s), launches nodes directly, and consolidates nodes whose pods fit elsewhere at once."
      }),
      pending: Setting.duration({ default: `${NODE_PENDING_MS / 1000} seconds`, min: 0, max: "15 minutes", label: "Instance pending", help: "A node group instance, from launch until EC2 reports it running. An assumption." }),
      boot: Setting.duration({ default: `${NODE_BOOT_MS / 1000} seconds`, min: 0, max: "15 minutes", label: "Instance boot", help: "The operating system boots. An assumption." }),
      join: Setting.duration({
        default: `${NODE_JOIN_MS / 1000} seconds`,
        min: 0,
        max: "15 minutes",
        label: "Joins the cluster",
        help: "nodeadm configures the kubelet, which registers the node; the CNI starts; the node is Ready and pods can be scheduled on it. An assumption (EKS says 'multiple minutes' for a node; it must bootstrap within 15)."
      }),
      karpenterLaunch: Setting.duration({
        default: `${KARPENTER_NODE_MS / 1000} seconds`,
        min: 0,
        max: "15 minutes",
        label: "Karpenter node ready",
        help: "A node Karpenter launches, from its decision until Ready. An assumption: the EKS docs say Karpenter provisions nodes 'in under a minute'."
      }),
      replaceAfter: Setting.duration({
        default: seconds(STATUS_CHECK_REPLACE_S),
        min: 0,
        max: "1 day",
        label: "Replaces a failed node after",
        help: "How long until a dead instance is found (EC2 status checks) and replaced, which takes its pods off the cluster at once. An assumption ('a few minutes'). A zone that is cut off may leave its instances passing their own checks: set it longer to see Kubernetes' own eviction instead."
      })
    },
    { label: "Managed node group" }
  ),
  clusterAutoscaler: Setting.group(
    {
      scanInterval: Setting.duration({ default: seconds(CA_SCAN_S), min: "1 second", max: "10 minutes", label: "Scan interval", limit: Setting.hard(PAGES.clusterAutoscaler) }),
      scaleDownUnneededTime: Setting.duration({ default: seconds(CA_UNNEEDED_S), min: 0, max: "1 day", label: "Scale-down unneeded time", limit: Setting.hard(PAGES.clusterAutoscaler) }),
      scaleDownDelayAfterAdd: Setting.duration({ default: seconds(CA_DELAY_AFTER_ADD_S), min: 0, max: "1 day", label: "Scale-down delay after add", limit: Setting.hard(PAGES.clusterAutoscaler) }),
      scaleDownUtilizationThreshold: Setting.ratio({
        default: CA_UTILIZATION,
        label: "Scale-down utilization threshold",
        help: "A node whose pods request less than this share of its allocatable CPU and memory, and whose pods fit on other nodes, is unneeded."
      })
    },
    { label: "Cluster Autoscaler" }
  ),
  karpenter: Setting.group(
    {
      batchIdle: Setting.duration({ default: seconds(KARPENTER_BATCH_IDLE_S), min: 0, max: "1 minute", label: "Batch idle duration", limit: Setting.hard(PAGES.karpenterSettings) }),
      batchMax: Setting.duration({ default: seconds(KARPENTER_BATCH_MAX_S), min: 0, max: "5 minutes", label: "Batch max duration", limit: Setting.hard(PAGES.karpenterSettings) }),
      consolidation: Setting.choice(["WhenEmptyOrUnderutilized", "WhenEmpty"], {
        default: "WhenEmptyOrUnderutilized",
        label: "Consolidation policy",
        help: "WhenEmptyOrUnderutilized: remove any node whose pods fit on the others. WhenEmpty: only nodes with no pods."
      }),
      consolidateAfter: Setting.duration({ default: 0, min: 0, max: "1 day", label: "Consolidate after", help: "How long after its pods last changed a node may be consolidated. Default 0.", limit: Setting.hard(PAGES.karpenter) }),
      budget: Setting.int({
        default: KARPENTER_BUDGET_PERCENT,
        min: 0,
        max: 100,
        unit: "%",
        label: "Disruption budget",
        help: "At most this share of nodes is being consolidated at once. Default 10% (at least one).",
        limit: Setting.hard(PAGES.karpenter)
      })
    },
    { label: "Karpenter" }
  )
})

export type Settings = typeof Config.Type
