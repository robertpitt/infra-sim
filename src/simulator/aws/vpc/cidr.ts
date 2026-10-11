/**
 * IPv4 address arithmetic for a VPC and its subnets. Pure, so the VPC component, its audits and its tests agree on one
 * set of numbers.
 */

/** A VPC's IPv4 block is between /16 and /28. Source: https://docs.aws.amazon.com/vpc/latest/userguide/vpc-cidr-blocks.html */
export const MIN_PREFIX = 16
export const MAX_PREFIX = 28

/**
 * The first four addresses and the last one of every subnet are not usable: network address, VPC router, DNS, "future
 * use", broadcast. Source: https://docs.aws.amazon.com/vpc/latest/userguide/subnet-sizing.html
 */
export const RESERVED_PER_SUBNET = 5

/** Every address in a block of this prefix length: a /16 has 65,536, a /28 has 16. */
export const addresses = (prefix: number): number => 2 ** (32 - prefix)

/** Addresses a subnet of this prefix length can hand to resources: all of them minus the five AWS keeps. */
export const usablePerSubnet = (prefix: number): number => Math.max(0, addresses(prefix) - RESERVED_PER_SUBNET)

/** How a VPC is carved up: this many subnets in each Availability Zone, each of one size. */
export interface SubnetPlan {
  readonly availabilityZones: number
  readonly subnetsPerZone: number
  readonly prefix: number
}

export interface Capacity {
  readonly subnets: number
  /** Addresses the VPC's own block holds. */
  readonly vpcAddresses: number
  /** Addresses the planned subnets take from it. */
  readonly subnetAddresses: number
  /** Addresses resources can actually use across all subnets, after the reserved ones. */
  readonly usable: number
  /** Whether equal-sized subnets of that size fit in the VPC block at all. */
  readonly fits: boolean
}

/**
 * What a subnet plan comes to inside a VPC block. Equal power-of-two subnets pack a power-of-two block exactly, so the
 * plan fits when the addresses it takes do not exceed the VPC's: no alignment bookkeeping is needed.
 */
export const capacity = (vpcPrefix: number, plan: SubnetPlan): Capacity => {
  const subnets = plan.availabilityZones * plan.subnetsPerZone
  const subnetAddresses = subnets * addresses(plan.prefix)
  return {
    subnets,
    vpcAddresses: addresses(vpcPrefix),
    subnetAddresses,
    usable: subnets * usablePerSubnet(plan.prefix),
    fits: subnetAddresses <= addresses(vpcPrefix)
  }
}
