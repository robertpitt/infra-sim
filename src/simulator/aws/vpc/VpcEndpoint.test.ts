import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../../Builder.ts"
import { registry } from "../../components/registry.ts"
import { dist, mean, sim } from "../../components/testing.ts"
import * as Design from "../../Design.ts"

/** Clients call a VPC endpoint in a VPC, which calls an object store. */
const design = (endpoint: Record<string, unknown> = {}, load: Record<string, unknown> = {}) => {
  const b = Builder.make("endpoint", { seed: 9 })
  const box = b.add("aws.region", { id: "box" })
  const vpc = b.add("aws.vpc", { id: "vpc", parent: box })
  const gate = b.add("aws.vpc-endpoint", { id: "endpoint", parent: vpc, settings: { latency: { mean: 0.5, cv: 0 }, ...endpoint } })
  const web = b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 20, ...load } })
  const target = b.add("common.http-endpoint", { id: "service", settings: { latency: { mean: 20, cv: 0 } } })
  b.connect(web, gate, { latency: { mean: 1, cv: 0 } })
  b.connect(gate, target, { latency: { mean: 1, cv: 0 } })
  return b.build()
}

const run = (doc: Design.Doc, ms = 20_000) =>
  sim(doc, (s) =>
    Effect.gen(function*() {
      const all = yield* s.advanceTo(ms)
      const p = yield* s.probe("endpoint")
      return { all, state: p.state as Record<string, number> }
    }))

describe("aws.vpc-endpoint", () => {
  it("a gateway endpoint is only a route: it adds no latency", async () => {
    const { all } = await run(design({ type: "gateway" }))
    // 20 ms at the service, 1 ms each way on both edges.
    expect(dist(all, "web", "latency", 5_000).p50).toBeCloseTo(24, 0)
  })

  it("an interface endpoint adds its hop", async () => {
    const gateway = dist((await run(design({ type: "gateway" }))).all, "web", "latency", 5_000).p50
    const iface = dist((await run(design({ type: "interface" }))).all, "web", "latency", 5_000).p50
    expect(iface - gateway).toBeGreaterThan(0.3)
    expect(iface - gateway).toBeLessThan(0.8)
  })

  it("a gateway endpoint has no published bandwidth limit", async () => {
    const { state } = await run(design({ type: "gateway" }, { payload: 100_000 }))
    expect(state.drops).toBe(0)
    expect(state.bytes).toBeGreaterThan(1e9)
  })

  it("an interface endpoint carries 10 Gbps per zone and drops what is beyond it", async () => {
    // 20 requests a second of 100 MB is 16 Gbps; one zone carries 10.
    const load = { payload: 100_000 }
    const oneZone = await run(design({ type: "interface", availabilityZones: 1 }, load))
    expect(mean(oneZone.all, "nodes", "endpoint", "rates", "drops", 5_000)).toBeGreaterThan(3)
    // Two zones carry 20 Gbps: all of it fits.
    const twoZones = await run(design({ type: "interface", availabilityZones: 2 }, load))
    expect(twoZones.state.drops).toBe(0)
  })

  it("scales with the bandwidth setting, within 10 to 100 Gbps per zone", async () => {
    const { state } = await run(design({ type: "interface", availabilityZones: 1, bandwidth: 100 }, { payload: 100_000 }))
    expect(state.drops).toBe(0)
    for (const bandwidth of [9, 101]) {
      expect(Design.resolve(design({ bandwidth }), registry).diagnostics.map((d) => d.code)).toEqual(["bad-settings"])
    }
  })

  it("survives having nothing behind it", async () => {
    const b = Builder.make("bare", { seed: 1 })
    const box = b.add("aws.region", { id: "box" })
    const vpc = b.add("aws.vpc", { id: "vpc", parent: box })
    const gate = b.add("aws.vpc-endpoint", { id: "endpoint", parent: vpc })
    const web = b.add("common.client", { id: "web", settings: { rps: 10 } })
    b.connect(web, gate)
    const { state } = await run(b.build(), 5_000)
    expect(state.drops).toBe(0)
  })
})
