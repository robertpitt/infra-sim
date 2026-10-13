import { describe, expect, it } from "vitest"
import { addresses, capacity, MAX_PREFIX, MIN_PREFIX, RESERVED_PER_SUBNET, usablePerSubnet } from "../cidr.ts"

describe("VPC address arithmetic", () => {
  it("a /16 holds 65,536 addresses and a /28 holds 16, the ends of the allowed range", () => {
    expect(MIN_PREFIX).toBe(16)
    expect(MAX_PREFIX).toBe(28)
    expect(addresses(16)).toBe(65_536)
    expect(addresses(28)).toBe(16)
  })

  it("every subnet loses five addresses: the first four and the last", () => {
    expect(RESERVED_PER_SUBNET).toBe(5)
    expect(usablePerSubnet(24)).toBe(251)
    expect(usablePerSubnet(28)).toBe(11)
    expect(usablePerSubnet(16)).toBe(65_531)
  })

  it("a plan of equal subnets fits when their addresses fit the block, as AWS's /24 into two /25 example does", () => {
    // The AWS documentation splits 10.0.0.0/24 into two /25 subnets of 128 addresses each.
    const two = capacity(24, { availabilityZones: 1, subnetsPerZone: 2, prefix: 25 })
    expect(two).toMatchObject({ subnets: 2, vpcAddresses: 256, subnetAddresses: 256, fits: true, usable: 246 })
    expect(capacity(24, { availabilityZones: 1, subnetsPerZone: 3, prefix: 25 }).fits).toBe(false)
  })

  it("subnets as large as the VPC fit only once, and a subnet larger than the VPC never fits", () => {
    expect(capacity(20, { availabilityZones: 1, subnetsPerZone: 1, prefix: 20 }).fits).toBe(true)
    expect(capacity(20, { availabilityZones: 2, subnetsPerZone: 1, prefix: 20 }).fits).toBe(false)
    expect(capacity(24, { availabilityZones: 1, subnetsPerZone: 1, prefix: 20 }).fits).toBe(false)
  })

  it("counts subnets across zones", () => {
    const plan = capacity(16, { availabilityZones: 3, subnetsPerZone: 2, prefix: 24 })
    expect(plan.subnets).toBe(6)
    expect(plan.usable).toBe(6 * 251)
  })
})
