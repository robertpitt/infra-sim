import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../../Builder.ts"
import { mean, rate } from "../../testing.ts"
import type { Frame } from "../../Telemetry.ts"
import type { State } from "../TargetGroup.ts"
import { sim } from "../testing.ts"

const edgeGauge = (all: ReadonlyArray<Frame>, name: string, from: number, to = Infinity) => mean(all, "edges", "tg", "gauges", name, from, to)
const shares = (all: ReadonlyArray<Frame>, units: number, from: number, to = Infinity) =>
  Array.from({ length: units }, (_, i) => rate(all, "w", `unit.w${i + 1}`, from, to))

/** Clients → a load balancer → its target group (`core.target-group`, edge `tg`) → a fleet of workers (40 ms a request). */
const balanced = (workers: Record<string, unknown>, group: Record<string, unknown> = {}, rps = 300) => {
  const b = Builder.make("balanced", { seed: 9 })
  const web = b.add("common.client", { id: "web", region: "eu-west", settings: { rps, arrival: "constant" } })
  const lb = b.add("test.balancer", { id: "lb", region: "eu-west" })
  const w = b.add("test.workers", { id: "w", region: "eu-west", settings: workers })
  b.connect(web, lb, { timeout: "10 seconds" })
  b.connect(lb.port("targets"), w, { timeout: "5 seconds", ...group }, { connector: "core.target-group", id: "tg" })
  return b.build()
}

describe("a target group's health checks", () => {
  it("sends requests to a dead unit until its health checks catch it, then the fleet replaces it", () =>
    // Checks every 10 s from t = 0, three failures to be unhealthy; the fleet would take ten minutes to notice by itself.
    sim(balanced({ desired: 3, zones: 3, detect: "10 minutes" }), (s) =>
      Effect.gen(function*() {
        const before = yield* s.advanceTo(61_000)
        yield* s.faults.inject({ kind: "zone", id: "internet:eu-west:eu-west-a" }, { _tag: "Outage" })
        const all = [...before, ...(yield* s.advanceTo(150_000))]
        expect(rate(all, "lb", "lb.502", 0, 61_000)).toBe(0)
        // A third of the requests reach the dead unit in zone a: connection refused, a 502, for as long as it is healthy
        // to the target group. The checks at 70, 80 and 90 s fail.
        expect(rate(all, "lb", "lb.502", 62_000, 90_000)).toBeCloseTo(100, -1)
        expect(rate(all, "lb", "lb.502", 90_500)).toBe(0)
        expect(rate(all, "lb", "ok", 90_500)).toBeCloseTo(300, -1)
        // Told, the fleet replaces it in another zone (launch and boot: 10 s); the new target gets requests once it has
        // passed one check, the first as it registers.
        expect(edgeGauge(all, "targets.healthy", 91_000, 100_000)).toBe(2)
        expect(edgeGauge(all, "targets.healthy", 101_000)).toBe(3)
        expect(rate(all, "w", "unit.w4", 91_000, 100_000)).toBe(0)
        expect(rate(all, "w", "unit.w4", 101_000)).toBeCloseTo(100, -1)
        expect(rate(all, "lb", "ok", 101_000)).toBeCloseTo(300, -1)
      })))

  it("fails open when no target is healthy, and answers 503 itself when told not to", async () => {
    // Every unit in one zone, and the zone goes down. Nobody replaces the units, so they stay registered.
    const outage = (failOpen: boolean) =>
      sim(balanced({ desired: 2, zones: 1, detect: "10 minutes" }, { failOpen, replaceUnhealthy: false }), (s) =>
        Effect.gen(function*() {
          yield* s.advanceTo(5_000)
          yield* s.faults.inject({ kind: "zone", id: "internet:eu-west:eu-west-a" }, { _tag: "Outage" })
          const all = yield* s.advanceTo(60_000)
          return { e502: rate(all, "lb", "lb.502", 35_000), e503: rate(all, "lb", "lb.503", 35_000), state: (yield* s.probeEdge("tg")).state as State }
        }))
    const open = await outage(true)
    expect(open.e502).toBeCloseTo(300, -1)
    expect(open.e503).toBe(0)
    const closed = await outage(false)
    expect(closed.e503).toBeCloseTo(300, -1)
    expect(closed.e502).toBe(0)
    expect(closed.state.noTarget).toBeGreaterThan(0)
  })

  it("checks across the edge's transport, without counting the checks as requests", () =>
    sim(balanced({ desired: 3 }), (s) =>
      Effect.gen(function*() {
        const all = yield* s.advanceTo(30_000)
        // Calls across the edge are the requests and nothing else, though every target was checked three times.
        expect(mean(all, "edges", "tg", "rates", "calls", 1_000)).toBeCloseTo(300, -1)
        expect(edgeGauge(all, "targets.healthy", 1_000)).toBe(3)
      })))
})

describe("a target group choosing targets", () => {
  it("ramps a new target up over its slow start, then gives it a full share", () =>
    sim(balanced({ desired: 2, launch: 0, boot: "1 second" }, { slowStart: "60 seconds" }, 400), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(10_000)
        // Two more units, up at 11 s and healthy as soon as they pass a check.
        yield* s.configureNode("w", { desired: 4, launch: 0, boot: "1 second" })
        const all = yield* s.advanceTo(100_000)
        // Half-way through (around 41 s) each new one has half a share: 0.5 / (2 + 0.5 + 0.5) of 400.
        const [old1, old2, new1, new2] = shares(all, 4, 39_000, 43_000)
        expect(new1).toBeCloseTo(67, -1)
        expect(new2).toBeCloseTo(67, -1)
        expect(old1).toBeCloseTo(133, -1)
        expect(old2).toBeCloseTo(133, -1)
        // A minute in, all four are equal.
        for (const share of shares(all, 4, 75_000)) expect(share).toBeCloseTo(100, -1)
      })))

  it("sends fewer requests to a slow unit with least outstanding requests than with round robin", async () => {
    // The first of four units takes 200 ms a request, the others 40 ms.
    const run = (algorithm: string) =>
      sim(balanced({ desired: 4, slowFirst: 5 }, { algorithm }, 400), (s) =>
        Effect.gen(function*() {
          const all = yield* s.advanceTo(30_000)
          const latency = all.filter((f) => f.t > 5_000).flatMap((f) => (f.nodes.lb?.dist.latency === undefined ? [] : [f.nodes.lb.dist.latency.mean]))
          return { slow: rate(all, "w", "unit.w1", 5_000), latency: latency.reduce((a, b) => a + b, 0) / latency.length }
        }))
    const rr = await run("round-robin")
    const lor = await run("least-outstanding")
    // Round robin gives it a quarter, whatever it does with them; least outstanding sees its requests pile up and sends
    // fewer: about one in eleven.
    expect(rr.slow).toBeCloseTo(100, -1)
    expect(lor.slow).toBeLessThan(45)
    expect(lor.slow).toBeGreaterThan(25)
    // A quarter at 200 ms makes a mean of 70 ms plus the network; least outstanding brings it close to 50.
    expect(rr.latency).toBeGreaterThan(70)
    expect(lor.latency).toBeLessThan(rr.latency - 15)
  })

  it("with cross-zone off sends each zone's share to that zone's targets only", async () => {
    // Four units over three zones: two in a, one each in b and c.
    const run = (crossZone: boolean) =>
      sim(balanced({ desired: 4, zones: 3 }, { crossZone }, 400), (s) => Effect.map(s.advanceTo(20_000), (all) => shares(all, 4, 1_000)))
    const [a1, b, c, a2] = await run(false)
    // A third of the requests per zone: a's two units get a sixth each, b's and c's units a third.
    expect(a1).toBeCloseTo(67, -1)
    expect(a2).toBeCloseTo(67, -1)
    expect(b).toBeCloseTo(133, -1)
    expect(c).toBeCloseTo(133, -1)
    for (const share of await run(true)) expect(share).toBeCloseTo(100, -1)
  })

  it("sends one key to one target with a flow hash", () =>
    sim(balanced({ desired: 4 }, { algorithm: "flow-hash" }, 400), (s) =>
      Effect.gen(function*() {
        yield* s.configureNode("web", { rps: 400, arrival: "constant", hotKeys: 1 })
        const all = yield* s.advanceTo(10_000)
        const busy = shares(all, 4, 1_000).filter((share) => share > 0)
        expect(busy).toHaveLength(1)
        expect(busy[0]).toBeCloseTo(400, -1)
      })))
})

describe("a target group and a fleet scaling in", () => {
  it("stops sending to units being let go, which finish what they hold: no request fails", () =>
    // 2 s a request at 20 a second: 40 in flight over six units, then over two.
    sim(balanced({ desired: 6, serviceTime: { mean: 2000, cv: 0 } }, {}, 20), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(10_000)
        yield* s.configureNode("w", { desired: 2, serviceTime: { mean: 2000, cv: 0 } })
        const all = yield* s.advanceTo(30_000)
        expect(edgeGauge(all, "targets.draining", 10_250, 11_000)).toBeGreaterThan(0)
        expect(edgeGauge(all, "targets.draining", 12_500)).toBe(0)
        expect(edgeGauge(all, "targets.healthy", 12_500)).toBe(2)
        expect(rate(all, "lb", "fail", 0)).toBe(0)
        expect(((yield* s.probe("w")).state as { lost: number }).lost).toBe(0)
        expect(rate(all, "lb", "ok", 13_000)).toBeCloseTo(20, 0)
      })))
})
