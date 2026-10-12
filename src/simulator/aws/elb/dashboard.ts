import { type Dashboard, dist, gauge, latencyPanel, rate, sum } from "../../Dashboard.ts"

/**
 * The load balancers' dashboards and their target groups', as the EC2 console's Monitoring tabs and CloudWatch show them.
 * Names follow CloudWatch's: `AWS/ApplicationELB`
 * (https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-cloudwatch-metrics.html) and
 * `AWS/NetworkELB` (https://docs.aws.amazon.com/elasticloadbalancing/latest/network/load-balancer-cloudwatch-metrics.html).
 */

/** An Application Load Balancer: requests, its own errors and its targets', target response time, hosts, capacity. */
export const albDashboard: Dashboard = {
  figures: [
    { label: "Requests", metric: rate("requests"), unit: "perSecond", cloudwatch: "RequestCount" },
    { label: "ELB 5XX", metric: rate("elb.5xx"), unit: "perSecond", tone: "bad", cloudwatch: "HTTPCode_ELB_5XX_Count" },
    { label: "Target 5XX", metric: rate("target.5xx"), unit: "perSecond", tone: "bad", cloudwatch: "HTTPCode_Target_5XX_Count" },
    { label: "Target response p95", metric: dist("targetResponseTime", "p95"), unit: "ms", cloudwatch: "TargetResponseTime" },
    { label: "Healthy hosts", metric: gauge("healthyHosts"), unit: "count", cloudwatch: "HealthyHostCount" },
    { label: "Capacity used", metric: gauge("capacityUtilization"), unit: "ratio", cloudwatch: "CapacityUtilization" }
  ],
  panels: [
    {
      id: "requests",
      title: "Requests",
      unit: "perSecond",
      cloudwatch: ["RequestCount", "RejectedConnectionCount"],
      help: "Requests the load balancer sent to a target group, those that ended well, and connections it turned away while it scaled.",
      lines: [
        { label: "requests", metric: rate("requests"), tone: "primary" },
        { label: "ok", metric: rate("ok"), tone: "ok" },
        { label: "rejected", metric: rate("rejectedConnections"), tone: "bad" }
      ]
    },
    {
      id: "elb-errors",
      title: "Load balancer errors",
      unit: "perSecond",
      cloudwatch: ["HTTPCode_ELB_502_Count", "HTTPCode_ELB_503_Count", "HTTPCode_ELB_504_Count", "HTTPCode_ELB_4XX_Count"],
      help: "Errors the load balancer answered itself. 502: the target refused or closed the connection, or a Lambda target failed. 503: no target to send to. 504: no answer within the idle timeout. 4XX: a Lambda request over 1 MB (413), or a client that gave up (460).",
      lines: [
        { label: "502", metric: rate("elb.502"), tone: "bad" },
        { label: "503", metric: rate("elb.503"), tone: "warn" },
        { label: "504", metric: rate("elb.504"), tone: "accent" },
        { label: "4XX", metric: rate("elb.4xx"), tone: "muted" }
      ]
    },
    {
      id: "target-errors",
      title: "Target errors",
      unit: "perSecond",
      cloudwatch: ["HTTPCode_Target_5XX_Count", "HTTPCode_Target_4XX_Count", "TargetConnectionErrorCount"],
      help: "Errors from behind the load balancer: the targets' own 5XX and 4XX passed on, and connections a target refused. A Lambda target's failures (LambdaUserError, LambdaInternalError) are on its edge.",
      lines: [
        { label: "5XX", metric: rate("target.5xx"), tone: "bad" },
        { label: "4XX", metric: rate("target.4xx"), tone: "warn" },
        { label: "connection errors", metric: rate("targetConnectionErrors"), tone: "accent" }
      ]
    },
    {
      ...latencyPanel("target-response-time", "Target response time", "targetResponseTime", ["TargetResponseTime"]),
      help: "From the request leaving the load balancer to the target's answer, for requests a target answered (not the load balancer's own 502, 503 and 504)."
    },
    {
      id: "hosts",
      title: "Healthy hosts",
      unit: "count",
      cloudwatch: ["HealthyHostCount", "UnHealthyHostCount"],
      help: "Targets passing and failing their health checks, summed over the load balancer's target groups. A deregistered target leaves the healthy count without joining the unhealthy one.",
      lines: [
        { label: "healthy", metric: gauge("healthyHosts"), tone: "ok" },
        { label: "unhealthy", metric: gauge("unhealthyHosts"), tone: "bad" }
      ]
    },
    {
      id: "lcu",
      title: "Capacity units",
      unit: "units",
      cloudwatch: ["ConsumedLCUs", "ReservedLCUs"],
      help: "LCUs the traffic needs (the largest of new connections, active connections, bytes and rule evaluations), against what the load balancer has scaled to and any reservation it keeps.",
      lines: [
        { label: "consumed", metric: gauge("consumed.lcu"), tone: "primary" },
        { label: "capacity", metric: gauge("capacity.lcu"), tone: "muted", dashed: true },
        { label: "reserved", metric: gauge("reserved.lcu"), tone: "accent", dashed: true }
      ]
    },
    {
      id: "capacity-utilization",
      title: "Capacity utilization",
      unit: "ratio",
      cloudwatch: ["CapacityUtilization"],
      help: "Demand over capacity. It reaches 100% when traffic grows faster than the load balancer scales, and connections are rejected.",
      lines: [{ label: "utilization", metric: gauge("capacityUtilization"), tone: "warn" }]
    },
    {
      id: "connections",
      title: "Active connections",
      unit: "count",
      cloudwatch: ["ActiveConnectionCount"],
      help: "Requests in flight through the load balancer: the connections it holds open for them (idle keep-alive connections are not modelled).",
      lines: [{ label: "active", metric: gauge("activeConnections"), tone: "accent" }]
    },
    {
      id: "bytes",
      title: "Processed bytes",
      unit: "bytesPerSecond",
      cloudwatch: ["ProcessedBytes"],
      help: "Bytes of the requests the load balancer took. Responses carry no size here, so this counts one direction.",
      lines: [{ label: "processed", metric: rate("processedBytes"), tone: "teal" }]
    },
    {
      id: "zones",
      title: "Zones in DNS",
      unit: "count",
      cloudwatch: ["HealthyStateDNS"],
      help: "Zones whose address the load balancer's DNS name answers with. A zone leaves when its node is down or its targets are unhealthy, and clients that cached it keep coming for the DNS TTL.",
      lines: [{ label: "zones", metric: gauge("zones.inDns"), tone: "primary" }]
    }
  ]
}

/** A Network Load Balancer: flows, resets, hosts, bytes and capacity. It has no HTTP codes or response time of its own. */
export const nlbDashboard: Dashboard = {
  figures: [
    { label: "New flows", metric: rate("requests"), unit: "perSecond", cloudwatch: "NewFlowCount" },
    { label: "Active flows", metric: gauge("activeFlows"), unit: "count", cloudwatch: "ActiveFlowCount" },
    { label: "ELB resets", metric: rate("elb.resets"), unit: "perSecond", tone: "bad", cloudwatch: "TCP_ELB_Reset_Count" },
    { label: "Target resets", metric: rate("target.resets"), unit: "perSecond", tone: "warn", cloudwatch: "TCP_Target_Reset_Count" },
    { label: "Healthy hosts", metric: gauge("healthyHosts"), unit: "count", cloudwatch: "HealthyHostCount" },
    { label: "Consumed LCUs", metric: gauge("consumed.lcu"), unit: "units", cloudwatch: "ConsumedLCUs" }
  ],
  panels: [
    {
      id: "flows",
      title: "New flows",
      unit: "perSecond",
      cloudwatch: ["NewFlowCount"],
      help: "Connections from clients to targets, one per request here, and those that reached a load balancer node whose zone is down (which CloudWatch can't count).",
      lines: [
        { label: "new flows", metric: rate("requests"), tone: "primary" },
        { label: "to a dead node", metric: rate("deadNode"), tone: "bad" }
      ]
    },
    {
      id: "active-flows",
      title: "Active flows",
      unit: "count",
      cloudwatch: ["ActiveFlowCount"],
      help: "Connections open through the load balancer: those whose request is still in flight (idle connections are not modelled).",
      lines: [{ label: "active", metric: gauge("activeFlows"), tone: "accent" }]
    },
    {
      id: "resets",
      title: "Resets",
      unit: "perSecond",
      cloudwatch: ["TCP_ELB_Reset_Count", "TCP_Target_Reset_Count", "TCP_Client_Reset_Count"],
      help: "Resets the load balancer sent (no target, or the idle timeout), resets from targets (refused or dropped connections) passed on, and clients that gave up and closed their connection.",
      lines: [
        { label: "load balancer", metric: rate("elb.resets"), tone: "bad" },
        { label: "target", metric: rate("target.resets"), tone: "warn" },
        { label: "client", metric: rate("client.resets"), tone: "muted" }
      ]
    },
    {
      id: "hosts",
      title: "Healthy hosts",
      unit: "count",
      cloudwatch: ["HealthyHostCount", "UnHealthyHostCount"],
      help: "Targets passing and failing their health checks, summed over the load balancer's target groups.",
      lines: [
        { label: "healthy", metric: gauge("healthyHosts"), tone: "ok" },
        { label: "unhealthy", metric: gauge("unhealthyHosts"), tone: "bad" }
      ]
    },
    {
      id: "bytes",
      title: "Processed bytes",
      unit: "bytesPerSecond",
      cloudwatch: ["ProcessedBytes"],
      help: "Bytes of the connections' requests. Responses carry no size here, so this counts one direction.",
      lines: [{ label: "processed", metric: rate("processedBytes"), tone: "teal" }]
    },
    {
      id: "lcu",
      title: "Capacity units",
      unit: "units",
      cloudwatch: ["ConsumedLCUs"],
      help: "LCUs the traffic uses (the largest of new flows, active flows and bytes), and the most it has used so far. An NLB doesn't turn connections away for capacity here.",
      lines: [
        { label: "consumed", metric: gauge("consumed.lcu"), tone: "primary" },
        { label: "peak", metric: gauge("peak.lcu"), tone: "muted", dashed: true }
      ]
    },
    {
      id: "zones",
      title: "Zones in DNS",
      unit: "count",
      cloudwatch: ["ZonalHealthStatus"],
      help: "Zones whose address the load balancer's DNS name answers with. A zone with no healthy target leaves it.",
      lines: [{ label: "zones", metric: gauge("zones.inDns"), tone: "primary" }]
    },
    {
      ...latencyPanel("latency", "Connection time"),
      help: "From the load balancer taking a connection's request to the target's answer. A Network Load Balancer publishes no latency metric."
    }
  ]
}

/** What both load balancers' target groups into fleets record on their edges. */
const targetHealth = {
  id: "target-health",
  title: "Target health",
  unit: "count",
  cloudwatch: ["HealthyHostCount", "UnHealthyHostCount"],
  help: "The target group's targets by health: passing their checks, failing them, registered and waiting for their first pass, and deregistered and draining their requests.",
  lines: [
    { label: "healthy", metric: gauge("targets.healthy"), tone: "ok" },
    { label: "unhealthy", metric: gauge("targets.unhealthy"), tone: "bad" },
    { label: "initial", metric: gauge("targets.initial"), tone: "teal" },
    { label: "draining", metric: gauge("targets.draining"), tone: "muted" }
  ]
} as const

/** An ALB target group into a fleet, on its edge after transport's (whose latency is this group's TargetResponseTime). */
export const albTargetGroupDashboard: Dashboard = {
  figures: [
    { label: "Healthy hosts", metric: gauge("targets.healthy"), unit: "count", cloudwatch: "HealthyHostCount" },
    { label: "Unhealthy hosts", metric: gauge("targets.unhealthy"), unit: "count", tone: "bad", cloudwatch: "UnHealthyHostCount" },
    { label: "Requests/min per target", metric: gauge("requestCountPerTarget"), unit: "count", cloudwatch: "RequestCountPerTarget" }
  ],
  panels: [
    targetHealth,
    {
      id: "per-target",
      title: "Request count per target",
      unit: "count",
      cloudwatch: ["RequestCountPerTarget"],
      help: "Requests a minute per healthy target (per registered target when none is healthy), at the current rate: AWS's unit, and what target tracking on ALBRequestCountPerTarget holds.",
      lines: [{ label: "requests a minute", metric: gauge("requestCountPerTarget"), tone: "primary" }]
    },
    {
      id: "no-target",
      title: "Requests with no target",
      unit: "perSecond",
      cloudwatch: ["HTTPCode_ELB_503_Count"],
      help: "Requests this target group had no target for (none registered, or none in the zone they arrived in with cross-zone off): the load balancer's 503.",
      lines: [{ label: "no target", metric: rate("noTarget"), tone: "bad" }]
    }
  ]
}

/** An NLB target group into a fleet. */
export const nlbTargetGroupDashboard: Dashboard = {
  figures: [
    { label: "Healthy hosts", metric: gauge("targets.healthy"), unit: "count", cloudwatch: "HealthyHostCount" },
    { label: "Unhealthy hosts", metric: gauge("targets.unhealthy"), unit: "count", tone: "bad", cloudwatch: "UnHealthyHostCount" }
  ],
  panels: [
    targetHealth,
    {
      id: "no-target",
      title: "Flows with no target",
      unit: "perSecond",
      cloudwatch: ["TCP_ELB_Reset_Count"],
      help: "Connections this target group had no target for (none registered, or none in the zone they arrived in with cross-zone off): the load balancer resets them.",
      lines: [{ label: "no target", metric: rate("noTarget"), tone: "bad" }]
    }
  ]
}

/** How the ALB reads a Lambda target's failures: not reached at all is internal, anything the function did is the user's. */
const lambdaUserError = sum(rate("fail.Failed"), rate("fail.Throttled"), rate("fail.Timeout"), rate("fail.Rejected"))

/** An ALB target group of type lambda. */
export const lambdaTargetDashboard: Dashboard = {
  figures: [
    { label: "Lambda user errors", metric: lambdaUserError, unit: "perSecond", tone: "bad", cloudwatch: "LambdaUserError" },
    { label: "Lambda internal errors", metric: rate("fail.Unavailable"), unit: "perSecond", tone: "bad", cloudwatch: "LambdaInternalError" }
  ],
  panels: [
    {
      id: "lambda-errors",
      title: "Lambda errors",
      unit: "perSecond",
      cloudwatch: ["LambdaUserError", "LambdaInternalError"],
      help: "Invocations that failed, each a 502 at the load balancer: because of the function (it failed, timed out or was throttled), or because it couldn't be reached.",
      lines: [
        { label: "user error", metric: lambdaUserError, tone: "bad" },
        { label: "internal error", metric: rate("fail.Unavailable"), tone: "warn" }
      ]
    },
    {
      id: "bytes",
      title: "Processed bytes",
      unit: "bytesPerSecond",
      cloudwatch: ["LambdaTargetProcessedBytes"],
      help: "Bytes of the requests sent to the function. Responses carry no size here, so this counts one direction.",
      lines: [{ label: "processed", metric: rate("processedBytes"), tone: "teal" }]
    }
  ]
}
