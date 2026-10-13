import * as Setting from "../../Setting.ts"
import { source } from "./internal/sources.ts"

/**
 * The account-level VPC quotas: limits that belong to an AWS account in a Region and are shared by every VPC in it.
 * Each is an editable setting whose default is AWS's published number; they are merged into the account form in
 * `../account.ts` and shown in the Account quotas panel of a Region box. AWS publishes one default for all Regions,
 * so `region` changes nothing. Every field is prefixed `vpc` to stay unique across services.
 */
export const quotas = (_region: string) => ({
  vpcPerRegion: Setting.int({
    default: 5,
    min: 1,
    max: 1_000,
    unit: "VPCs",
    label: "VPCs per Region",
    help: "How many VPC boxes the account can have in this Region. AWS says it can be raised to hundreds; the upper bound here is only for the slider.",
    limit: Setting.quota(source.quotas, "Raising it also raises the internet gateways per Region by the same amount.")
  }),
  vpcSubnetsPerVpc: Setting.int({
    default: 200,
    min: 1,
    max: 1_000,
    unit: "subnets",
    label: "Subnets per VPC",
    help: "The most subnets one VPC can hold. Checked against a VPC's subnet plan.",
    limit: Setting.quota(source.quotas)
  }),
  vpcNatGatewaysPerAz: Setting.int({
    default: 5,
    min: 1,
    max: 100,
    unit: "NAT gateways",
    label: "NAT gateways per Availability Zone",
    help: "Counted per zone across every VPC in the account. Only pending, active and deleting gateways count.",
    limit: Setting.quota(source.quotas)
  }),
  vpcNatAddressesPerGateway: Setting.int({
    default: 2,
    min: 1,
    max: 8,
    unit: "addresses",
    label: "Elastic IP addresses per public NAT gateway",
    help: "Each address adds 55,000 simultaneous connections to a destination. AWS allows up to 8 on request.",
    limit: Setting.quota(source.quotas, "Raisable up to 8 (1 primary and 7 secondary).")
  }),
  vpcElasticIpsPerRegion: Setting.int({
    default: 5,
    min: 1,
    max: 1_000,
    unit: "addresses",
    label: "Elastic IP addresses per Region",
    help: "A public NAT gateway holds at least one. The account's other Elastic IPs (EC2 instances) are not simulated.",
    limit: Setting.quota(source.quotas, "An EC2 quota, listed on the VPC quotas page.")
  }),
  vpcGatewayEndpointsPerRegion: Setting.int({
    default: 20,
    min: 1,
    max: 1_000,
    unit: "endpoints",
    label: "Gateway endpoints per Region",
    help: "S3 and DynamoDB gateway endpoints across every VPC in the Region. One VPC can hold at most 255.",
    limit: Setting.quota(source.endpointQuotas, "Up to 255 gateway endpoints per VPC.")
  }),
  vpcInterfaceEndpointsPerVpc: Setting.int({
    default: 50,
    min: 1,
    max: 1_000,
    unit: "endpoints",
    label: "Interface endpoints per VPC",
    help: "A combined quota for interface endpoints and Gateway Load Balancer endpoints.",
    limit: Setting.quota(source.endpointQuotas)
  })
})
