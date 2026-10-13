import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../Builder.ts"
import * as Design from "../Design.ts"
import { oneWayLatencyMs, type Placement } from "../Provider.ts"
import { dist, frames, mean, sim } from "../testing.ts"
import { registry } from "../components/Builtins.ts"

const regionOf = (p: Placement) => registry.provider(p.provider)?.regions.find((r) => r.id === p.region)
const at = (region: string): Placement => ({ provider: "aws", region })

describe("network latency between placements", () => {
  it("is about a millisecond inside a region", () => {
    expect(oneWayLatencyMs(at("us-east-1"), at("us-east-1"), regionOf)).toBe(1)
  })

  it("grows with distance", () => {
    const transatlantic = oneWayLatencyMs(at("us-east-1"), at("eu-west-1"), regionOf)
    const toSingapore = oneWayLatencyMs(at("us-east-1"), at("ap-southeast-1"), regionOf)
    expect(transatlantic).toBeGreaterThan(30)
    expect(transatlantic).toBeLessThan(60)
    expect(toSingapore).toBeGreaterThan(80)
    expect(toSingapore).toBeLessThan(160)
  })

  it("is symmetric", () => {
    expect(oneWayLatencyMs(at("eu-west-1"), at("sa-east-1"), regionOf)).toBeCloseTo(oneWayLatencyMs(at("sa-east-1"), at("eu-west-1"), regionOf), 6)
  })

  it("adds transit across providers and a last mile to the internet", () => {
    const internet: Placement = { provider: "internet", region: "us-east" }
    expect(oneWayLatencyMs(at("us-east-1"), internet, regionOf)).toBeGreaterThan(10)
  })

  const chain = (region: string) => {
    const b = Builder.make("latency", { seed: 4 })
    const web = b.add("common.client", { id: "web", region: "us-east", settings: { rps: 20 } })
    const fn = b.add("aws.lambda", { id: "fn", region, settings: { memory: 1769, duration: { mean: 5, cv: 0 } } })
    b.connect(web, fn)
    return b.build()
  }

  it("is applied to an edge unless someone sets it", async () => {
    const near = dist(await frames(chain("us-east-1"), 30_000), "web", "latency", 10_000)
    const far = dist(await frames(chain("ap-southeast-1"), 30_000), "web", "latency", 10_000)
    expect(far.p50 - near.p50).toBeGreaterThan(100)
  })
})

describe("regions in documents", () => {
  const resolve = (doc: Design.Doc) => Design.resolve(doc, registry)

  it("rejects a region the provider doesn't have, naming it", () => {
    const b = Builder.make("bad")
    b.add("aws.lambda", { id: "fn", region: "mars-north-1" })
    const { design, diagnostics } = resolve(b.build())
    expect(design).toBeUndefined()
    expect(diagnostics.map((d) => d.code)).toEqual(["unknown-region"])
    expect(diagnostics[0]!.message).toContain("mars-north-1")
  })

  it("uses the provider's default region when none is given", () => {
    const b = Builder.make("default")
    b.add("aws.lambda", { id: "fn" })
    const { design } = resolve(b.build())
    expect(design!.accounts.has("aws:us-east-1")).toBe(true)
  })

  it("decodes account quotas per placement and reports unknown or out-of-range ones", () => {
    const ok = Builder.make("accounts")
    ok.add("aws.lambda", { id: "a", region: "eu-west-1" })
    ok.account("aws:eu-west-1", { lambdaConcurrency: 250 })
    const good = resolve(ok.build()).design!.accounts.get("aws:eu-west-1")!.config as { lambdaConcurrency: number }
    expect(good.lambdaConcurrency).toBe(250)

    const bad = Builder.make("accounts")
    bad.add("aws.lambda", { id: "a", region: "eu-west-1" })
    bad.account("aws:eu-west-1", { sqsFifoHighThroughput: 10 }) // below the 300 TPS floor
    expect(resolve(bad.build()).diagnostics.some((d) => d.code === "bad-account")).toBe(true)
  })

  it("round-trips through the codec, regions and account overrides included", async () => {
    const b = Builder.make("round trip", { seed: 9 })
    b.connect(b.add("common.client", { id: "web", region: "eu-west" }), b.add("aws.apigateway", { id: "api", region: "eu-central-1" }))
    b.account("aws:eu-central-1", { apiGatewayRate: 4_000 })
    const codec = Design.codec(registry)
    const design = Schema.decodeUnknownSync(codec)(b.build())
    const encoded = Schema.encodeSync(codec)(design)
    expect(encoded.nodes.api!.region).toBe("eu-central-1")
    expect(encoded.accounts?.["aws:eu-central-1"]).toMatchObject({ apiGatewayRate: 4_000 })
    expect(Design.encode(Schema.decodeUnknownSync(codec)(encoded), registry)).toEqual(encoded)
  })
})

describe("regional quotas", () => {
  const twoRegions = () => {
    const b = Builder.make("two", { seed: 5 })
    for (const region of ["us-east-1", "eu-west-1"]) {
      const web = b.add("common.client", { id: `web-${region}`, settings: { arrival: "constant", rps: 300 } })
      const fn = b.add("aws.lambda", { id: `fn-${region}`, region, settings: { memory: 1769, duration: { mean: 1_000, cv: 0 } } })
      b.connect(web, fn)
    }
    b.account("aws:us-east-1", { lambdaConcurrency: 200 })
    return b.build()
  }

  it("belong to one region: exhausting us-east-1's Lambda concurrency leaves eu-west-1 alone", async () => {
    const all = await frames(twoRegions(), 30_000)
    expect(mean(all, "nodes", "web-us-east-1", "rates", "fail.Throttled", 10_000)).toBeGreaterThan(0)
    expect(mean(all, "nodes", "web-eu-west-1", "rates", "fail", 10_000)).toBe(0)
  })

  it("can be changed while the simulation runs", () =>
    sim(twoRegions(), (s) =>
      Effect.gen(function*() {
        const before = yield* s.advanceTo(15_000)
        expect(mean(before, "nodes", "web-us-east-1", "rates", "fail.Throttled", 10_000)).toBeGreaterThan(0)
        yield* s.configureAccount("aws:us-east-1", { lambdaConcurrency: 1_000 })
        const after = yield* s.advanceTo(45_000)
        expect(mean(after, "nodes", "web-us-east-1", "rates", "fail.Throttled", 35_000)).toBe(0)
      })))

  it("rejects a change for a placement the design doesn't use", () =>
    sim(twoRegions(), (s) =>
      Effect.gen(function*() {
        const outcome = yield* Effect.flip(s.configureAccount("aws:ap-south-1", { lambdaConcurrency: 5 }))
        expect(outcome._tag).toBe("NoSuchAccount")
      })))
})

describe("regional failures", () => {
  const regional = () => {
    const b = Builder.make("regional", { seed: 5 })
    const gwEast = b.add("aws.apigateway", { id: "gw-east", region: "us-east-1" })
    const gwWest = b.add("aws.apigateway", { id: "gw-west", region: "eu-west-1" })
    const backend = b.add("common.http-endpoint", { id: "partner", settings: { latency: { mean: 10, cv: 0 } } })
    for (const [name, gw] of [["east", gwEast], ["west", gwWest]] as const) {
      b.connect(b.add("common.client", { id: `web-${name}`, settings: { arrival: "constant", rps: 50 } }), gw)
      b.connect(gw, backend)
    }
    return b.build()
  }

  it("take down everything in a region and nothing elsewhere", () =>
    sim(regional(), (s) =>
      Effect.gen(function*() {
        yield* s.faults.inject({ kind: "region", id: "aws:us-east-1" }, { _tag: "Outage" })
        const all = yield* s.advanceTo(10_000)
        expect(mean(all, "nodes", "web-east", "rates", "ok", 3_000)).toBe(0)
        expect(mean(all, "nodes", "web-east", "rates", "fail", 3_000)).toBeGreaterThan(40)
        expect(mean(all, "nodes", "web-west", "rates", "ok", 3_000)).toBeGreaterThan(40)
        // The external partner is outside AWS, so the region failure doesn't touch it.
        expect(mean(all, "nodes", "partner", "rates", "in", 3_000)).toBeGreaterThan(40)
      })))

  it("recover when cleared", () =>
    sim(regional(), (s) =>
      Effect.gen(function*() {
        const fault = yield* s.faults.inject({ kind: "region", id: "aws:us-east-1" }, { _tag: "Outage" })
        yield* s.advanceTo(5_000)
        yield* s.faults.clear(fault.id)
        const all = yield* s.advanceTo(15_000)
        expect(mean(all, "nodes", "web-east", "rates", "ok", 10_000)).toBeGreaterThan(40)
      })))

  it("can't target a region the design doesn't use", () =>
    sim(regional(), (s) =>
      Effect.gen(function*() {
        const outcome = yield* Effect.flip(s.faults.inject({ kind: "region", id: "aws:ap-south-1" }, { _tag: "Outage" }))
        expect(outcome._tag).toBe("NoSuchTarget")
      })))
})
