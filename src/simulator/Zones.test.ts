import { Duration, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "./Builder.ts"
import { mean, sim } from "./components/testing.ts"
import { layer, registry } from "./components/registry.ts"
import * as Design from "./Design.ts"
import * as Fault from "./Fault.ts"
import { CROSS_ZONE_MS, oneWayLatencyMs, type Placement } from "./Provider.ts"
import * as Scenario from "./Scenario.ts"

const regionOf = (p: Placement) => registry.provider(p.provider)?.regions.find((r) => r.id === p.region)
const zonesOf = (provider: string, region: string) => registry.provider(provider)?.regions.find((r) => r.id === region)?.zones

describe("availability zones", () => {
  it("are named after their region, as many as AWS lists", () => {
    expect(zonesOf("aws", "us-east-1")).toEqual(["us-east-1a", "us-east-1b", "us-east-1c", "us-east-1d", "us-east-1e", "us-east-1f"])
    expect(zonesOf("aws", "eu-west-1")).toEqual(["eu-west-1a", "eu-west-1b", "eu-west-1c"])
    expect(zonesOf("aws", "us-west-2")).toHaveLength(4)
    // A place outside any cloud has three, by assumption.
    expect(zonesOf("internet", "eu-west")).toEqual(["eu-west-a", "eu-west-b", "eu-west-c"])
  })

  it("add a little latency between nodes in different zones of a region, and nothing otherwise", () => {
    const at = (zone?: string): Placement => ({ provider: "aws", region: "us-east-1", ...(zone === undefined ? {} : { zone }) })
    expect(oneWayLatencyMs(at("us-east-1a"), at("us-east-1a"), regionOf)).toBe(1)
    expect(oneWayLatencyMs(at("us-east-1a"), at("us-east-1b"), regionOf)).toBe(1 + CROSS_ZONE_MS)
    expect(oneWayLatencyMs(at("us-east-1a"), at(), regionOf)).toBe(1)
    expect(oneWayLatencyMs(at(), at(), regionOf)).toBe(1)
  })

  it("are written on a node as `zone`, checked against its region, and kept by the codec", () => {
    const b = Builder.make("zoned")
    const db = b.add("common.http-endpoint", { id: "db", region: "eu-west", zone: "eu-west-b" })
    const app = b.add("common.http-endpoint", { id: "app", region: "eu-west", zone: "eu-west-a" })
    b.connect(app, db)
    const doc = b.build()
    const { design, diagnostics } = Design.resolve(doc, registry)
    expect(diagnostics).toEqual([])
    const codec = Design.codec(registry)
    const encoded = Schema.encodeSync(codec)(Schema.decodeUnknownSync(codec)(doc))
    expect(encoded.nodes.db?.zone).toBe("eu-west-b")
    // The estimated latency between them includes crossing zones.
    const edge = [...design!.edgeIndex.keys()][0]!
    expect((encoded.edges[edge]?.settings as { latency: { mean: number } }).latency.mean).toBe(11 + CROSS_ZONE_MS)

    const wrong = Builder.make("wrong")
    wrong.add("common.http-endpoint", { id: "db", region: "eu-west", zone: "us-east-1a" })
    const bad = Design.resolve(wrong.build(), registry)
    expect(bad.design).toBeUndefined()
    expect(bad.diagnostics.map((d) => d.code)).toEqual(["unknown-zone"])
    expect(bad.diagnostics[0]!.message).toContain("eu-west-a, eu-west-b, eu-west-c")
  })

  it("can be faulted like regions, by Outage, Errors and Slow", () => {
    const kinds = Object.fromEntries(Fault.catalog.map((k) => [k.tag, k.targets]))
    expect(kinds.Outage).toContain("zone")
    expect(kinds.Errors).toContain("zone")
    expect(kinds.Slow).toContain("zone")
    expect(kinds.Blackhole).not.toContain("zone")
  })
})

describe("zone faults", () => {
  /** A client calling two endpoints in two zones, and one with no zone, in the same place. */
  const design = () => {
    const b = Builder.make("zones", { seed: 3 })
    const web = b.add("common.client", { id: "web", region: "eu-west", settings: { rps: 300, arrival: "constant" } })
    for (const [id, zone] of [["in-a", "eu-west-a"], ["in-b", "eu-west-b"], ["regional", undefined]] as const) {
      const n = b.add("common.http-endpoint", { id, region: "eu-west", ...(zone === undefined ? {} : { zone }), settings: { latency: { mean: 5, cv: 0 } } })
      b.connect(web, n)
    }
    return b.build()
  }

  it("take down what is placed in the zone, and nothing else in the region", () =>
    sim(design(), (s) =>
      Effect.gen(function*() {
        yield* s.faults.inject({ kind: "zone", id: "internet:eu-west:eu-west-a" }, { _tag: "Outage" })
        const all = yield* s.advanceTo(10_000)
        expect(mean(all, "nodes", "in-a", "rates", "fail.Unavailable", 1_000)).toBeGreaterThan(0)
        expect(mean(all, "nodes", "in-a", "rates", "ok", 1_000)).toBe(0)
        expect(mean(all, "nodes", "in-b", "rates", "fail", 1_000)).toBe(0)
        expect(mean(all, "nodes", "regional", "rates", "fail", 1_000)).toBe(0)
      })))

  it("leave a region fault taking everything in the region down, zoned or not", () =>
    sim(design(), (s) =>
      Effect.gen(function*() {
        yield* s.faults.inject({ kind: "region", id: "internet:eu-west" }, { _tag: "Outage" })
        const all = yield* s.advanceTo(10_000)
        for (const id of ["in-a", "in-b", "regional"]) expect(mean(all, "nodes", id, "rates", "ok", 1_000)).toBe(0)
      })))

  it("slow a zone down, or fail a share of its calls", () =>
    sim(design(), (s) =>
      Effect.gen(function*() {
        yield* s.faults.inject({ kind: "zone", id: "internet:eu-west:eu-west-b" }, { _tag: "Slow", extra: Duration.millis(200) })
        yield* s.faults.inject({ kind: "zone", id: "internet:eu-west:eu-west-a" }, { _tag: "Errors", rate: 0.5 })
        const all = yield* s.advanceTo(10_000)
        const latency = (id: string) => all.filter((f) => f.t > 1_000).map((f) => f.nodes[id]?.dist.latency?.mean ?? 0)
        expect(Math.min(...latency("in-b"))).toBeGreaterThan(200)
        expect(Math.max(...latency("regional"))).toBeLessThan(10)
        const errors = mean(all, "nodes", "in-a", "rates", "fail", 1_000) / mean(all, "nodes", "in-a", "rates", "in", 1_000)
        expect(errors).toBeCloseTo(0.5, 1)
      })))

  it("refuse a zone the design doesn't have", () =>
    sim(design(), (s) =>
      Effect.gen(function*() {
        const missing = yield* Effect.flip(s.faults.inject({ kind: "zone", id: "internet:eu-west:eu-west-z" }, { _tag: "Outage" }))
        expect(missing._tag).toBe("NoSuchTarget")
      })))
})

describe("zone faults in scenarios", () => {
  const doc = (): Design.Doc => {
    const b = Builder.make("zones", { seed: 3 })
    const web = b.add("common.client", { id: "web", region: "eu-west", settings: { rps: 100, arrival: "constant" } })
    const svc = b.add("common.service", { id: "svc", region: "eu-west", settings: { replicas: 3, zones: 3, fanOut: "none", replaceAfter: "5 seconds", startup: "5 seconds" } })
    b.connect(web, svc)
    return b.build()
  }

  it("are written zone:<placement>:<zone>, or as the placement and zone alone", () => {
    expect(Scenario.check(doc(), { duration: "1m", timeline: [{ at: "10s", inject: { target: "zone:internet:eu-west:eu-west-a", fault: "Outage" } }] })).toEqual([])
    expect(Scenario.check(doc(), { duration: "1m", timeline: [{ at: "10s", inject: { target: "internet:eu-west:eu-west-a", fault: "Outage" } }] })).toEqual([])
    expect(Scenario.check(doc(), { duration: "1m", timeline: [{ at: "10s", inject: { target: "zone:eu-west-a", fault: "Outage" } }] })[0]).toContain("zone:<placement>:<zone>")
    expect(Scenario.check(doc(), { duration: "1m", timeline: [{ at: "10s", inject: { target: "zone:internet:eu-west:eu-west-a", fault: "Blackhole" } }] })[0]).toContain("can't be applied to a zone")
  })

  it("play out: a service loses a zone's replicas and gets them back elsewhere", async () => {
    const result = await Effect.runPromise(
      Scenario.run(doc(), {
        duration: "1m",
        timeline: [{ at: "20s", inject: { target: "zone:internet:eu-west:eu-west-a", fault: "Outage", for: "30s" } }],
        assert: [
          // One of three replicas is lost with the zone; noticed after 5 s, its replacement is ready 5 s later.
          { check: "svc.gauge.ready:max <= 2", from: "21s", to: "29s" },
          { check: "svc.gauge.ready:min >= 3", from: "31s", to: "1m" }
        ]
      }).pipe(Effect.provide(layer))
    )
    expect(result.assertions.map((a) => a.passed)).toEqual([true, true])
    expect(result.faults[0]).toMatchObject({ target: "zone:internet:eu-west:eu-west-a", fault: "Outage" })
  })
})
