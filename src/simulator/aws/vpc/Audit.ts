import type { Diagnostic } from "../../Diagnostic.ts"
import type { Member } from "../../Provider.ts"
import type { Account } from "../internal/account.ts"
import { audit as region } from "../region/Audit.ts"
import { infoOf } from "../region/Catalog.ts"
import { type Audit, fmt } from "../internal/service.ts"
import { capacity } from "./internal/cidr.ts"
import type { Config as VpcConfig } from "./Vpc.ts"

type Nat = { zone: string; addresses: number }
type Endpoint = { type: "gateway" | "interface" }

const plural = (count: number, word: string): string => `${fmt(count)} ${word}${count === 1 ? "" : "s"}`

/**
 * What a design asks of the account's VPC quotas in one Region, plus the Region-level notes (opt-in, a duplicated box).
 *
 * Members do not say which VPC a function or gateway sits in, so quotas counted per VPC are checked per VPC only where a
 * VPC's own settings decide it (its subnet plan). Where AWS counts per VPC but the design could spread the resources
 * over several, the check is the strongest one that is certain: more than quota times the number of VPCs cannot be
 * spread thin enough.
 */
export const audit: Audit = (regionId, members, quotas) => {
  const account = quotas as Account
  const out: Array<Diagnostic> = [...region(regionId, members, quotas)]
  const vpcs = members.filter((m: Member) => m.type === "aws.vpc")
  const nats = members.filter((m: Member) => m.type === "aws.nat-gateway")
  const endpoints = members.filter((m: Member) => m.type === "aws.vpc-endpoint")
  const zones = infoOf(regionId)?.azs

  if (vpcs.length > account.vpcPerRegion) {
    out.push({
      level: "warning",
      code: "vpc-quota",
      message: `${plural(vpcs.length, "VPC")} in ${regionId}, but the account can have ${fmt(account.vpcPerRegion)} per Region. Ask AWS to raise the quota or share a VPC.`
    })
  }

  for (const vpc of vpcs) {
    const c = vpc.config as VpcConfig
    if (!c.subnets.enabled) continue
    const plan = capacity(c.cidrPrefix, { availabilityZones: c.subnets.availabilityZones, subnetsPerZone: c.subnets.subnetsPerZone, prefix: c.subnets.prefix })
    if (!plan.fits) {
      out.push({
        level: "warning",
        code: "vpc-subnets-do-not-fit",
        node: vpc.id,
        message: `${vpc.name}: ${plural(plan.subnets, "subnet")} of /${c.subnets.prefix} need ${fmt(plan.subnetAddresses)} addresses, but the /${c.cidrPrefix} block has ${fmt(plan.vpcAddresses)}.`
      })
    }
    if (plan.subnets > account.vpcSubnetsPerVpc) {
      out.push({
        level: "warning",
        code: "vpc-subnet-quota",
        node: vpc.id,
        message: `${vpc.name}: ${fmt(plan.subnets)} subnets, but a VPC can hold ${fmt(account.vpcSubnetsPerVpc)}.`
      })
    }
    if (zones !== undefined && c.subnets.availabilityZones > zones) {
      out.push({
        level: "warning",
        code: "vpc-zones",
        node: vpc.id,
        message: `${vpc.name} spreads over ${c.subnets.availabilityZones} Availability Zones, but ${regionId} has ${zones}.`
      })
    }
  }

  // NAT gateways: counted per zone across the account, each holding Elastic IPs.
  const perZone = new Map<string, number>()
  let elasticIps = 0
  for (const gateway of nats) {
    const c = gateway.config as Nat
    perZone.set(c.zone, (perZone.get(c.zone) ?? 0) + 1)
    elasticIps += c.addresses
    if (c.addresses > account.vpcNatAddressesPerGateway) {
      out.push({
        level: "warning",
        code: "vpc-nat-addresses",
        node: gateway.id,
        message: `${gateway.name} has ${c.addresses} IPv4 addresses, but the account can attach ${account.vpcNatAddressesPerGateway} to a NAT gateway by default.`
      })
    }
    if (zones !== undefined && "abcdef".indexOf(c.zone) >= zones) {
      out.push({
        level: "warning",
        code: "vpc-nat-zone",
        node: gateway.id,
        message: `${gateway.name} is in zone ${c.zone}, but ${regionId} has ${zones} Availability Zones.`
      })
    }
  }
  for (const [zone, count] of perZone) {
    if (count > account.vpcNatGatewaysPerAz) {
      out.push({
        level: "warning",
        code: "vpc-nat-quota",
        message: `${plural(count, "NAT gateway")} in ${regionId}${zone}, but a zone allows ${fmt(account.vpcNatGatewaysPerAz)}.`
      })
    }
  }
  if (elasticIps > account.vpcElasticIpsPerRegion) {
    out.push({
      level: "warning",
      code: "vpc-elastic-ips",
      message: `NAT gateways in ${regionId} hold ${plural(elasticIps, "Elastic IP address")}, but the account has ${fmt(account.vpcElasticIpsPerRegion)} per Region.`
    })
  }

  const gatewayEndpoints = endpoints.filter((m: Member) => (m.config as Endpoint).type === "gateway").length
  const interfaceEndpoints = endpoints.length - gatewayEndpoints
  if (gatewayEndpoints > account.vpcGatewayEndpointsPerRegion) {
    out.push({
      level: "warning",
      code: "vpc-gateway-endpoint-quota",
      message: `${plural(gatewayEndpoints, "gateway endpoint")} in ${regionId}, but the account can have ${fmt(account.vpcGatewayEndpointsPerRegion)} per Region.`
    })
  }
  if (interfaceEndpoints > account.vpcInterfaceEndpointsPerVpc * Math.max(1, vpcs.length)) {
    out.push({
      level: "warning",
      code: "vpc-interface-endpoint-quota",
      message: `${plural(interfaceEndpoints, "interface endpoint")} over ${plural(Math.max(1, vpcs.length), "VPC")} in ${regionId}: at most ${fmt(account.vpcInterfaceEndpointsPerVpc)} fit in each.`
    })
  }
  return out
}
