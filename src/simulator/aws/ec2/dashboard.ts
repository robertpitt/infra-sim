import { type Dashboard, dist, gauge, latencyPanel, rate } from "../../Dashboard.ts"

/**
 * An Auto Scaling group's dashboard, as the EC2 console's Monitoring tab and CloudWatch show one: the group metrics
 * (desired, in service, pending, terminating, its bounds), the instances' CPU, the requests reaching them (as the load
 * balancer in front counts them), launches and terminations, the warm pool, Spot, and the vCPU quotas the region shares.
 * Names follow CloudWatch's (https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-metrics.html, and
 * AWS/EC2's CPUUtilization by AutoScalingGroupName).
 */
export const dashboard: Dashboard = {
  figures: [
    { label: "In service", metric: gauge("inService"), unit: "count", cloudwatch: "GroupInServiceInstances" },
    { label: "Desired", metric: gauge("desired"), unit: "count", cloudwatch: "GroupDesiredCapacity" },
    { label: "CPU", metric: gauge("utilization"), unit: "ratio", cloudwatch: "CPUUtilization" },
    { label: "Requests", metric: rate("in"), unit: "perSecond", cloudwatch: "RequestCount" },
    { label: "Failed", metric: rate("fail"), unit: "perSecond", tone: "bad", cloudwatch: "HTTPCode_Target_5XX_Count" },
    { label: "Response p95", metric: dist("latency", "p95"), unit: "ms", cloudwatch: "TargetResponseTime" }
  ],
  panels: [
    {
      id: "group-size",
      title: "Group size",
      unit: "count",
      cloudwatch: ["GroupInServiceInstances", "GroupPendingInstances", "GroupTerminatingInstances", "GroupDesiredCapacity"],
      help: "Instances in service, launching and terminating, against the capacity the group is asked for (kept between its minimum and maximum size). In service lagging desired is the launch time.",
      lines: [
        { label: "in service", metric: gauge("inService"), tone: "primary" },
        { label: "pending", metric: gauge("pending"), tone: "warn" },
        { label: "terminating", metric: gauge("draining"), tone: "bad" },
        { label: "desired", metric: gauge("desired"), tone: "accent", dashed: true }
      ]
    },
    {
      id: "cpu",
      title: "CPU utilization",
      unit: "ratio",
      cloudwatch: ["CPUUtilization", "ASGAverageCPUUtilization"],
      help: "Busy vCPUs over the vCPUs of the instances serving. Dashed: what a target-tracking policy sees, which leaves out instances still in their warmup.",
      lines: [
        { label: "average", metric: gauge("utilization"), tone: "primary" },
        { label: "scaling metric", metric: gauge("cpu"), tone: "accent", dashed: true }
      ]
    },
    {
      id: "requests",
      title: "Requests",
      unit: "perSecond",
      cloudwatch: ["RequestCount", "HTTPCode_Target_5XX_Count"],
      help: "Requests reaching the instances, the ones answered, and the ones that failed: an error downstream, or unavailable (503) because every worker and the queue were full or the instance was lost.",
      lines: [
        { label: "requests", metric: rate("in"), tone: "primary" },
        { label: "ok", metric: rate("ok"), tone: "ok" },
        { label: "failed", metric: rate("fail"), tone: "bad" },
        { label: "unavailable (503)", metric: rate("fail.Unavailable"), tone: "warn" }
      ]
    },
    latencyPanel("latency", "Response time", "latency", ["TargetResponseTime"]),
    {
      id: "requests-per-target",
      title: "Request count per target",
      unit: "perMinute",
      cloudwatch: ["RequestCountPerTarget"],
      help: "Requests in the last minute over the instances serving: the per-minute figure a request-count target-tracking policy holds near its target.",
      lines: [{ label: "per instance", metric: gauge("requestCountPerTarget"), tone: "primary" }]
    },
    {
      id: "launches",
      title: "Launches and terminations",
      unit: "perSecond",
      help: "The group's activity history: instances launched (from scratch or from the warm pool), launches EC2 refused (vCPU quota, no Spot capacity; the group retries), and instances terminated.",
      lines: [
        { label: "launched", metric: rate("launches"), tone: "primary" },
        { label: "from warm pool", metric: rate("warmStarts"), tone: "teal" },
        { label: "refused", metric: rate("launchRefused"), tone: "bad" },
        { label: "terminated", metric: rate("terminations"), tone: "muted" }
      ]
    },
    {
      id: "warm-pool",
      title: "Warm pool",
      unit: "count",
      cloudwatch: ["WarmPoolWarmedCapacity", "WarmPoolPendingCapacity", "WarmPoolDesiredCapacity"],
      help: "Pre-initialised instances ready to enter the group at a scale-out, ones being prepared, and the size the pool is kept at. Shown once the group has a warm pool.",
      requires: "warmDesired",
      lines: [
        { label: "warmed", metric: gauge("warm"), tone: "teal" },
        { label: "pending", metric: gauge("warmPreparing"), tone: "warn" },
        { label: "desired", metric: gauge("warmDesired"), tone: "muted", dashed: true }
      ]
    },
    {
      id: "purchase",
      title: "On-Demand and Spot",
      unit: "count",
      help: "Instances by purchase option, the Spot instances the group's split (On-Demand base, then a percentage above it) asks for, and Spot instances that have their two-minute interruption notice. Shown once the group buys Spot.",
      requires: "spotDesired",
      lines: [
        { label: "On-Demand", metric: gauge("onDemand"), tone: "primary" },
        { label: "Spot", metric: gauge("spot"), tone: "accent" },
        { label: "Spot desired", metric: gauge("spotDesired"), tone: "accent", dashed: true },
        { label: "noticed", metric: gauge("spotNoticed"), tone: "bad" }
      ]
    },
    {
      id: "spot",
      title: "Spot interruptions",
      unit: "perSecond",
      cloudwatch: ["EC2 Spot Instance Interruption Warning (EventBridge)", "EC2 Instance Rebalance Recommendation (EventBridge)"],
      help: "Interruption notices (the instance goes two minutes later) and rebalance recommendations (an earlier signal; with Capacity Rebalancing on, the group launches a replacement). EC2 sends these as events, not metrics; here both are counted when EC2 decides to reclaim the instance. Shown once the group buys Spot.",
      requires: "spotDesired",
      lines: [
        { label: "rebalance recommendations", metric: rate("rebalanceRecommendations"), tone: "warn" },
        { label: "interruptions", metric: rate("spotInterruptions"), tone: "bad" }
      ]
    },
    {
      id: "vcpus",
      title: "Running vCPUs in the region",
      unit: "count",
      cloudwatch: ["ResourceCount (AWS/Usage, Standard/OnDemand)", "ResourceCount (AWS/Usage, Standard/Spot)"],
      help: "The vCPUs of every instance in the region (every group's, warm pools' and ECS and EKS capacity's) against the account's Standard vCPU quotas: past a quota, launches are refused and the group retries.",
      lines: [
        { label: "On-Demand", metric: gauge("vcpusOnDemand"), tone: "primary" },
        { label: "On-Demand quota", metric: gauge("vcpuQuotaOnDemand"), tone: "primary", dashed: true },
        { label: "Spot", metric: gauge("vcpusSpot"), tone: "accent" },
        { label: "Spot quota", metric: gauge("vcpuQuotaSpot"), tone: "accent", dashed: true }
      ]
    }
  ]
}
