import type { ServiceMap } from "../map.ts"

/**
 * VPC: a NAT gateway by the hour and by the GB it processes, and each public IPv4 address on it by the hour; an
 * interface endpoint (PrivateLink) by the hour in each Availability Zone it has an interface in, and by the GB it
 * processes (tiered by the month's GB). Gateway endpoints (S3, DynamoDB) are free and have no price row.
 * https://aws.amazon.com/vpc/pricing/ and https://aws.amazon.com/privatelink/pricing/
 *
 * Usage types (after the region prefix): `NatGateway-Hours` and `NatGateway-Bytes`, in the EC2 offer (`AmazonEC2`, the
 * largest price file AWS has); `PublicIPv4:InUseAddress`, `VpcEndpoint-Hours` and `VpcEndpoint-Bytes` (three tiers from
 * 1 PB) in the VPC offer (`AmazonVPC`).
 * Left out: regional NAT gateways (`RegionalNatGateway-*`) and provisioned NAT bandwidth (`NatGateway-Prvd-*`), which
 * the simulator does not model; Gateway Load Balancer, resource and service-network endpoints; idle public addresses;
 * peering, Transit Gateway, VPN, Client VPN, Lattice, IPAM, Reachability Analyzer, traffic mirroring. Data transfer
 * between zones and Regions, and out to the internet, is the `datatransfer` service's.
 */
export const vpc: ServiceMap = {
  id: "vpc",
  title: "Amazon VPC",
  offers: ["AmazonEC2", "AmazonVPC"],
  dimensions: {
    "nat-gateway/hour": {
      unit: "hour",
      description: "NAT gateway, per gateway-hour (or partial hour)"
    },
    "nat-gateway/gb": {
      unit: "GB",
      description: "Data processed by a NAT gateway, either direction"
    },
    "public-ipv4/hour": {
      unit: "hour",
      description: "A public IPv4 address in use (each of a NAT gateway's addresses), per address-hour"
    },
    "interface-endpoint/hour": {
      unit: "hour",
      description: "Interface endpoint (PrivateLink), per Availability Zone it has an interface in, per hour"
    },
    "interface-endpoint/gb": {
      unit: "GB",
      description: "Data processed by interface endpoints, either direction, tiered by the month's GB in the Region"
    }
  },
  classify: (row) => {
    if (row.offer === "AmazonEC2") {
      // Some EC2 usage types keep a region prefix where most of the file has none (`USE1-` in us-east-1).
      const m = /^(?:[A-Z]+[0-9]-)?NatGateway-(Hours|Bytes)$/.exec(row.usage)
      return m === null ? undefined : { dimension: m[1] === "Hours" ? "nat-gateway/hour" : "nat-gateway/gb" }
    }
    switch (row.usage) {
      case "PublicIPv4:InUseAddress":
        return { dimension: "public-ipv4/hour" }
      case "VpcEndpoint-Hours":
        return { dimension: "interface-endpoint/hour" }
      case "VpcEndpoint-Bytes":
        return { dimension: "interface-endpoint/gb" }
      default:
        return undefined
    }
  }
}
