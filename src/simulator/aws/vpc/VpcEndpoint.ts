import { Effect, Schema } from "effect"
import * as Component from "../../Component.ts"
import * as Setting from "../../Setting.ts"
import * as Aws from "../internal/provider.ts"
import { vpcEndpointDashboard } from "./internal/dashboard.ts"
import { hop } from "./internal/hop.ts"
import { source } from "./internal/sources.ts"
import { BYTES_PER_GBPS } from "../internal/units.ts"

const MIN_GBPS_PER_ZONE = 10
const MAX_GBPS_PER_ZONE = 100

const Config = Schema.Struct({
  type: Setting.choice(["gateway", "interface"], {
    default: "gateway",
    label: "Endpoint type",
    labels: { gateway: "Gateway (S3, DynamoDB)", interface: "Interface (PrivateLink)" },
    help: "A gateway endpoint is a route to S3 or DynamoDB: free, no appliance in the path, same Region only. An interface endpoint is a network interface in your subnets that reaches most other AWS services over PrivateLink."
  }),
  availabilityZones: Setting.int({
    default: 2,
    min: 1,
    max: 6,
    unit: "zones",
    label: "Availability Zones",
    help: "Interface endpoints only: how many zones the endpoint has a network interface in. Bandwidth is per zone."
  }),
  bandwidth: Setting.number({
    default: MIN_GBPS_PER_ZONE,
    min: MIN_GBPS_PER_ZONE,
    max: MAX_GBPS_PER_ZONE,
    step: 10,
    unit: "Gbps per zone",
    label: "Bandwidth",
    help: "Interface endpoints only. Each endpoint supports 10 Gbps per zone and scales automatically up to 100. AWS publishes no schedule for the scaling, so the simulator holds it at this value. Gateway endpoints have no published bandwidth limit.",
    limit: Setting.hard(source.endpointQuotas, "10 Gbps per Availability Zone by default, scaling to 100 Gbps.")
  }),
  latency: Setting.latency({
    mean: "500 micros",
    cv: 0.3,
    label: "Interface hop latency",
    help: "Time an interface endpoint adds to a call: one more network hop through its interface. AWS publishes no figure: an assumption. A gateway endpoint adds none."
  })
})

type Config = typeof Config.Type

/**
 * How a function in a VPC reaches an AWS service without leaving the AWS network or needing a NAT gateway. A gateway
 * endpoint (S3, DynamoDB) is only a route: it adds nothing and has no published limit. An interface endpoint is a
 * network interface per zone: it adds a hop and carries 10 Gbps per zone (growing to 100).
 *
 * Wire a function's output to the endpoint and the endpoint's output to the service. Whether a function may reach
 * the service some other way is not enforced: see the README's backlog.
 */
export const VpcEndpoint = Aws.component({
  type: "aws.vpc-endpoint",
  service: "VPC",
  title: "VPC endpoint",
  description: "A private path from a VPC to an AWS service: a free gateway endpoint (S3, DynamoDB) or a PrivateLink interface endpoint.",
  category: "network",
  icon: "link",
  accent: "#8c4fff",
  docs: source.endpointQuotas,
  dashboard: vpcEndpointDashboard,
  limits: [
    { label: "Interface endpoint bandwidth", value: "10 Gbps per zone, scaling to 100 Gbps", adjustable: false, source: source.endpointQuotas },
    { label: "Gateway endpoints", value: "S3 and DynamoDB, same Region only", adjustable: false, source: source.gatewayEndpointsS3, note: "Not reachable from on premises, peered VPCs in other Regions or a transit gateway." },
    { label: "Maximum transmission unit", value: "8,500 bytes", adjustable: false, source: source.endpointQuotas, note: "Larger packets are dropped. Not simulated." }
  ],
  highlights: [{ rate: "bytes", label: "bytes/s" }],
  config: Config,
  within: ["aws.vpc"],
  ports: { out: Component.port.many("Service") },
  state: Schema.Struct({
    /** Bytes carried. */
    bytes: Schema.Number,
    /** Calls dropped for want of bandwidth (interface endpoints). */
    drops: Schema.Number
  }),
  make: (node) =>
    Effect.sync(() => {
      const path = hop<Config>(node, {
        bytesPerSecond: (c) => (c.type === "interface" ? c.bandwidth * c.availabilityZones * BYTES_PER_GBPS : undefined),
        latency: (c) => (c.type === "interface" ? c.latency : undefined),
        mode: () => "weighted",
        saturated: "VPC endpoint out of bandwidth: packets dropped"
      })
      return { call: path.call, probe: Effect.sync(() => ({ bytes: path.totals.bytes, drops: path.totals.drops })) }
    })
})
