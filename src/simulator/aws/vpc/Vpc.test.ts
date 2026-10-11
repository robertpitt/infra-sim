import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../../Builder.ts"
import { registry } from "../../components/registry.ts"
import { sim } from "../../components/testing.ts"
import * as Design from "../../Design.ts"
import { diagnose } from "../../Diagnostics.ts"
import { account } from "../account.ts"
import { quotas } from "./quotas.ts"

const resolve = (doc: Design.Doc) => Design.resolve(doc, registry)
const findings = (doc: Design.Doc, code: string) => diagnose(doc, registry).filter((d) => d.code === code)

/** A region box with `n` VPCs in it, each with the given settings. */
const vpcs = (n: number, settings: Record<string, unknown> = {}, region = "us-east-1") => {
  const b = Builder.make("vpcs")
  const box = b.add("aws.region", { id: "box", settings: { region } })
  for (let i = 0; i < n; i++) b.add("aws.vpc", { id: `vpc-${i}`, parent: box, settings })
  return { b, box }
}

describe("aws.vpc: where it sits and what sits in it", () => {
  it("sits inside a region and lets a Lambda function attach to it, in the region's placement", () => {
    const b = Builder.make("ok")
    const box = b.add("aws.region", { id: "box", settings: { region: "eu-central-1" } })
    const vpc = b.add("aws.vpc", { id: "vpc", parent: box })
    b.add("aws.lambda", { id: "fn", parent: vpc })
    const { design, diagnostics } = resolve(b.build())
    expect(diagnostics).toEqual([])
    expect([...design!.accounts.keys()]).toEqual(["aws:eu-central-1"])
  })

  it("has to be placed in a region", () => {
    const b = Builder.make("loose")
    b.add("aws.vpc", { id: "vpc" })
    expect(resolve(b.build()).diagnostics.map((d) => d.code)).toEqual(["outside-container"])
  })

  it("takes the VPC resources: functions, NAT gateways and endpoints", () => {
    const b = Builder.make("contents")
    const box = b.add("aws.region", { id: "box" })
    const vpc = b.add("aws.vpc", { id: "vpc", parent: box })
    b.add("aws.lambda", { id: "fn", parent: vpc })
    b.add("aws.nat-gateway", { id: "nat", parent: vpc })
    b.add("aws.vpc-endpoint", { id: "s3", parent: vpc })
    expect(resolve(b.build()).diagnostics).toEqual([])
  })

  it("refuses the regional services, which are not VPC resources", () => {
    const vpc = registry.get("aws.vpc")!
    for (const type of ["aws.s3", "aws.dynamodb", "aws.sqs", "aws.sns", "aws.ses", "aws.apigateway", "aws.cloudfront"]) {
      expect(vpc.container!.accepts(registry.get(type)!), type).toBe(false)
    }
    // And a design that tries is told so.
    const b = Builder.make("s3")
    const box = b.add("aws.region", { id: "box" })
    const inside = b.add("aws.vpc", { id: "vpc", parent: box })
    b.add("aws.s3", { id: "bucket", parent: inside })
    expect(resolve(b.build()).diagnostics.map((d) => d.code)).toEqual(["not-accepted"])
  })

  it("does not nest a VPC in a VPC, and gateways need a VPC", () => {
    const b = Builder.make("nest")
    const box = b.add("aws.region", { id: "box" })
    const vpc = b.add("aws.vpc", { id: "vpc", parent: box })
    b.add("aws.vpc", { id: "inner", parent: vpc })
    b.add("aws.nat-gateway", { id: "bare" })
    expect(resolve(b.build()).diagnostics.map((d) => d.code).sort()).toEqual(["not-accepted", "outside-container"])
  })

  it("advertises what it accepts", () => {
    const vpc = registry.get("aws.vpc")!
    const accepted = registry.list.filter((c) => c !== vpc && vpc.container!.accepts(c)).map((c) => c.type)
    expect(accepted.sort()).toEqual(["aws.lambda", "aws.nat-gateway", "aws.vpc-endpoint"])
  })
})

describe("aws.vpc: the address block", () => {
  it("defaults to a /16 and accepts /16 to /28 only", () => {
    expect(resolve(vpcs(1).b.build()).design).toBeDefined()
    for (const cidrPrefix of [16, 20, 28]) expect(resolve(vpcs(1, { cidrPrefix }).b.build()).design, `/${cidrPrefix}`).toBeDefined()
    for (const cidrPrefix of [15, 29]) {
      const { design, diagnostics } = resolve(vpcs(1, { cidrPrefix }).b.build())
      expect(design, `/${cidrPrefix}`).toBeUndefined()
      expect(diagnostics.map((d) => d.code)).toEqual(["bad-settings"])
    }
  })

  it("reports its addresses when probed", async () => {
    const state = await sim(vpcs(1, { cidrPrefix: 24 }).b.build(), (s) => Effect.map(s.probe("vpc-0"), (p) => p.state))
    expect(state).toEqual({ addresses: 256, usablePerSubnet: 251, subnets: 0, usableAddresses: 0 })
  })

  it("reports the subnet plan when there is one", async () => {
    const doc = vpcs(1, { cidrPrefix: 16, subnets: { enabled: true, availabilityZones: 3, subnetsPerZone: 2, prefix: 24 } }).b.build()
    const state = await sim(doc, (s) => Effect.map(s.probe("vpc-0"), (p) => p.state))
    expect(state).toEqual({ addresses: 65_536, usablePerSubnet: 251, subnets: 6, usableAddresses: 6 * 251 })
  })

  it("keeps the settings it always had, so an existing design decodes unchanged", () => {
    const { design } = resolve(vpcs(1, { cidrPrefix: 20 }).b.build())
    const settings = Design.encode(design!, registry).nodes["vpc-0"]!.settings as { cidrPrefix: number; subnets: { enabled: boolean } }
    expect(settings.cidrPrefix).toBe(20)
    expect(settings.subnets.enabled).toBe(false)
  })
})

describe("aws.vpc: account quotas", () => {
  const defaults = Design.resolve(vpcs(1).b.build(), registry).design!.accounts.get("aws:us-east-1")!.config as Record<string, number>

  it("defaults to AWS's published numbers", () => {
    expect(defaults).toMatchObject({
      vpcPerRegion: 5,
      vpcSubnetsPerVpc: 200,
      vpcNatGatewaysPerAz: 5,
      vpcNatAddressesPerGateway: 2,
      vpcElasticIpsPerRegion: 5,
      vpcGatewayEndpointsPerRegion: 20,
      vpcInterfaceEndpointsPerVpc: 50
    })
  })

  it("has field names that no other service uses, all prefixed `vpc`", () => {
    const mine = Object.keys(quotas("us-east-1"))
    expect(mine.every((k) => k.startsWith("vpc"))).toBe(true)
    const all = Object.keys(account("us-east-1").fields)
    expect(all.filter((k) => mine.includes(k))).toHaveLength(mine.length)
    expect(new Set(all).size).toBe(all.length)
  })

  it("is the same in every region, as AWS publishes one default", () => {
    expect(Object.keys(quotas("eu-west-1"))).toEqual(Object.keys(quotas("us-east-1")))
  })

  it("can be overridden for a design", () => {
    const { b } = vpcs(1)
    b.account("aws:us-east-1", { vpcPerRegion: 50 })
    const config = resolve(b.build()).design!.accounts.get("aws:us-east-1")!.config as Record<string, number>
    expect(config.vpcPerRegion).toBe(50)
  })

  it("rejects a NAT gateway address quota above the 8 a gateway can hold", () => {
    const { b } = vpcs(1)
    b.account("aws:us-east-1", { vpcNatAddressesPerGateway: 9 })
    const codes = resolve(b.build()).diagnostics.map((d) => d.code)
    expect(codes.length).toBeGreaterThan(0)
    expect(new Set(codes)).toEqual(new Set(["bad-account"]))
  })
})

describe("aws.vpc: audits", () => {
  it("is quiet for a design inside the quotas", () => {
    const { b } = vpcs(5)
    expect(diagnose(b.build(), registry).filter((d) => d.code.startsWith("vpc-"))).toEqual([])
  })

  it("warns when a region has more VPC boxes than the account's quota, and not before", () => {
    expect(findings(vpcs(5).b.build(), "vpc-quota")).toHaveLength(0)
    const six = findings(vpcs(6).b.build(), "vpc-quota")
    expect(six).toHaveLength(1)
    expect(six[0]!.level).toBe("warning")
    expect(six[0]!.message).toContain("6 VPCs")
    expect(six[0]!.message).toContain("5 per Region")
  })

  it("follows the quota when it is raised, and counts per region", () => {
    const raised = vpcs(6).b
    raised.account("aws:us-east-1", { vpcPerRegion: 6 })
    expect(findings(raised.build(), "vpc-quota")).toHaveLength(0)

    // Three VPCs in each of two regions: each is within its own quota.
    const b = Builder.make("two")
    for (const region of ["us-east-1", "eu-west-1"]) {
      const box = b.add("aws.region", { id: `box-${region}`, settings: { region } })
      for (let i = 0; i < 3; i++) b.add("aws.vpc", { id: `vpc-${region}-${i}`, parent: box })
    }
    expect(findings(b.build(), "vpc-quota")).toHaveLength(0)
  })

  it("warns that a subnet plan does not fit the address block", () => {
    const fits = vpcs(1, { cidrPrefix: 24, subnets: { enabled: true, availabilityZones: 2, subnetsPerZone: 1, prefix: 25 } }).b.build()
    expect(findings(fits, "vpc-subnets-do-not-fit")).toHaveLength(0)
    const tooBig = vpcs(1, { cidrPrefix: 24, subnets: { enabled: true, availabilityZones: 2, subnetsPerZone: 2, prefix: 25 } }).b.build()
    const found = findings(tooBig, "vpc-subnets-do-not-fit")
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ node: "vpc-0" })
    expect(found[0]!.message).toContain("512")
    expect(found[0]!.message).toContain("256")
  })

  it("does not check a subnet plan that is switched off", () => {
    const off = vpcs(1, { cidrPrefix: 28, subnets: { enabled: false, availabilityZones: 6, subnetsPerZone: 200, prefix: 16 } }).b.build()
    expect(diagnose(off, registry).filter((d) => d.code.startsWith("vpc-"))).toEqual([])
  })

  it("warns when a plan has more subnets than a VPC can hold", () => {
    const plan = { enabled: true, availabilityZones: 3, subnetsPerZone: 70, prefix: 28 }
    expect(findings(vpcs(1, { subnets: plan }).b.build(), "vpc-subnet-quota")).toHaveLength(1) // 210 subnets
    expect(findings(vpcs(1, { subnets: { ...plan, subnetsPerZone: 66 } }).b.build(), "vpc-subnet-quota")).toHaveLength(0) // 198
    const raised = vpcs(1, { subnets: plan }).b
    raised.account("aws:us-east-1", { vpcSubnetsPerVpc: 250 })
    expect(findings(raised.build(), "vpc-subnet-quota")).toHaveLength(0)
  })

  it("warns when a VPC spreads over more zones than the region has", () => {
    const plan = { enabled: true, availabilityZones: 4, subnetsPerZone: 1, prefix: 24 }
    expect(findings(vpcs(1, { subnets: plan }, "us-east-2").b.build(), "vpc-zones")).toHaveLength(1) // Ohio has 3
    expect(findings(vpcs(1, { subnets: plan }, "us-west-2").b.build(), "vpc-zones")).toHaveLength(0) // Oregon has 4
  })
})

describe("aws.vpc: audits of what sits in it", () => {
  const withNats = (zones: ReadonlyArray<string>, addresses = 1, region = "us-east-1") => {
    const b = Builder.make("nats")
    const box = b.add("aws.region", { id: "box", settings: { region } })
    const vpc = b.add("aws.vpc", { id: "vpc", parent: box })
    zones.forEach((zone, i) => b.add("aws.nat-gateway", { id: `nat-${i}`, parent: vpc, settings: { zone, addresses } }))
    return b
  }

  it("warns about more NAT gateways in one zone than the quota allows", () => {
    expect(findings(withNats(["a", "a", "a", "a", "a"]).build(), "vpc-nat-quota")).toHaveLength(0)
    const six = findings(withNats(["a", "a", "a", "a", "a", "a"]).build(), "vpc-nat-quota")
    expect(six).toHaveLength(1)
    expect(six[0]!.message).toContain("us-east-1a")
    // Spread over zones, the same six are fine.
    expect(findings(withNats(["a", "b", "c", "a", "b", "c"]).build(), "vpc-nat-quota")).toHaveLength(0)
  })

  it("warns about a NAT gateway in a zone the region doesn't have", () => {
    expect(findings(withNats(["d"], 1, "us-east-2").build(), "vpc-nat-zone")).toHaveLength(1)
    expect(findings(withNats(["d"], 1, "us-east-1").build(), "vpc-nat-zone")).toHaveLength(0)
  })

  it("warns about a gateway with more addresses than the account can attach, and the Elastic IPs they hold", () => {
    expect(findings(withNats(["a"], 2).build(), "vpc-nat-addresses")).toHaveLength(0)
    expect(findings(withNats(["a"], 3).build(), "vpc-nat-addresses")).toHaveLength(1)
    // Three gateways of two addresses: six Elastic IPs against five.
    expect(findings(withNats(["a", "b", "c"], 2).build(), "vpc-elastic-ips")).toHaveLength(1)
    expect(findings(withNats(["a", "b"], 2).build(), "vpc-elastic-ips")).toHaveLength(0)
  })

  const withEndpoints = (gateway: number, iface: number, vpcCount = 1) => {
    const b = Builder.make("endpoints")
    const box = b.add("aws.region", { id: "box" })
    const first = b.add("aws.vpc", { id: "vpc-0", parent: box })
    for (let i = 1; i < vpcCount; i++) b.add("aws.vpc", { id: `vpc-${i}`, parent: box })
    for (let i = 0; i < gateway; i++) b.add("aws.vpc-endpoint", { id: `gw-${i}`, parent: first, settings: { type: "gateway" } })
    for (let i = 0; i < iface; i++) b.add("aws.vpc-endpoint", { id: `if-${i}`, parent: first, settings: { type: "interface" } })
    return b.build()
  }

  it("warns about more gateway endpoints than the account can have in a region", () => {
    expect(findings(withEndpoints(20, 0), "vpc-gateway-endpoint-quota")).toHaveLength(0)
    expect(findings(withEndpoints(21, 0), "vpc-gateway-endpoint-quota")).toHaveLength(1)
  })

  it("warns about interface endpoints only when no spread over the VPCs could fit them", () => {
    expect(findings(withEndpoints(0, 50), "vpc-interface-endpoint-quota")).toHaveLength(0)
    expect(findings(withEndpoints(0, 51), "vpc-interface-endpoint-quota")).toHaveLength(1)
    // 51 over two VPCs could be 26 and 25: no warning.
    expect(findings(withEndpoints(0, 51, 2), "vpc-interface-endpoint-quota")).toHaveLength(0)
  })
})
