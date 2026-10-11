import { describe, expect, it } from "vitest"
import * as Builder from "../Builder.ts"
import { frames, mean } from "../components/testing.ts"

const endpoint = (settings: Record<string, unknown>, load: Record<string, unknown>) => {
  const b = Builder.make("ext", { seed: 1 })
  b.connect(b.add("common.client", { id: "web", settings: { arrival: "constant", ...load } }), b.add("common.http-endpoint", { id: "ext", settings: { latency: { mean: 50, cv: 0 }, ...settings } }))
  return b.build()
}

describe("common.http-endpoint", () => {
  it("answers with its own latency", async () => {
    const all = await frames(endpoint({ latency: { mean: 300, cv: 0 } }, { rps: 10 }), 20_000)
    const p50 = all.slice(20).reduce((s, f) => s + (f.nodes.web?.dist.latency?.p50 ?? 0), 0) / 60
    expect(p50).toBeGreaterThan(300)
    expect(p50).toBeLessThan(330)
  })

  it("pushes back with 429 above its rate limit", async () => {
    const all = await frames(endpoint({ rateLimit: 50 }, { rps: 100 }), 30_000)
    expect(mean(all, "nodes", "web", "rates", "ok", 10_000)).toBeCloseTo(50, -1)
    expect(mean(all, "nodes", "web", "rates", "fail.Throttled", 10_000)).toBeGreaterThan(45)
  })

  it("answers 503 above its concurrency", async () => {
    const all = await frames(endpoint({ latency: { mean: 1_000, cv: 0 }, maxConcurrency: 5 }, { rps: 20 }), 30_000)
    expect(mean(all, "nodes", "web", "rates", "ok", 10_000)).toBeCloseTo(5, 0)
    expect(mean(all, "nodes", "web", "rates", "fail.Unavailable", 10_000)).toBeGreaterThan(12)
  })

  it("fails a fraction of requests with 5xx", async () => {
    const all = await frames(endpoint({ errorRate: 0.3 }, { rps: 100 }), 30_000)
    const failed = mean(all, "nodes", "web", "rates", "fail.Failed", 5_000)
    expect(failed).toBeGreaterThan(24)
    expect(failed).toBeLessThan(36)
  })

  it("refuses requests over its size limit", async () => {
    const all = await frames(endpoint({ maxPayload: 10 }, { rps: 10, payload: 20 }), 5_000)
    expect(mean(all, "nodes", "web", "rates", "fail.Rejected", 1_000)).toBeGreaterThan(8)
  })
})
