import { Effect, Schema } from "effect"
import * as Setting from "../Setting.ts"
import * as Aws from "./provider.ts"

const D = "https://docs.aws.amazon.com/vpc/latest/userguide/"

/**
 * A VPC as a boundary inside a region. Today it groups the functions attached to it and bounds the addresses they
 * can use; traffic between components in the same VPC takes the same-region latency.
 */
export const Vpc = Aws.component({
  type: "aws.vpc",
  service: "VPC",
  title: "VPC",
  description: "A virtual network inside a region. Place Lambda functions in it to attach them.",
  category: "network",
  icon: "vpc",
  accent: "#8c4fff",
  docs: `${D}what-is-amazon-vpc.html`,
  limits: [
    { label: "VPCs per region", value: "5", adjustable: true, source: `${D}amazon-vpc-limits.html` },
    { label: "IPv4 block size", value: "/16 to /28", adjustable: false, source: `${D}vpc-cidr-blocks.html` },
    { label: "Reserved addresses per subnet", value: "5", adjustable: false, source: `${D}subnet-sizing.html`, note: "The first four and the last address of every subnet." }
  ],
  config: Schema.Struct({
    cidrPrefix: Setting.int({
      default: 16,
      min: 16,
      max: 28,
      label: "IPv4 prefix length",
      unit: "/n",
      help: "A /16 holds 65,536 addresses, a /28 only 16.",
      limit: Setting.hard(`${D}vpc-cidr-blocks.html`)
    })
  }),
  within: ["aws.region"],
  container: {
    accepts: (child) => child.type === "aws.lambda"
  },
  ports: {},
  make: () => Effect.succeed({})
})
