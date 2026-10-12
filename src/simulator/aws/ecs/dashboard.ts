import { type Dashboard, dist, gauge, latencyPanel, rate } from "../../Dashboard.ts"

/**
 * A service's dashboard, as the ECS console's Health and metrics tab, CloudWatch (AWS/ECS) and Container Insights
 * (ECS/ContainerInsights) show one: task counts, CPU, the requests reaching the tasks, the deployment, task churn, and on
 * an EC2 capacity provider the cluster's instances and reservations. Names follow CloudWatch's
 * (https://docs.aws.amazon.com/AmazonECS/latest/developerguide/available-metrics.html,
 * https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Container-Insights-metrics-ECS.html).
 */
export const dashboard: Dashboard = {
  figures: [
    { label: "Running", metric: gauge("running"), unit: "count", cloudwatch: "RunningTaskCount" },
    { label: "Desired", metric: gauge("desired"), unit: "count", cloudwatch: "DesiredTaskCount" },
    { label: "CPU", metric: gauge("cpu"), unit: "ratio", cloudwatch: "CPUUtilization" },
    { label: "Requests", metric: rate("in"), unit: "perSecond", cloudwatch: "RequestCount" },
    { label: "Failed", metric: rate("fail"), unit: "perSecond", tone: "bad", cloudwatch: "HTTPCode_Target_5XX_Count" },
    { label: "Response p95", metric: dist("latency", "p95"), unit: "ms", cloudwatch: "TargetResponseTime" }
  ],
  panels: [
    {
      id: "tasks",
      title: "Task count",
      unit: "count",
      cloudwatch: ["RunningTaskCount", "PendingTaskCount", "DesiredTaskCount"],
      help: "Tasks running, on their way (waiting for capacity, pulling their image, starting) and stopping, against the desired count. Waiting for capacity is PROVISIONING: a Fargate quota, the launch rate, or no room on an instance.",
      lines: [
        { label: "running", metric: gauge("running"), tone: "primary" },
        { label: "pending", metric: gauge("pending"), tone: "warn" },
        { label: "waiting for capacity", metric: gauge("provisioning"), tone: "bad" },
        { label: "stopping", metric: gauge("draining"), tone: "muted" },
        { label: "desired", metric: gauge("desired"), tone: "accent", dashed: true }
      ]
    },
    {
      id: "cpu",
      title: "CPU utilization",
      unit: "ratio",
      cloudwatch: ["CPUUtilization"],
      help: "The CPU the service's running tasks use over the CPU their task definition reserves. Service auto scaling's CPU target reads this.",
      lines: [{ label: "service", metric: gauge("cpu"), tone: "primary" }]
    },
    {
      id: "requests",
      title: "Requests",
      unit: "perSecond",
      cloudwatch: ["RequestCount", "HTTPCode_Target_5XX_Count"],
      help: "Requests reaching the tasks, the ones answered, and the ones that failed: a broken revision or a downstream error (500), or unavailable (503) because every task was busy and its queue full, or its task was lost.",
      lines: [
        { label: "requests", metric: rate("in"), tone: "primary" },
        { label: "ok", metric: rate("ok"), tone: "ok" },
        { label: "failed", metric: rate("fail"), tone: "bad" },
        { label: "unavailable (503)", metric: rate("fail.Unavailable"), tone: "warn" }
      ]
    },
    latencyPanel("latency", "Response time", "latency", ["TargetResponseTime"]),
    {
      id: "deployment",
      title: "Deployment",
      unit: "count",
      help: "During a rolling deployment, tasks of the revision being deployed replacing the others (after a rollback, the revision rolled back to is the one being deployed). Failed tasks count toward the deployment circuit breaker, which fails (or rolls back) the deployment at its threshold.",
      lines: [
        { label: "new revision", metric: gauge("newTasks"), tone: "primary" },
        { label: "old revision", metric: gauge("oldTasks"), tone: "muted" },
        { label: "failed tasks", metric: gauge("breakerFailures"), tone: "bad" },
        { label: "breaker threshold", metric: gauge("breakerThreshold"), tone: "bad", dashed: true }
      ]
    },
    {
      id: "churn",
      title: "Task launches and stops",
      unit: "perSecond",
      help: "The service's events as rates: tasks launched, tasks stopped (scaled in, replaced, crashed, interrupted), tasks that failed (crashed as they started, or failed their health checks), and Fargate Spot interruptions (a two-minute warning, then the task stops and a replacement starts).",
      lines: [
        { label: "launched", metric: rate("taskLaunches"), tone: "primary" },
        { label: "stopped", metric: rate("taskStops"), tone: "muted" },
        { label: "failed", metric: rate("taskFailures"), tone: "bad" },
        { label: "Spot interruptions", metric: rate("spotInterruptions"), tone: "warn" }
      ]
    },
    {
      id: "fargate",
      title: "Fargate capacity providers",
      unit: "count",
      help: "Tasks running or starting on FARGATE and on FARGATE_SPOT, as the capacity provider strategy splits them.",
      requires: "fargate",
      lines: [
        { label: "FARGATE", metric: gauge("fargate"), tone: "primary" },
        { label: "FARGATE_SPOT", metric: gauge("spot"), tone: "accent" }
      ]
    },
    {
      id: "instances",
      title: "Container instances",
      unit: "count",
      cloudwatch: ["ContainerInstanceCount", "GroupDesiredCapacity"],
      help: "On an EC2 capacity provider: the instances registered, those launching, and the group size managed scaling asks for.",
      lines: [
        { label: "registered", metric: gauge("instances"), tone: "primary" },
        { label: "launching", metric: gauge("instancesLaunching"), tone: "warn" },
        { label: "desired", metric: gauge("instancesDesired"), tone: "accent", dashed: true }
      ]
    },
    {
      id: "reservation",
      title: "Cluster reservation",
      unit: "ratio",
      cloudwatch: ["CPUReservation", "MemoryReservation", "CapacityProviderReservation"],
      help: "On an EC2 capacity provider: CPU and memory the tasks reserve over what the instances have, and the capacity provider reservation (instances needed over instances running) that managed scaling holds at its target. Above the target it adds instances.",
      lines: [
        { label: "CPU reserved", metric: gauge("cpuReservation"), tone: "primary" },
        { label: "memory reserved", metric: gauge("memoryReservation"), tone: "teal" },
        { label: "capacity provider", metric: gauge("capacityProviderReservation"), tone: "warn" },
        { label: "target", metric: gauge("targetCapacity"), tone: "warn", dashed: true }
      ]
    }
  ]
}
