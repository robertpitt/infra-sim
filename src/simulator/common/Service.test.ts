import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../Builder.ts"
import { frames, mean, sim } from "../components/testing.ts"

/** clients -> a service of replicas (10 workers each, 50 ms a request). */
const service = (load: Record<string, unknown>, settings: Record<string, unknown> = {}, scale?: Record<string, unknown>) => {
  const b = Builder.make("service", { seed: 6 })
  const web = b.add("common.client", { id: "web", settings: { arrival: "constant", ...load } })
  const svc = b.add("common.service", { id: "svc", settings: { serviceTime: { mean: 50, cv: 0 }, fanOut: "none", ...settings } })
  b.connect(web, svc, { timeout: "1 minute" })
  // Busy workers per replica, against 6 of 10: a replica still starting counts as idle, so it can't overshoot while they start.
  if (scale !== undefined) b.control("core.target-tracking", svc, { metric: "busy", per: "unit", targetValue: 6, setting: "replicas", min: 1, max: 40, period: "10 seconds", window: "20 seconds", scaleOutCooldown: 0, ...scale }, { id: "hpa" })
  return b.build()
}

describe("common.service", () => {
  it("is a queue in front of replicas × concurrency workers: half the load, half busy", async () => {
    // 2 replicas × 10 workers at 50 ms is 400 a second; 200 a second keeps half of them busy.
    const all = await frames(service({ rps: 200 }), 20_000)
    expect(mean(all, "nodes", "svc", "gauges", "utilization", 5_000)).toBeCloseTo(0.5, 1)
    expect(mean(all, "nodes", "svc", "gauges", "queued", 5_000)).toBeLessThan(1)
    expect(mean(all, "nodes", "svc", "rates", "ok", 5_000)).toBeCloseTo(200, -1)
  })

  it("past its capacity it queues up to the limit, then refuses the rest", async () => {
    const all = await frames(service({ rps: 600 }), 20_000)
    expect(mean(all, "nodes", "svc", "gauges", "queued", 5_000)).toBeCloseTo(100, -1)
    expect(mean(all, "nodes", "svc", "rates", "ok", 5_000)).toBeCloseTo(400, -1)
    expect(mean(all, "nodes", "svc", "rates", "fail.Unavailable", 5_000)).toBeCloseTo(200, -1)
  })

  it("added replicas take the start-up time to become ready", () =>
    sim(service({ rps: 600 }, { startup: "10 seconds" }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(5_000)
        yield* s.configureNode("svc", { serviceTime: { mean: 50, cv: 0 }, fanOut: "none", startup: "10 seconds", replicas: 4 })
        const all = yield* s.advanceTo(30_000)
        expect(mean(all, "nodes", "svc", "gauges", "starting", 6_000, 14_000)).toBe(2)
        expect(mean(all, "nodes", "svc", "gauges", "ready", 6_000, 14_000)).toBe(2)
        expect(mean(all, "nodes", "svc", "gauges", "ready", 16_000)).toBe(4)
        // Once ready, 800 a second of capacity takes the whole load.
        expect(mean(all, "nodes", "svc", "rates", "fail.Unavailable", 20_000)).toBe(0)
      })))

  it("removed replicas stop at once, without failing what they were doing", () =>
    sim(service({ rps: 100 }, { replicas: 6 }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(5_000)
        yield* s.configureNode("svc", { serviceTime: { mean: 50, cv: 0 }, fanOut: "none", replicas: 1 })
        const all = yield* s.advanceTo(15_000)
        expect(mean(all, "nodes", "svc", "gauges", "ready", 6_000)).toBe(1)
        expect(mean(all, "nodes", "svc", "rates", "fail", 0)).toBe(0)
      })))

  it("an autoscaler watching busy workers per replica adds replicas until the load fits, as a Kubernetes HPA does", () =>
    sim(service({ rps: 600 }, { startup: "10 seconds" }, {}), (s) =>
      Effect.gen(function*() {
        const all = yield* s.advanceTo(180_000)
        // 600 a second at 50 ms is 30 busy workers: at 6 a replica that is 5 replicas.
        const ready = (yield* s.probe("svc")).state as { ready: number }
        expect(ready.ready).toBeGreaterThanOrEqual(5)
        expect(ready.ready).toBeLessThanOrEqual(6)
        expect(mean(all, "nodes", "svc", "rates", "fail.Unavailable", 0, 10_000)).toBeGreaterThan(100)
        expect(mean(all, "nodes", "svc", "rates", "fail.Unavailable", 120_000)).toBe(0)
      })))
})
