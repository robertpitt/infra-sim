import { Effect, Schema } from "effect"
import * as Setting from "../../Setting.ts"
import * as Aws from "../provider.ts"
import { addresses, capacity, MAX_PREFIX, MIN_PREFIX, usablePerSubnet } from "./cidr.ts"
import { source } from "./sources.ts"

/** Component types that are VPC resources (they live in your subnets). Everything else on AWS is a regional service outside any VPC. */
export const IN_VPC: ReadonlyArray<string> = ["aws.lambda", "aws.nat-gateway", "aws.vpc-endpoint"]

export const Config = Schema.Struct({
  cidrPrefix: Setting.int({
    default: 16,
    min: MIN_PREFIX,
    max: MAX_PREFIX,
    label: "IPv4 prefix length",
    unit: "/n",
    help: "A /16 holds 65,536 addresses, a /28 only 16.",
    limit: Setting.hard(source.cidr)
  }),
  subnets: Setting.group(
    {
      enabled: Setting.bool({
        default: false,
        help: "Describe how the VPC is split into subnets, to check that the plan fits the address block and the subnet quota. Off leaves the VPC as a plain boundary."
      }),
      availabilityZones: Setting.int({
        default: 2,
        min: 1,
        max: 6,
        unit: "zones",
        label: "Availability Zones",
        help: "A subnet lives in one zone, so a VPC spreads over zones by having subnets in each. Checked against how many zones the Region has."
      }),
      subnetsPerZone: Setting.int({
        default: 2,
        min: 1,
        max: 200,
        label: "Subnets per zone",
        help: "For example one public and one private."
      }),
      prefix: Setting.int({
        default: 24,
        min: MIN_PREFIX,
        max: MAX_PREFIX,
        label: "Subnet prefix length",
        unit: "/n",
        help: "Every subnet takes this size. Five of its addresses are always reserved.",
        limit: Setting.hard(source.subnets, "A subnet is between /16 and /28; the first four addresses and the last are reserved.")
      })
    },
    { label: "Subnet plan" }
  )
})

export type Config = typeof Config.Type

/**
 * A VPC as a boundary inside a region. It is where a function reaches private resources from, and where the network
 * pieces that connect it onward live: a NAT gateway for the internet, endpoints for AWS services. Services that are
 * not VPC resources (S3, DynamoDB, SQS, SNS, SES, API Gateway, CloudFront) are regional and don't sit inside one.
 *
 * Its settings are the address plan: the block, and optionally how it is cut into subnets. They are checked against
 * the account's VPC quotas and the Region's zones when the design is diagnosed. A VPC adds no latency of its own:
 * traffic between components in the same VPC takes the same-region latency.
 */
export const Vpc = Aws.component({
  type: "aws.vpc",
  service: "VPC",
  title: "VPC",
  description: "A virtual network inside a region. Place Lambda functions, NAT gateways and VPC endpoints in it.",
  category: "network",
  icon: "vpc",
  accent: "#8c4fff",
  docs: source.quotas,
  limits: [
    { label: "VPCs per region", value: "5", adjustable: true, source: source.quotas, note: "An account quota: edit it in the Region box." },
    { label: "Subnets per VPC", value: "200", adjustable: true, source: source.quotas, note: "An account quota: edit it in the Region box." },
    { label: "IPv4 block size", value: "/16 to /28", adjustable: false, source: source.cidr },
    { label: "Reserved addresses per subnet", value: "5", adjustable: false, source: source.subnets, note: "The first four and the last address of every subnet." }
  ],
  config: Config,
  within: ["aws.region"],
  container: {
    accepts: (child) => IN_VPC.includes(child.type)
  },
  ports: {},
  state: Schema.Struct({
    /** Addresses in the VPC's IPv4 block. */
    addresses: Schema.Number,
    /** Addresses a subnet of the planned size can hand out (all of the VPC's when there is no plan). */
    usablePerSubnet: Schema.Number,
    /** Subnets in the plan, 0 when there is none. */
    subnets: Schema.Number,
    /** Addresses usable across the planned subnets. */
    usableAddresses: Schema.Number
  }),
  make: (node) =>
    Effect.sync(() => ({
      probe: Effect.sync(() => {
        const c = node.fast.settings()
        if (!c.subnets.enabled) {
          return { addresses: addresses(c.cidrPrefix), usablePerSubnet: usablePerSubnet(c.cidrPrefix), subnets: 0, usableAddresses: 0 }
        }
        const plan = capacity(c.cidrPrefix, { availabilityZones: c.subnets.availabilityZones, subnetsPerZone: c.subnets.subnetsPerZone, prefix: c.subnets.prefix })
        return { addresses: plan.vpcAddresses, usablePerSubnet: usablePerSubnet(c.subnets.prefix), subnets: plan.subnets, usableAddresses: plan.usable }
      })
    }))
})
