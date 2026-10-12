import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { dist, mean } from "../../components/testing.ts"
import type { Frame } from "../../Telemetry.ts"
import { balanced, registry, sim, zoneTarget } from "./testing.ts"

const node = (all: ReadonlyArray<Frame>, id: string, name: string, from: number, to = Infinity) => mean(all, "nodes", id, "rates", name, from, to)
const nlb = (o: Parameters<typeof balanced>[0] = {}) => balanced({ lb: "aws.nlb", ...o })

describe("aws.nlb", () => {
  it("routes through an NLB target group, keeping a flow (a key) on one target", () =>
    sim(nlb({ rps: 400, fleets: { fleet: { settings: { desired: 4 } } } }).build(), (s) =>
      Effect.gen(function*() {
        expect((yield* s.probeEdge("lb->fleet")).connector).toBe("aws.nlb.target-group")
        yield* s.configureNode("web", { rps: 400, arrival: "constant", hotKeys: 1 })
        const all = yield* s.advanceTo(10_000)
        const busy = [1, 2, 3, 4].map((i) => node(all, "fleet", `unit.u${i}`, 1_000)).filter((r) => r > 0)
        expect(busy).toHaveLength(1)
        expect(busy[0]).toBeCloseTo(400, -1)
        const state = (yield* s.probe("lb")).state as { zones: ReadonlyArray<unknown>; requests: number; elbResets: number }
        expect(state.zones).toHaveLength(3)
        expect(state.requests).toBeGreaterThan(3_900)
        expect(state.elbResets).toBe(0)
      })))

  it("has cross-zone off by default: each zone's nodes share its third among that zone's targets", async () => {
    // Four targets over three zones: two in a, one each in b and c.
    const run = (edge: Record<string, unknown>) =>
      sim(nlb({ rps: 400, fleets: { fleet: { settings: { desired: 4, zones: 3 }, edge } } }).build(), (s) =>
        Effect.map(s.advanceTo(20_000), (all) => [1, 2, 3, 4].map((i) => node(all, "fleet", `unit.u${i}`, 1_000))))
    const [a1, b, c, a2] = await run({})
    expect(a1).toBeCloseTo(67, -1)
    expect(a2).toBeCloseTo(67, -1)
    expect(b).toBeCloseTo(133, -1)
    expect(c).toBeCloseTo(133, -1)
    for (const share of await run({ crossZone: true })) expect(share).toBeCloseTo(100, -1)
  })

  it("takes a zone with no targets out of DNS (an ALB would answer 503 there)", () =>
    sim(nlb({ rps: 300, fleets: { fleet: { settings: { desired: 4, zones: 2 } } } }).build(), (s) =>
      Effect.gen(function*() {
        const all = yield* s.advanceTo(20_000)
        expect(node(all, "lb", "elb.resets", 0)).toBe(0)
        expect(node(all, "fleet", "in", 1_000)).toBeCloseTo(300, -1)
        expect(mean(all, "nodes", "lb", "gauges", "zones.inDns", 1_000)).toBe(2)
      })))

  it("adds next to no latency of its own", () =>
    sim(nlb({ fleets: { fleet: { settings: { desired: 3 } } } }).build(), (s) =>
      Effect.map(s.advanceTo(20_000), (all) => {
        // 40 ms in the target and the edge's 1 ms each way: nothing else.
        const lat = dist(all, "lb", "latency", 2_000)
        expect(lat.mean).toBeGreaterThan(41)
        expect(lat.mean).toBeLessThan(43)
      })))

  it("has no HTTP errors: a dead target's refused connections and a target's own errors pass through as they are", async () => {
    // Zone c goes down: its node, and its target. Cross-zone on, nodes a and b send a third of theirs to the dead target
    // (refused: passed on as it is) until health checks every 30 s with a 10 s timeout catch it at the second failure.
    const dead = await sim(nlb({ fleets: { fleet: { settings: { desired: 3, zones: 3 }, edge: { crossZone: true } } } }).build(), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(61_000)
        yield* s.faults.inject(zoneTarget("us-east-1c"), { _tag: "Outage" })
        return yield* s.advanceTo(200_000)
      }))
    expect(node(dead, "lb", "target.resets", 62_000, 119_000)).toBeGreaterThan(60)
    expect(node(dead, "lb", "target.resets", 122_000)).toBe(0)
    expect(node(dead, "web", "fail.Failed", 0)).toBe(0)
    expect(node(dead, "web", "fail", 122_000)).toBe(0)
    const failing = await sim(nlb({ fleets: { fleet: { settings: { errorRate: 0.1 } } } }).build(), (s) => s.advanceTo(20_000))
    expect(node(failing, "web", "fail.Failed", 2_000)).toBeCloseTo(30, -1)
  })

  it("resets a connection with no target, and one idle past its timeout", async () => {
    const empty = await sim(nlb({ fleets: { fleet: { settings: { desired: 0 } } } }).build(), (s) => s.advanceTo(10_000))
    expect(node(empty, "lb", "elb.resets", 1_000)).toBeCloseTo(300, -1)
    expect(node(empty, "web", "fail.Unavailable", 1_000)).toBeCloseTo(300, -1)
    // The shortest TCP idle timeout, 60 s, against a target that takes 90 s.
    const idle = await sim(
      nlb({ rps: 5, lbSettings: { idleTimeout: "60 seconds" }, fleets: { fleet: { settings: { serviceTime: { mean: 90_000, cv: 0 } } } } }).build(),
      (s) => s.advanceTo(150_000)
    )
    expect(node(idle, "lb", "elb.resets", 0, 59_000)).toBe(0)
    expect(node(idle, "lb", "elb.resets", 65_000)).toBeCloseTo(5, 0)
  })

  it("passes a read on as a read, and forwards to an ALB as its target", async () => {
    const b = nlb({ clientEdge: { request: { operation: "read" } }, fleets: {} })
    const alb = b.add("aws.alb", { id: "alb", parent: b.box })
    const fleet = b.add("test.elb-fleet", { id: "fleet", parent: b.box })
    b.connect(b.lb, alb, {}, { id: "lb->alb" })
    b.connect(alb, fleet, {}, { id: "alb->fleet" })
    const all = await sim(b.build(), (s) =>
      Effect.gen(function*() {
        expect((yield* s.probeEdge("lb->alb")).connector).toBe("aws.nlb.ip-target")
        return yield* s.advanceTo(20_000)
      }))
    expect(node(all, "fleet", "op.read", 2_000)).toBeCloseTo(300, -1)
    expect(node(all, "fleet", "op.write", 2_000)).toBe(0)
  })

  it("is placeable in a VPC", () => {
    expect(registry.get("aws.vpc")!.container!.accepts(registry.get("aws.nlb")!)).toBe(true)
  })
})
