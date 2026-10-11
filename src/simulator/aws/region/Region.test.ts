import { Effect, Graph } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../../Builder.ts"
import { registry } from "../../components/registry.ts"
import { frames, mean, sim } from "../../components/testing.ts"
import * as Design from "../../Design.ts"
import { diagnose } from "../../Diagnostics.ts"
import { oneWayLatencyMs, type Placement } from "../../Provider.ts"
import { provider } from "../provider.ts"
import { audit } from "./audit.ts"
import { catalog, infoOf, regions } from "./catalog.ts"

const codes = (doc: Design.Doc) => diagnose(doc, registry).map((d) => d.code)

describe("the region catalog", () => {
  it("lists the 34 regions of the commercial partition once each, with sane coordinates", () => {
    expect(catalog).toHaveLength(34)
    expect(new Set(catalog.map((r) => r.id)).size).toBe(34)
    for (const r of catalog) {
      expect(r.lat).toBeGreaterThanOrEqual(-90)
      expect(r.lat).toBeLessThanOrEqual(90)
      expect(r.lon).toBeGreaterThanOrEqual(-180)
      expect(r.lon).toBeLessThanOrEqual(180)
      expect(r.azs).toBeGreaterThanOrEqual(3)
    }
  })

  it("matches the AWS table for zones and opt-in", () => {
    expect(catalog.filter((r) => r.optIn)).toHaveLength(17)
    expect(catalog.filter((r) => !r.optIn)).toHaveLength(17)
    expect(infoOf("us-east-1")).toMatchObject({ azs: 6, optIn: false })
    expect(infoOf("us-west-2")).toMatchObject({ azs: 4, optIn: false })
    expect(infoOf("ap-northeast-1")).toMatchObject({ azs: 4 })
    expect(infoOf("ap-northeast-2")).toMatchObject({ azs: 4 })
    expect(infoOf("af-south-1")).toMatchObject({ optIn: true })
    expect(infoOf("ap-southeast-6")).toMatchObject({ name: "New Zealand", optIn: true })
    expect(infoOf("mars-north-1")).toBeUndefined()
  })

  it("keeps the ids designs on disk already use", () => {
    for (const id of ["us-east-1", "us-east-2", "us-west-1", "us-west-2", "eu-west-1", "eu-central-1", "ap-southeast-1", "sa-east-1"]) {
      expect(infoOf(id)).toBeDefined()
    }
  })

  it("is what the provider offers, apart from regions the provider's own list has yet to gain", () => {
    // `../regions.ts` is outside this folder. Until it exports `regions` from here, these two newer regions are missing
    // there. The test passes whether or not they are present; once they are, the allowance can be deleted.
    const notYetInProvider = ["ap-east-2", "ap-southeast-6"]
    const offered = new Map(provider.regions.map((r) => [r.id, r]))
    for (const r of regions) {
      const there = offered.get(r.id)
      if (there === undefined) expect(notYetInProvider).toContain(r.id)
      else expect(there).toEqual(r)
    }
    expect(regions.length - offered.size).toBe(notYetInProvider.filter((id) => !offered.has(id)).length)
    for (const id of offered.keys()) expect(infoOf(id)).toBeDefined()
  })
})

describe("what a region decides for what is inside", () => {
  const regionOf = (p: Placement) => provider.regions.find((r) => r.id === p.region)

  it("places a function by the box it sits in, and a VPC inside the box in the same region", () => {
    const b = Builder.make("placement")
    const box = b.add("aws.region", { id: "box", settings: { region: "eu-west-1" } })
    const vpc = b.add("aws.vpc", { id: "vpc", parent: box })
    b.add("aws.lambda", { id: "inside", parent: vpc })
    b.add("aws.lambda", { id: "beside", parent: box })
    const { design } = Design.resolve(b.build(), registry)
    const placement = new Map(Array.from(Graph.values(Graph.nodes(design!.graph))).map((n) => [n.id, n.placement.region]))
    expect(placement.get("inside")).toBe("eu-west-1")
    expect(placement.get("beside")).toBe("eu-west-1")
    expect(placement.get("vpc")).toBe("eu-west-1")
    expect([...design!.accounts.keys()]).toEqual(["aws:eu-west-1"])
  })

  it("rejects a node whose own region disagrees with its box", () => {
    const b = Builder.make("mismatch")
    const box = b.add("aws.region", { id: "box", settings: { region: "eu-west-1" } })
    b.add("aws.lambda", { id: "fn", parent: box, region: "us-east-1" })
    const { design, diagnostics } = Design.resolve(b.build(), registry)
    expect(design).toBeUndefined()
    expect(diagnostics.map((d) => d.code)).toEqual(["region-mismatch"])
  })

  it("rejects a region the box doesn't have", () => {
    const b = Builder.make("unknown")
    b.add("aws.region", { id: "box", settings: { region: "mars-north-1" } })
    const { diagnostics } = Design.resolve(b.build(), registry)
    expect(diagnostics.some((d) => d.node === "box")).toBe(true)
  })

  it("does not nest: a region box cannot sit in another", () => {
    const b = Builder.make("nested")
    const outer = b.add("aws.region", { id: "outer" })
    b.add("aws.region", { id: "inner", parent: outer })
    const { diagnostics } = Design.resolve(b.build(), registry)
    expect(diagnostics.map((d) => d.code)).toEqual(["not-accepted"])
  })

  it("does not take things that live in a VPC straight into the region", () => {
    const b = Builder.make("direct")
    const box = b.add("aws.region", { id: "box" })
    b.add("aws.nat-gateway", { id: "nat", parent: box })
    const { diagnostics } = Design.resolve(b.build(), registry)
    expect(diagnostics.map((d) => d.code)).toEqual(["not-accepted"])
  })

  it("advertises what it accepts, so a UI can offer it", () => {
    const box = registry.get("aws.region")!
    const accepted = registry.list.filter((c) => c !== box && box.container!.accepts(c)).map((c) => c.type)
    expect(accepted).toEqual(expect.arrayContaining(["aws.vpc", "aws.lambda", "aws.s3", "aws.dynamodb", "aws.sqs"]))
    expect(accepted).not.toContain("aws.region")
    expect(accepted).not.toContain("aws.nat-gateway")
    expect(accepted).not.toContain("common.client")
  })

  it("makes the network between regions slower the further apart they are", () => {
    const at = (region: string): Placement => ({ provider: "aws", region })
    const dublinToLondon = oneWayLatencyMs(at("eu-west-1"), at("eu-west-2"), regionOf)
    const dublinToSydney = oneWayLatencyMs(at("eu-west-1"), at("ap-southeast-2"), regionOf)
    expect(dublinToLondon).toBeLessThan(10)
    expect(dublinToSydney).toBeGreaterThan(100)
  })

  it("takes everything inside down with a regional outage, and nothing outside", async () => {
    const b = Builder.make("outage", { seed: 3 })
    const us = b.add("aws.region", { id: "us", settings: { region: "us-east-1" } })
    const eu = b.add("aws.region", { id: "eu", settings: { region: "eu-west-1" } })
    const web = b.add("common.client", { id: "web", settings: { rps: 20, arrival: "constant" } })
    const inUs = b.add("aws.lambda", { id: "us-fn", parent: us })
    const inEu = b.add("aws.lambda", { id: "eu-fn", parent: eu })
    b.connect(web, inUs, { id: "to-us" })
    b.connect(web, inEu, { id: "to-eu" })
    const all = await sim(b.build(), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(5_000)
        yield* s.faults.inject({ kind: "region", id: "aws:us-east-1" }, { _tag: "Outage" })
        return yield* s.advanceTo(15_000)
      }))
    expect(mean(all, "nodes", "us-fn", "rates", "ok", 8_000)).toBe(0)
    expect(mean(all, "nodes", "eu-fn", "rates", "ok", 8_000)).toBeGreaterThan(5)
  })
})

describe("region diagnostics", () => {
  it("says that an opt-in region has to be enabled in the account", () => {
    const b = Builder.make("optin")
    b.add("aws.region", { id: "box", settings: { region: "af-south-1" } })
    const found = diagnose(b.build(), registry).filter((d) => d.code === "region-opt-in")
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ level: "info", node: "box" })
    expect(found[0]!.message).toContain("af-south-1")
  })

  it("says nothing about a region that is enabled by default", () => {
    const b = Builder.make("default")
    b.add("aws.region", { id: "box", settings: { region: "eu-west-1" } })
    expect(codes(b.build())).not.toContain("region-opt-in")
  })

  it("notes an opt-in region used without a box too", () => {
    const b = Builder.make("bare")
    b.add("aws.lambda", { id: "fn", region: "ap-southeast-4" })
    expect(codes(b.build())).toContain("region-opt-in")
  })

  it("warns about two boxes for one region, which share one account", () => {
    const b = Builder.make("twice")
    b.add("aws.region", { id: "a", settings: { region: "eu-west-1" } })
    b.add("aws.region", { id: "b", settings: { region: "eu-west-1" } })
    const found = diagnose(b.build(), registry).filter((d) => d.code === "region-duplicate-box")
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ level: "warning", node: "b" })
  })

  it("two boxes for different regions are fine", () => {
    const b = Builder.make("two")
    b.add("aws.region", { id: "a", settings: { region: "eu-west-1" } })
    b.add("aws.region", { id: "b", settings: { region: "us-east-1" } })
    expect(codes(b.build())).not.toContain("region-duplicate-box")
  })

  it("runs on a member list with nothing in it", () => {
    expect(audit("us-east-1", [], {})).toEqual([])
  })
})

describe("region placement and latency from distance", () => {
  const chain = (region: string) => {
    const b = Builder.make("latency", { seed: 4 })
    const box = b.add("aws.region", { id: "box", settings: { region } })
    const web = b.add("common.client", { id: "web", region: "eu-west", settings: { rps: 20 } })
    const fn = b.add("aws.lambda", { id: "fn", parent: box, settings: { memory: 1769, duration: { mean: 5, cv: 0 } } })
    b.connect(web, fn)
    return b.build()
  }

  it("a box in a faraway region makes the same call take longer", async () => {
    const p50 = async (region: string) => {
      const all = await frames(chain(region), 20_000)
      const picked = all.filter((f) => f.t >= 5_000 && f.nodes.web?.dist.latency !== undefined)
      return picked.reduce((s, f) => s + f.nodes.web!.dist.latency!.p50, 0) / picked.length
    }
    expect((await p50("ap-southeast-2")) - (await p50("eu-west-2"))).toBeGreaterThan(150)
  })
})
