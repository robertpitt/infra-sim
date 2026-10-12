/**
 * Where AWS and Kubernetes document what an EKS workload does, and the numbers the simulator takes from those pages
 * (checked October 2026: Kubernetes v1.37, Karpenter v1.15). Every constant names its page; README.md lists them with the
 * kind of limit each is (hard, quota or assumed).
 */

export const K8S = "https://kubernetes.io/docs/"
export const EKS = "https://docs.aws.amazon.com/eks/latest/"

export const PAGES = {
  hpa: `${K8S}concepts/workloads/autoscaling/horizontal-pod-autoscale/`,
  deployment: `${K8S}concepts/workloads/controllers/deployment/`,
  probes: `${K8S}tasks/configure-pod-container/configure-liveness-readiness-startup-probes/`,
  podLifecycle: `${K8S}concepts/workloads/pods/pod-lifecycle/`,
  taints: `${K8S}concepts/scheduling-eviction/taint-and-toleration/#taint-based-evictions`,
  controllerManager: `${K8S}reference/command-line-tools-reference/kube-controller-manager/`,
  topologySpread: `${K8S}concepts/scheduling-eviction/topology-spread-constraints/`,
  scoring: `${K8S}concepts/scheduling-eviction/resource-bin-packing/`,
  clusterAutoscaler: "https://github.com/kubernetes/autoscaler/blob/master/cluster-autoscaler/FAQ.md",
  karpenter: "https://karpenter.sh/docs/concepts/disruption/",
  karpenterSettings: "https://karpenter.sh/docs/reference/settings/",
  karpenterEks: `${EKS}best-practices/karpenter.html`,
  casEks: `${EKS}best-practices/cas.html`,
  managedNodeGroups: `${EKS}userguide/managed-node-groups.html`,
  quotas: "https://docs.aws.amazon.com/general/latest/gr/eks.html",
  maxPods: `${EKS}userguide/choosing-instance-type.html`,
  allocatable: "https://github.com/awslabs/amazon-eks-ami/blob/main/nodeadm/internal/kubelet/config.go"
} as const

// ---------------------------------------------------------------------------------------------------------
// Kubernetes defaults
// ---------------------------------------------------------------------------------------------------------

/** A Deployment's rolling update: maxSurge 25% (rounded up) and maxUnavailable 25% (rounded down); minReadySeconds 0. */
export const MAX_SURGE_PERCENT = 25
export const MAX_UNAVAILABLE_PERCENT = 25
/** progressDeadlineSeconds: 600 s. Past it the Deployment reports ProgressDeadlineExceeded and does nothing else. */
export const PROGRESS_DEADLINE_S = 600
/** Probes: period 10 s, timeout 1 s, success threshold 1, failure threshold 3, initial delay 0. */
export const PROBE_PERIOD_S = 10
export const PROBE_FAILURE_THRESHOLD = 3
/** terminationGracePeriodSeconds: 30 s. */
export const TERMINATION_GRACE_S = 30
/**
 * `--node-monitor-grace-period`: a node that stops reporting is NotReady after 50 s (40 s before v1.32). Its pods then
 * get the `unreachable` / `not-ready` taint, which they tolerate for 300 s by default (DefaultTolerationSeconds), so they
 * are evicted, and replaced, about 5 min 50 s after the node died.
 */
export const NODE_MONITOR_GRACE_S = 50
export const TOLERATION_S = 300
/** CrashLoopBackOff: restarts 10 s, 20 s, 40 s... apart, capped at 300 s. */
export const BACKOFF_FIRST_S = 10
export const BACKOFF_CAP_S = 300

// ---------------------------------------------------------------------------------------------------------
// Node autoscalers
// ---------------------------------------------------------------------------------------------------------

/**
 * Cluster Autoscaler (FAQ): scans every 10 s; a node is unneeded below 50% utilization (requests over allocatable, CPU or
 * memory) and is removed after 10 minutes unneeded; no scale-down for 10 minutes after a scale-up.
 */
export const CA_SCAN_S = 10
export const CA_UNNEEDED_S = 600
export const CA_DELAY_AFTER_ADD_S = 600
export const CA_UTILIZATION = 0.5
/** Empty nodes the Cluster Autoscaler deletes at once (`--max-empty-bulk-delete`, 10). */
export const CA_EMPTY_BULK = 10
/** Karpenter: pending pods are batched until 1 s passes with none new, or 10 s in all; consolidateAfter 0 s; budget 10% of nodes. */
export const KARPENTER_BATCH_IDLE_S = 1
export const KARPENTER_BATCH_MAX_S = 10
export const KARPENTER_BUDGET_PERCENT = 10

// ---------------------------------------------------------------------------------------------------------
// EKS
// ---------------------------------------------------------------------------------------------------------

/** Nodes per managed node group: 450 by default, adjustable (`eks.html`). */
export const NODES_PER_GROUP = 450
/** Max pods for a `large` instance with the VPC CNI: 3 ENIs × (10 IPs − 1) + 2 = 29 (m5.large, `choosing-instance-type.html`). */
export const MAX_PODS_LARGE = 29

/**
 * Allocatable on the EKS AMI (`nodeadm/internal/kubelet/config.go`): kube-reserved memory is 11 MiB per pod plus 255 MiB;
 * kube-reserved CPU is 6% of the first core, 1% of the second, 0.5% of the third and fourth and 0.25% of every other; and
 * kubelet evicts at 100 MiB free. An m5.large keeps 70m and 574 MiB back.
 */
export const reservedMemoryMiB = (maxPods: number): number => 11 * maxPods + 255
export const reservedCpu = (cores: number): number => {
  let r = 0
  for (let c = 1; c <= cores; c++) r += c === 1 ? 0.06 : c === 2 ? 0.01 : c <= 4 ? 0.005 : 0.0025
  return r
}
export const EVICTION_MIB = 100

// ---------------------------------------------------------------------------------------------------------
// Assumptions
// ---------------------------------------------------------------------------------------------------------

/** A node of a managed node group: EC2 pending and boot (as for any instance), then nodeadm, kubelet and the CNI until Ready. Assumed 30 s each. */
export const NODE_PENDING_MS = 30_000
export const NODE_BOOT_MS = 30_000
export const NODE_JOIN_MS = 30_000
/** A node Karpenter launches, until Ready: the EKS docs say Karpenter provisions "in under a minute". Assumed 50 s. */
export const KARPENTER_NODE_MS = 50_000
/** How often Karpenter looks for nodes to consolidate. Assumed 10 s. */
export const KARPENTER_CONSOLIDATION_PERIOD_MS = 10_000
/** How fast an image is pulled and unpacked onto a node. Assumed 25 MiB/s, as for ECS. */
export const PULL_MIB_PER_S = 25
/** From the image being on the node to the container running. Assumed 1 s. */
export const CONTAINER_START_MS = 1_000
