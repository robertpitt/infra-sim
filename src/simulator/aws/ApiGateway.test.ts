import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../Builder.ts"
import { frames, mean, sim } from "../components/testing.ts"

const gateway = (api: Record<string, unknown>, load: Record<string, unknown>, backend: Record<string, unknown> = {}, account?: Record<string, unknown>, region = "us-east-1") => {
  const b = Builder.make("apigw", { seed: 3 })
  const web = b.add("common.client", { id: "web", settings: { arrival: "constant", ...load } })
  const gw = b.add("aws.apigateway", { id: "api", region, settings: api })
  const fn = b.add("aws.lambda", { id: "fn", region, settings: { memory: 1769, duration: { mean: 50, cv: 0 }, ...backend } })
  b.connect(web, gw)
  b.connect(gw, fn)
  if (account !== undefined) b.account(`aws:${region}`, account)
  return b.build()
}

describe("aws.apigateway", () => {
  it("throttles at the account rate with a token bucket: a burst is absorbed, then the steady rate holds", async () => {
    const all = await frames(gateway({}, { rps: 400 }, {}, { apiGatewayRate: 100 }), 70_000)
    // The 5,000-token bucket absorbs 300/s of excess for about 16 s.
    expect(mean(all, "nodes", "web", "rates", "fail.Throttled", 0, 10_000)).toBe(0)
    expect(mean(all, "nodes", "web", "rates", "ok", 40_000)).toBeCloseTo(100, -1)
    expect(mean(all, "nodes", "web", "rates", "fail.Throttled", 40_000)).toBeGreaterThan(280)
  })

  it("the account rate is shared by every API in the region", () => {
    const b = Builder.make("shared", { seed: 3 })
    const backend = b.add("common.http-endpoint", { id: "ext", settings: { latency: { mean: 10, cv: 0 } } })
    for (const id of ["a", "b"]) {
      const gw = b.add("aws.apigateway", { id })
      b.connect(b.add("common.client", { id: `web-${id}`, settings: { arrival: "constant", rps: 200 } }), gw)
      b.connect(gw, backend)
    }
    b.account("aws:us-east-1", { apiGatewayRate: 100 })
    return frames(b.build(), 70_000).then((all) => {
      const total = mean(all, "nodes", "a", "rates", "ok", 40_000) + mean(all, "nodes", "b", "rates", "ok", 40_000)
      expect(total).toBeCloseTo(100, -1)
    })
  })

  it("applies a stage throttle below the account limit", async () => {
    const all = await frames(gateway({ stageThrottle: { rate: 50, burst: 50 } }, { rps: 200 }), 30_000)
    expect(mean(all, "nodes", "web", "rates", "ok", 10_000)).toBeCloseTo(50, -1)
  })

  it("answers 504 when the integration is too slow, while the backend keeps working", () =>
    sim(gateway({ integrationTimeout: "500 millis" }, { rps: 10 }, { duration: { mean: 2_000, cv: 0 }, timeout: "10 seconds" }), (s) =>
      Effect.gen(function*() {
        const all = yield* s.advanceTo(20_000)
        expect(mean(all, "nodes", "web", "rates", "fail.Timeout", 5_000)).toBeGreaterThan(8)
        const fn = (yield* s.probe("fn")).state as { concurrent: number }
        expect(fn.concurrent).toBeGreaterThan(10) // the abandoned invocations are still running
      })))

  it("refuses requests over 10 MB with 413", async () => {
    const all = await frames(gateway({}, { rps: 5, payload: 11 * 1024 }), 5_000)
    expect(mean(all, "nodes", "web", "rates", "fail.Rejected", 1_000)).toBeGreaterThan(3)
  })

  it("an HTTP API waits up to 30 s, a REST API only 29 s", async () => {
    const run = (apiType: string) => frames(gateway({ apiType, integrationTimeout: "30 seconds" }, { rps: 1 }, { duration: { mean: 29_500, cv: 0 }, timeout: "40 seconds" }), 90_000)
    const http = await run("http")
    const rest = await run("rest")
    expect(mean(http, "nodes", "web", "rates", "ok", 40_000)).toBeGreaterThan(0.5)
    expect(mean(rest, "nodes", "web", "rates", "fail.Timeout", 40_000)).toBeGreaterThan(0.5)
  })

  it("reports its backend's failures as a 502, and keeps its own throttling distinct", () =>
    sim(gateway({}, { rps: 20 }), (s) =>
      Effect.gen(function*() {
        yield* s.faults.inject({ kind: "node", id: "fn" }, { _tag: "Outage" })
        const all = yield* s.advanceTo(5_000)
        expect(mean(all, "nodes", "web", "rates", "fail.Failed", 1_000)).toBeGreaterThan(15)
        expect(mean(all, "nodes", "web", "rates", "fail.Throttled", 1_000)).toBe(0)
      })))

  it("has smaller default quotas in the regions where AWS does", () =>
    sim(gateway({}, { rps: 1 }, {}, undefined, "af-south-1"), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(1_000)
        const accounts = (yield* s.inspect).accounts as Record<string, { apiGatewayRate: number }>
        expect(accounts["aws:af-south-1"]!.apiGatewayRate).toBe(2_500)
      })))
})
