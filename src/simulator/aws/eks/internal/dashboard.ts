import { type Dashboard, gauge, latencyPanel, rate, ratio, sum } from "../../../Dashboard.ts"

/**
 * A workload's dashboard, as Container Insights for Amazon EKS shows a cluster and its pods: pods by status against the
 * Deployment's replicas, pod and node CPU, nodes and what the pods' requests reserve of them, the requests reaching the
 * pods, and the rollout. Names follow Container Insights'
 * (https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Container-Insights-metrics-EKS.html, and its enhanced
 * observability metrics, Container-Insights-metrics-enhanced-EKS.html).
 */
export const dashboard: Dashboard = {
  figures: [
    { label: "Ready pods", metric: gauge("ready"), unit: "count", cloudwatch: "pod_status_ready" },
    { label: "Pending pods", metric: gauge("pending"), unit: "count", tone: "warn", cloudwatch: "pod_status_pending" },
    { label: "Nodes", metric: gauge("nodes"), unit: "count", cloudwatch: "cluster_node_count" },
    { label: "Pod CPU", metric: gauge("cpu"), unit: "ratio", cloudwatch: "pod_cpu_utilization_over_pod_limit" },
    { label: "Requests", metric: rate("in"), unit: "perSecond", cloudwatch: "RequestCount" },
    { label: "Failed", metric: rate("fail"), unit: "perSecond", tone: "bad", cloudwatch: "HTTPCode_Target_5XX_Count" }
  ],
  panels: [
    {
      id: "pods",
      title: "Pods",
      unit: "count",
      cloudwatch: ["pod_status_ready", "pod_status_pending", "service_number_of_running_pods"],
      help: "Pods ready (in the Service's endpoints), pending because no node has room for their requests, and scheduled but not ready yet (pulling the image, starting, failing readiness), against the Deployment's replicas.",
      lines: [
        { label: "ready", metric: gauge("ready"), tone: "primary" },
        { label: "pending", metric: gauge("pending"), tone: "bad" },
        { label: "starting", metric: gauge("starting"), tone: "warn" },
        { label: "replicas", metric: gauge("replicas"), tone: "accent", dashed: true }
      ]
    },
    {
      id: "cpu",
      title: "CPU utilization",
      unit: "ratio",
      cloudwatch: ["pod_cpu_utilization_over_pod_limit", "node_cpu_utilization"],
      help: "Pods: the CPU they use over what they request, which the Horizontal Pod Autoscaler's CPU target reads (the simulator takes the limit to be the request). Nodes: the CPU pods use over the nodes' allocatable.",
      lines: [
        { label: "pods", metric: gauge("cpu"), tone: "primary" },
        { label: "nodes", metric: gauge("nodeCpu"), tone: "teal" }
      ]
    },
    {
      id: "requests",
      title: "Requests",
      unit: "perSecond",
      cloudwatch: ["RequestCount", "HTTPCode_Target_5XX_Count"],
      help: "Requests reaching the pods, the ones answered, and the ones that failed: a downstream error (500), or unavailable (503) because every pod was busy and its queue full, or its pod was lost with its node.",
      lines: [
        { label: "requests", metric: rate("in"), tone: "primary" },
        { label: "ok", metric: rate("ok"), tone: "ok" },
        { label: "failed", metric: rate("fail"), tone: "bad" },
        { label: "unavailable (503)", metric: rate("fail.Unavailable"), tone: "warn" }
      ]
    },
    latencyPanel("latency", "Response time", "latency", ["TargetResponseTime"]),
    {
      id: "nodes",
      title: "Nodes",
      unit: "count",
      cloudwatch: ["cluster_node_count"],
      help: "Nodes ready, nodes launching, and the size the node autoscaler (Cluster Autoscaler or Karpenter) wants. Pending pods are what make it add nodes.",
      lines: [
        { label: "ready", metric: gauge("nodes"), tone: "primary" },
        { label: "launching", metric: gauge("nodesLaunching"), tone: "warn" },
        { label: "desired", metric: gauge("nodesDesired"), tone: "accent", dashed: true }
      ]
    },
    {
      id: "reserved",
      title: "Node reserved capacity",
      unit: "ratio",
      cloudwatch: ["node_cpu_reserved_capacity", "node_memory_reserved_capacity"],
      help: "What the pods' CPU and memory requests take of the nodes' allocatable. The scheduler places by requests, not use: a node full of requests takes no more pods however idle it is.",
      lines: [
        { label: "CPU", metric: gauge("requestedCpu"), tone: "primary" },
        { label: "memory", metric: gauge("requestedMemory"), tone: "teal" }
      ]
    },
    {
      id: "pods-per-node",
      title: "Pods per node",
      unit: "count",
      cloudwatch: ["node_number_of_running_pods"],
      help: "Running pods (ready or starting) over the nodes ready, on average.",
      lines: [{ label: "pods per node", metric: ratio(sum(gauge("ready"), gauge("starting")), gauge("nodes")), tone: "primary" }]
    },
    {
      id: "rollout",
      title: "Rollout",
      unit: "count",
      cloudwatch: ["pod_container_status_waiting_reason_crash_loop_back_off"],
      help: "During a rolling update, pods of the new template replacing the old. Pods in CrashLoopBackOff never become ready, so a broken revision stalls the rollout rather than finishing it.",
      lines: [
        { label: "new revision", metric: gauge("newPods"), tone: "primary" },
        { label: "old revision", metric: gauge("oldPods"), tone: "muted" },
        { label: "CrashLoopBackOff", metric: gauge("crashLooping"), tone: "bad" }
      ]
    }
  ]
}
