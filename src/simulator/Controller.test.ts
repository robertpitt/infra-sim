import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "./Builder.ts"
import { mean, sim } from "./components/testing.ts"
import { registry } from "./components/registry.ts"
import { desired, read } from "./controllers/TargetTracking.ts"
import * as Design from "./Design.ts"

describe("target tracking: the rule", () => {
  const c = { per: "unit" as const, targetValue: 0.7, tolerance: 0.1, min: 1, max: 100 }

  it("per unit: enough capacity for the total at the target, as Kubernetes computes it", () => {
    expect(desired(c, 2, 2)).toBe(3) // full: 2 in flight on 2 units is 1.0 per unit against 0.7
    expect(desired(c, 10, 10)).toBe(15)
    expect(desired(c, 15, 10)).toBe(15) // 0.67 per unit is within 10% of 0.7: no change
    expect(desired(c, 40, 10)).toBe(15) // far too much: back down
  })

  it("in total: the setting moves in proportion to how far the metric is from the target", () => {
    const total = { ...c, per: "total" as const, targetValue: 200 }
    expect(desired(total, 4, 400)).toBe(8)
    expect(desired(total, 4, 100)).toBe(2)
    expect(desired(total, 4, 210)).toBe(4) // within tolerance
  })

  it("stays within the minimum and maximum", () => {
    expect(desired({ ...c, max: 5 }, 2, 100)).toBe(5)
    expect(desired({ ...c, min: 3 }, 10, 0)).toBe(3)
  })

  it("reads gauges, rates and percentiles from a frame", () => {
    const stats = { rates: { in: 12 }, gauges: { inflight: 3 }, dist: { latency: { n: 10, mean: 5, p50: 4, p95: 9, p99: 11, max: 12 } } }
    expect(read(stats, "inflight")).toBe(3)
    expect(read(stats, "in")).toBe(12)
    expect(read(stats, "latency.p95")).toBe(9)
    expect(read(stats, "nothing")).toBeUndefined()
    expect(read(undefined, "inflight")).toBeUndefined()
  })
})

/** clients -> an endpoint that answers 503 beyond its concurrency, which an autoscaler resizes. */
const scaled = (settings: Record<string, unknown> = {}, endpoint: Record<string, unknown> = {}) => {
  const b = Builder.make("scaled", { seed: 3 })
  const web = b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 100 } })
  const api = b.add("common.http-endpoint", { id: "api", settings: { latency: { mean: 100, cv: 0 }, maxConcurrency: 2, ...endpoint } })
  b.connect(web, api)
  b.control("core.target-tracking", api, {
    metric: "inflight",
    targetValue: 0.7,
    setting: "maxConcurrency",
    min: 1,
    max: 50,
    window: "10 seconds",
    period: "5 seconds",
    scaleOutCooldown: 0,
    scaleInCooldown: "30 seconds",
    ...settings
  }, { id: "autoscaler" })
  return b.build()
}

describe("controllers in a design", () => {
  const codes = (doc: Design.Doc) => Design.resolve(doc, registry).diagnostics.filter((d) => d.level === "error").map((d) => d.code)

  it("are attached to a node, and written back with their settings", () => {
    const design = Design.resolve(scaled(), registry).design!
    const c = design.controllers.get("autoscaler")!
    expect(c.target).toBe("api")
    expect(c.def.type).toBe("core.target-tracking")
    const doc = Design.encode(design, registry)
    expect(doc.controllers?.autoscaler).toMatchObject({ type: "core.target-tracking", target: "api", settings: { setting: "maxConcurrency", max: 50 } })
  })

  it("report an unknown type, a missing target, and settings that make no sense on the target", () => {
    const base = scaled()
    const at = (patch: Record<string, unknown>) => ({ ...base, controllers: { autoscaler: { ...base.controllers!.autoscaler!, ...patch } } })
    expect(codes(at({ type: "core.nope" }))).toEqual(["unknown-controller"])
    expect(codes(at({ target: "ghost" }))).toEqual(["controller-target"])
    expect(codes(at({ settings: { setting: "nothingLikeThis" } }))).toEqual(["bad-controller-settings"])
    expect(codes(at({ settings: { setting: "latency" } }))).toEqual(["bad-controller-settings"]) // a group, not a number
    expect(codes(at({ settings: { setting: "maxConcurrency", min: 10, max: 2 } }))).toEqual(["bad-controller-settings"])
    const { diagnostics } = Design.resolve(at({ settings: { setting: "nothingLikeThis" } }), registry)
    expect(diagnostics[0]!.controller).toBe("autoscaler")
    expect(diagnostics[0]!.message).toMatch(/no setting "nothingLikeThis"/)
  })

  it("warn, without stopping the design, while they aren't told what to change yet", () => {
    const base = scaled()
    const fresh = { ...base, controllers: { autoscaler: { type: "core.target-tracking", target: "api" } } }
    const { design, diagnostics } = Design.resolve(fresh, registry)
    expect(design).toBeDefined()
    expect(diagnostics.map((d) => [d.level, d.code])).toEqual([["warning", "controller-incomplete"]])
  })

  it("go when their node does", () => {
    const doc = Design.removeNode(scaled(), "api")
    expect(doc.controllers).toBeUndefined()
  })
})

describe("a running target-tracking controller", () => {
  it("raises an endpoint's concurrency until the load fits, through the same door an edit uses", () =>
    sim(scaled(), (s) =>
      Effect.gen(function*() {
        const all = yield* s.advanceTo(120_000)
        // 100 requests a second at 100 ms is 10 in flight; at 0.7 a unit that is 15.
        const api = (yield* s.inspect).nodes.api!.config as { maxConcurrency: number }
        expect(api.maxConcurrency).toBeGreaterThanOrEqual(13)
        expect(api.maxConcurrency).toBeLessThanOrEqual(20)
        // Early on most calls are refused; once it has scaled, none are.
        expect(mean(all, "nodes", "api", "rates", "fail", 0, 5_000)).toBeGreaterThan(50)
        expect(mean(all, "nodes", "api", "rates", "fail", 90_000)).toBe(0)
        const probe = yield* s.probeController("autoscaler")
        const state = probe.state as { current: number; decisions: ReadonlyArray<{ from: number; to: number }> }
        expect(state.current).toBe(api.maxConcurrency)
        expect(state.decisions[0]).toMatchObject({ from: 2 })
        expect(state.decisions.at(-1)!.to).toBe(api.maxConcurrency)
        expect(probe.log).toEqual([])
        // Its own metrics arrive in frames.
        expect(all.at(-1)!.controllers.autoscaler!.gauges.current).toBe(api.maxConcurrency)
      })))

  it("is deterministic: the same design and seed make the same decisions", async () => {
    const decisions = () => sim(scaled(), (s) => Effect.flatMap(s.advanceTo(60_000), () => Effect.map(s.probeController("autoscaler"), (p) => p.state)))
    expect(await decisions()).toEqual(await decisions())
  })

  it("says so, and changes nothing, when its target doesn't report the metric", () =>
    sim(scaled({ metric: "nonsense" }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(60_000)
        const probe = yield* s.probeController("autoscaler")
        expect(probe.log.map((l) => l.text)).toEqual([expect.stringMatching(/no metric called "nonsense"/)])
        expect(((yield* s.inspect).nodes.api!.config as { maxConcurrency: number }).maxConcurrency).toBe(2)
      })))

  it("takes a live change to its settings", () =>
    sim(scaled(), (s) =>
      Effect.gen(function*() {
        yield* s.configureController("autoscaler", { metric: "inflight", setting: "maxConcurrency", targetValue: 0.7, min: 1, max: 6, period: "5 seconds", window: "10 seconds", scaleOutCooldown: 0 })
        yield* s.advanceTo(60_000)
        expect(((yield* s.inspect).nodes.api!.config as { maxConcurrency: number }).maxConcurrency).toBe(6)
      })))

  it("drives any component's number: a Lambda function's provisioned concurrency, as Application Auto Scaling does", () => {
    const b = Builder.make("provisioned", { seed: 9 })
    const web = b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 50 } })
    // A whole vCPU, so the handler takes the 200 ms it says (at 128 MB it would be stretched about seven times).
    const fn = b.add("aws.lambda", { id: "fn", settings: { memory: 1769, duration: { mean: 200, cv: 0 }, fanOut: "none" } })
    b.connect(web, fn)
    b.control("core.target-tracking", fn, { metric: "concurrent", targetValue: 0.7, setting: "provisioned", min: 0, max: 100, period: "30 seconds" }, { id: "pc" })
    return sim(b.build(), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(5 * 60_000)
        // About 10 run at once, so provisioned concurrency settles near 10 / 0.7.
        const probe = (yield* s.probeController("pc")).state as { current: number }
        expect(probe.current).toBeGreaterThanOrEqual(12)
        expect(probe.current).toBeLessThanOrEqual(18)
        expect(((yield* s.probe("fn")).state as { provisioned: number }).provisioned).toBeGreaterThan(0)
      }))
  })
})
