import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../../Builder.ts"
import { gauge, mean, rate } from "../../testing.ts"
import { sim } from "../testing.ts"

const ZONE_A = { kind: "zone", id: "internet:eu-west:eu-west-a" } as const

/** A client calling a service of replicas directly: the fleet's own idealised balancer. */
const service = (settings: Record<string, unknown>, rps = 300) => {
  const b = Builder.make("fleet", { seed: 4 })
  const web = b.add("common.client", { id: "web", region: "eu-west", settings: { rps, arrival: "constant" } })
  const svc = b.add("common.service", { id: "svc", region: "eu-west", settings: { serviceTime: { mean: 50, cv: 0 }, fanOut: "none", ...settings } })
  b.connect(web, svc, { timeout: "10 seconds" })
  return b.build()
}

/** A client calling a fleet of `test.workers` directly. */
const workers = (settings: Record<string, unknown>, rps = 100) => {
  const b = Builder.make("workers", { seed: 5 })
  const web = b.add("common.client", { id: "web", region: "eu-west", settings: { rps, arrival: "constant" } })
  const w = b.add("test.workers", { id: "w", region: "eu-west", settings })
  b.connect(web, w, { timeout: "1 minute" })
  return b.build()
}

describe("a fleet spread over zones", () => {
  it("spreads its units evenly over its zones, the first zones getting the odd ones", () =>
    sim(service({ replicas: 7, zones: 3 }), (s) =>
      Effect.gen(function*() {
        const all = yield* s.advanceTo(2_000)
        expect([gauge(all, "svc", "ready.eu-west-a", 0, 2_000), gauge(all, "svc", "ready.eu-west-b", 0, 2_000), gauge(all, "svc", "ready.eu-west-c", 0, 2_000)]).toEqual([3, 2, 2])
      })))

  it("loses the units in a zone that goes down, replaces them in the other zones, and evens out when it comes back", () =>
    sim(service({ replicas: 6, zones: 3, startup: "10 seconds", replaceAfter: "5 seconds" }), (s) =>
      Effect.gen(function*() {
        const before = yield* s.advanceTo(10_000)
        // Zone a is down from 10 s to 50 s.
        yield* s.faults.inject(ZONE_A, { _tag: "Outage" }, 40_000)
        const all = [...before, ...(yield* s.advanceTo(120_000))]
        const zones = (from: number, to: number) => ["a", "b", "c"].map((z) => gauge(all, "svc", `ready.eu-west-${z}`, from, to))
        expect(zones(0, 10_000)).toEqual([2, 2, 2])
        // Its two replicas in zone a die with it, and the requests they were working on fail.
        expect(gauge(all, "svc", "ready", 10_500, 15_000)).toBe(4)
        expect(zones(10_500, 15_000)).toEqual([0, 2, 2])
        const probe = (yield* s.probe("svc")).state as { lost: number; replaced: number; refused: number }
        expect(probe.lost).toBeGreaterThan(0)
        expect(probe.lost).toBeLessThan(10)
        // Noticed after 5 s, they are started again in zones b and c, and are ready 10 s later.
        expect(gauge(all, "svc", "starting", 15_500, 24_750)).toBe(2)
        expect(zones(25_500, 50_000)).toEqual([0, 3, 3])
        // When zone a is back, one is started there before one of b's goes, then one before one of c's: 2, 2, 2 again,
        // never fewer than six ready on the way.
        expect(zones(72_000, 120_000)).toEqual([2, 2, 2])
        expect(Math.min(...all.filter((f) => f.t > 25_500).map((f) => f.nodes.svc!.gauges.ready!))).toBe(6)
        expect(probe.replaced).toBe(2)
        // 300 requests a second at 50 ms is 15 busy workers: four replicas had room for all of them.
        expect(probe.refused).toBe(0)
        expect(rate(all, "web", "ok", 11_000)).toBeCloseTo(300, -1)
      })))

  it("a unit that dies in its grace period is replaced only once the grace period is over", () =>
    sim(workers({ desired: 3, zones: 3, grace: "1 minute", detect: "5 seconds", launch: "5 seconds", boot: "5 seconds" }), (s) =>
      Effect.gen(function*() {
        // Three more units, up at 10 s and in their grace period until 70 s.
        yield* s.configureNode("w", { desired: 6, zones: 3, grace: "1 minute", detect: "5 seconds", launch: "5 seconds", boot: "5 seconds" })
        yield* s.advanceTo(20_000)
        yield* s.faults.inject(ZONE_A, { _tag: "Outage" })
        yield* s.advanceTo(40_000)
        // The old unit in zone a is noticed after 5 s and replaced; the new one there isn't, yet.
        const launched = (yield* s.probe("w")).state as { launched: number }
        expect(launched.launched).toBe(7)
        yield* s.advanceTo(75_000)
        expect(((yield* s.probe("w")).state as { launched: number }).launched).toBe(8)
      })))
})

describe("a fleet scaling in", () => {
  it("drains the units it lets go: they take no new requests and finish the ones they hold, so none is lost", () =>
    // 2 s a request at 8 a second: 16 busy workers, which two replicas of ten still hold.
    sim(service({ replicas: 6, serviceTime: { mean: 2000, cv: 0 } }, 8), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(10_000)
        yield* s.configureNode("svc", { replicas: 2, serviceTime: { mean: 2000, cv: 0 }, fanOut: "none" })
        const all = yield* s.advanceTo(30_000)
        expect(gauge(all, "svc", "ready", 10_500, 30_000)).toBe(2)
        // Some are still finishing just after; none after 2 s, the longest a request takes.
        expect(gauge(all, "svc", "draining", 10_250, 10_500)).toBeGreaterThan(0)
        expect(gauge(all, "svc", "draining", 12_500, 30_000)).toBe(0)
        expect(rate(all, "svc", "fail", 0)).toBe(0)
        expect(((yield* s.probe("svc")).state as { lost: number }).lost).toBe(0)
      })))

  it("cuts off what a unit still holds when its drain time runs out", () =>
    sim(service({ replicas: 6, serviceTime: { mean: 2000, cv: 0 }, drain: "500 millis" }, 8), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(10_000)
        yield* s.configureNode("svc", { replicas: 2, serviceTime: { mean: 2000, cv: 0 }, fanOut: "none", drain: "500 millis" })
        const all = yield* s.advanceTo(20_000)
        expect(gauge(all, "svc", "draining", 11_000, 20_000)).toBe(0)
        const lost = ((yield* s.probe("svc")).state as { lost: number }).lost
        // Four replicas held about 11 requests between them, half of them with more than half a second to go.
        expect(lost).toBeGreaterThan(3)
        expect(rate(all, "svc", "fail.Unavailable", 10_000, 11_000)).toBeGreaterThan(0)
      })))
})

describe("a fleet's capacity and interruptions", () => {
  it("keeps launches the account's quota refuses requested, and starts them once the quota allows", () =>
    sim(workers({ desired: 5, quota: 3 }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(20_000)
        const before = (yield* s.probe("w")).state as { serving: number; requested: number }
        expect(before).toMatchObject({ serving: 3, requested: 2 })
        yield* s.configureNode("w", { desired: 5, quota: 5 })
        // Tried again within 5 s, then 10 s to launch and boot.
        const all = yield* s.advanceTo(40_000)
        expect(gauge(all, "w", "serving", 36_000, 40_000)).toBe(5)
        expect(((yield* s.probe("w")).state as { requested: number }).requested).toBe(0)
      })))

  it("interrupts units with a notice: each stops taking work at once, is replaced at once, and nothing it held is lost", () =>
    sim(workers({ desired: 4, interruptionsPerUnitHour: 30, notice: "2 minutes" }, 200), (s) =>
      Effect.gen(function*() {
        const all = yield* s.advanceTo(600_000)
        const probe = (yield* s.probe("w")).state as { interrupted: number; launched: number; lost: number }
        // 4 units at 30 an hour each is 20 in ten minutes, give or take.
        expect(probe.interrupted).toBeGreaterThan(10)
        expect(probe.interrupted).toBeLessThan(30)
        expect(probe.launched).toBe(4 + probe.interrupted)
        // A request takes 40 ms, far less than the two minutes' notice.
        expect(probe.lost).toBe(0)
        expect(rate(all, "w", "fail", 0)).toBe(0)
        // Never more than one short for long: each replacement takes 10 s.
        expect(gauge(all, "w", "serving", 0, 600_000)).toBeGreaterThan(3.5)
      })))
})

describe("a Crash fault", () => {
  it("crashes that many units at once; the fleet notices and replaces them", async () => {
    const b = Builder.make("crash", { seed: 5 })
    const web = b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 100 } })
    const svc = b.add("common.service", { id: "svc", settings: { replicas: 6, concurrency: 10, serviceTime: { mean: 20, cv: 0 }, startup: "5 seconds", replaceAfter: "10 seconds" } })
    b.connect(web, svc)
    const all = await sim(b.build(), (s) =>
      Effect.gen(function*() {
        const before = yield* s.advanceTo(10_000)
        yield* s.faults.inject({ kind: "node", id: "svc" }, { _tag: "Crash", units: 2, on: "units" })
        return [...before, ...(yield* s.advanceTo(40_000))]
      }))
    const ready = (from: number, to: number) => mean(all, "nodes", "svc", "gauges", "ready", from, to)
    expect(ready(5_000, 10_000)).toBe(6)
    // Two gone at once; noticed after 10 s, replaced after another 5 s of start-up.
    expect(ready(11_000, 19_000)).toBe(4)
    expect(ready(27_000, 40_000)).toBe(6)
    // A Crash on the hosts does nothing to a fleet whose units serve.
    const untouched = await sim(b.build(), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(10_000)
        yield* s.faults.inject({ kind: "node", id: "svc" }, { _tag: "Crash", units: 2, on: "hosts" })
        return yield* s.advanceTo(20_000)
      }))
    expect(mean(untouched, "nodes", "svc", "gauges", "ready", 11_000, 20_000)).toBe(6)
  })
})
