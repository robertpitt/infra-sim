import { type Dashboard, gauge, latencyPanel, rate, ratio } from "../../../Dashboard.ts"

/**
 * A NAT gateway's dashboard, as the VPC console and CloudWatch show one (`AWS/NATGateway`,
 * https://docs.aws.amazon.com/vpc/latest/userguide/metrics-dimensions-nat-gateway.html): connections active, attempted and
 * established, port allocation errors, bytes and drops; and, as a key figure, the share of ports used to the busiest
 * destination (connections to it over the 55,000 per address each destination allows: at 100% new connections to it fail
 * with ErrorPortAllocation). Neither that nor bandwidth gets a chart of its own: both are far from their limits in any
 * design here (lower the connections setting to see ports run out), and when they run out the errors and drops say so.
 */
export const natGatewayDashboard: Dashboard = {
  figures: [
    { label: "Active connections", metric: gauge("connections"), unit: "count", cloudwatch: "ActiveConnectionCount" },
    { label: "Connection attempts", metric: rate("connectionAttempts"), unit: "perSecond", cloudwatch: "ConnectionAttemptCount" },
    { label: "Port allocation errors", metric: rate("ErrorPortAllocation"), unit: "perSecond", tone: "bad", cloudwatch: "ErrorPortAllocation" },
    { label: "Dropped", metric: rate("drops"), unit: "perSecond", tone: "warn", cloudwatch: "PacketsDropCount" },
    { label: "Bytes out", metric: rate("bytes"), unit: "bytesPerSecond", cloudwatch: "BytesOutToDestination" },
    { label: "Ports used", metric: ratio(gauge("busiestDestination"), gauge("portLimit")), unit: "ratio" }
  ],
  panels: [
    {
      id: "connections",
      title: "Active connections",
      unit: "count",
      cloudwatch: ["ActiveConnectionCount"],
      help: "Connections open through the gateway: here, the calls in flight to the destinations behind it (idle connections are not modelled).",
      lines: [{ label: "active", metric: gauge("connections"), tone: "accent" }]
    },
    {
      id: "attempts",
      title: "Connections",
      unit: "perSecond",
      cloudwatch: ["ConnectionAttemptCount", "ConnectionEstablishedCount", "ErrorPortAllocation"],
      help: "New connections asked for, those the gateway gave a source port, and those it couldn't: every port of its addresses to that destination was taken.",
      lines: [
        { label: "attempts", metric: rate("connectionAttempts"), tone: "primary" },
        { label: "established", metric: rate("connectionsEstablished"), tone: "ok" },
        { label: "port allocation errors", metric: rate("ErrorPortAllocation"), tone: "bad" }
      ]
    },
    {
      id: "bytes",
      title: "Bytes",
      unit: "bytesPerSecond",
      cloudwatch: ["BytesOutToDestination", "BytesInFromSource"],
      help: "Bytes the gateway carried from the VPC to the destinations. Responses carry no size here, so BytesInFromDestination and BytesOutToSource are not shown.",
      lines: [{ label: "out to destination", metric: rate("bytes"), tone: "primary" }]
    },
    {
      id: "drops",
      title: "Dropped",
      unit: "perSecond",
      cloudwatch: ["PacketsDropCount"],
      help: "Calls the gateway dropped for want of bandwidth (5 Gbps, scaling to 100; the simulator holds it at the setting). The simulator has calls, not packets, so this counts calls.",
      lines: [{ label: "dropped", metric: rate("drops"), tone: "bad" }]
    },
    {
      ...latencyPanel("latency", "Latency"),
      help: "The gateway's own processing plus the destination's time. CloudWatch publishes no latency for a NAT gateway."
    }
  ]
}

/**
 * A VPC endpoint's dashboard, as the VPC console and CloudWatch show an interface endpoint's (`AWS/PrivateLinkEndpoints`,
 * https://docs.aws.amazon.com/vpc/latest/privatelink/privatelink-cloudwatch-metrics.html). AWS publishes nothing for a
 * gateway endpoint; the simulator still shows its traffic.
 */
export const vpcEndpointDashboard: Dashboard = {
  figures: [
    { label: "Bytes processed", metric: rate("bytes"), unit: "bytesPerSecond", cloudwatch: "BytesProcessed" },
    { label: "New connections", metric: rate("in"), unit: "perSecond", cloudwatch: "NewConnections" },
    { label: "Active connections", metric: gauge("inflight"), unit: "count", cloudwatch: "ActiveConnections" },
    { label: "Dropped", metric: rate("drops"), unit: "perSecond", tone: "bad", cloudwatch: "PacketsDropped" }
  ],
  panels: [
    {
      id: "bytes",
      title: "Bytes processed",
      unit: "bytesPerSecond",
      cloudwatch: ["BytesProcessed"],
      help: "Bytes carried to the service. Responses carry no size here, so this counts one direction. AWS publishes it for interface endpoints only.",
      lines: [{ label: "processed", metric: rate("bytes"), tone: "primary" }]
    },
    {
      id: "connections",
      title: "New connections",
      unit: "perSecond",
      cloudwatch: ["NewConnections"],
      help: "Calls through the endpoint, one connection each, and how they ended at the service.",
      lines: [
        { label: "new", metric: rate("in"), tone: "primary" },
        { label: "ok", metric: rate("ok"), tone: "ok" },
        { label: "failed", metric: rate("fail"), tone: "bad" }
      ]
    },
    {
      id: "active",
      title: "Active connections",
      unit: "count",
      cloudwatch: ["ActiveConnections"],
      help: "Calls in flight through the endpoint.",
      lines: [{ label: "active", metric: gauge("inflight"), tone: "accent" }]
    },
    {
      id: "drops",
      title: "Dropped",
      unit: "perSecond",
      cloudwatch: ["PacketsDropped"],
      help: "Calls an interface endpoint dropped for want of bandwidth (10 Gbps per zone, scaling to 100; the simulator holds it at the setting). A gateway endpoint has no published limit and never drops. The simulator has calls, not packets, so this counts calls.",
      lines: [{ label: "dropped", metric: rate("drops"), tone: "bad" }]
    },
    {
      ...latencyPanel("latency", "Latency"),
      help: "An interface endpoint's hop (a gateway endpoint adds none) plus the service's time. Not a CloudWatch metric."
    }
  ]
}
