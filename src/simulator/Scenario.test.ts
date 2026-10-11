import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "./Builder.ts"
import type * as Design from "./Design.ts"
import { layer } from "./components/registry.ts"
import { check, merge, parseAssertion, parseDuration, parseFault, run, type Scenario, ScenarioError } from "./Scenario.ts"

const base = (): Design.Doc => {
  const b = Builder.make("pipeline", { seed: 3 })
  const web = b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 50 } })
  const api = b.add("aws.apigateway", { id: "api", settings: { apiType: "http" } })
  const fn = b.add("aws.lambda", { id: "fn", settings: { memory: 1769, duration: { mean: 20, cv: 0 } } })
  b.connect(web, api)
  b.connect(api, fn)
  return b.build()
}
const play = (scenario: Partial<Scenario>, doc: Design.Doc = base(), options = {}) =>
  Effect.runPromise(run(doc, { version: 1, duration: "20s", warmup: "5s", ...scenario } as Scenario, options).pipe(Effect.provide(layer)))

describe("durations", () => {
  it("reads units, combinations and words, and treats a bare number as seconds", () => {
    expect(parseDuration("250ms")).toBe(250)
    expect(parseDuration("90s")).toBe(90_000)
    expect(parseDuration("2m")).toBe(120_000)
    expect(parseDuration("1h30m")).toBe(5_400_000)
    expect(parseDuration("2 minutes")).toBe(120_000)
    expect(parseDuration(30)).toBe(30_000)
    expect(parseDuration("45")).toBe(45_000)
    expect(parseDuration("soon")).toBeUndefined()
    expect(parseDuration("")).toBeUndefined()
    expect(parseDuration(-1)).toBeUndefined()
  })
})

describe("assertions", () => {
  it("reads a subject, a metric, an aggregate, a comparison and a unit", () => {
    expect(parseAssertion("api.errorRatio < 1%")).toMatchObject({ subject: { scope: "node", id: "api" }, metric: { kind: "errorRatio" }, op: "<", value: 0.01 })
    expect(parseAssertion("system.latency.p99 <= 800ms")).toMatchObject({ subject: { scope: "system" }, metric: { kind: "dist", name: "latency", stat: "p99" }, value: 800 })
    expect(parseAssertion("q.gauge.depth:max < 5000")).toMatchObject({ metric: { kind: "gauge", name: "depth" }, agg: "max", value: 5000 })
    expect(parseAssertion("fn.rate.fail.Throttled == 0")).toMatchObject({ metric: { kind: "rate", name: "fail.Throttled" }, op: "==" })
    expect(parseAssertion("edge:web.out->api.rate.fail < 5/s @ 4m..6m")).toMatchObject({ subject: { scope: "edge", id: "web.out->api" }, value: 5, from: 240_000, to: 360_000 })
    expect(parseAssertion("x.latency.p99 > 2s")).toMatchObject({ value: 2000 })
  })

  it("says what is wrong with one it can't read", () => {
    expect(parseAssertion("api is fine")).toEqual(expect.stringContaining("no comparison"))
    expect(parseAssertion("api.errorRatio < lots")).toEqual(expect.stringContaining("can't read the value"))
    expect(parseAssertion("api.nonsense < 1")).toEqual(expect.stringContaining("expected <subject>.<metric>"))
    expect(parseAssertion("api.latency < 1")).toEqual(expect.stringContaining("statistic"))
  })
})

describe("faults and settings written in a scenario", () => {
  it("reads the short and the object forms of a fault", () => {
    expect(parseFault("Outage")).toEqual({ _tag: "Outage" })
    expect(parseFault("slow(250ms)")).toEqual({ _tag: "Slow", extra: 250 })
    expect(parseFault({ type: "Slow", extra: "2s" })).toEqual({ _tag: "Slow", extra: 2000 })
    expect(parseFault("Errors(20%)")).toEqual({ _tag: "Errors", rate: 0.2 })
    expect(parseFault({ type: "Loss", rate: "10%" })).toEqual({ _tag: "Loss", rate: 0.1 })
    expect(parseFault("Meltdown")).toEqual(expect.stringContaining("no fault called"))
  })

  it("merges settings deeply", () => {
    expect(merge({ a: { x: 1, y: 2 }, b: 1 }, { a: { y: 3 }, c: 4 })).toEqual({ a: { x: 1, y: 3 }, b: 1, c: 4 })
  })
})

describe("checking a scenario against a design", () => {
  const issues = (s: Partial<Scenario>) => check(base(), { version: 1, duration: "20s", ...s } as Scenario)

  it("lists every problem at once", () => {
    const found = issues({
      duration: "forever",
      overrides: { nodes: { ghost: {} } },
      timeline: [{ at: "5s", inject: { target: "node:nope", fault: "Outage" } }, { at: "1m" }],
      assert: ["nobody.errorRatio < 1%", "api.what < 1"]
    })
    expect(found.join("\n")).toMatch(/duration/)
    expect(found.join("\n")).toMatch(/no node "ghost"/)
    expect(found.join("\n")).toMatch(/no node "nope"/)
    expect(found.join("\n")).toMatch(/needs one of inject, clear, set, account/)
    expect(found.join("\n")).toMatch(/no node "nobody"/)
    expect(found.join("\n")).toMatch(/expected <subject>.<metric>|unknown metric/)
  })

  it("lets an event with only a note annotate the timeline, but not do two things at once", () => {
    expect(issues({ timeline: [{ at: "5s", note: "traffic peaks about now" }] })).toEqual([])
    expect(issues({ timeline: [{ at: "5s", clear: "all", set: { node: "web", settings: {} } }] }).join("\n")).toMatch(/more than one thing/)
  })

  it("accepts a sound one", () => {
    expect(issues({ timeline: [{ at: "5s", inject: { target: "node:fn", fault: "Outage", for: "3s" } }], assert: ["api.errorRatio < 1%"] })).toEqual([])
  })

  it("refuses to run an unsound one, with the same list", async () => {
    await expect(play({ overrides: { nodes: { ghost: {} } } })).rejects.toBeInstanceOf(ScenarioError)
  })
})

describe("running a scenario", () => {
  it("summarises the system and every node after the warm-up", async () => {
    const result = await play({ assert: ["system.errorRatio < 1%", "api.rate.in > 40", "fn.rate.ok > 40", "system.latency.p99 < 200ms"] })
    expect(result.passed).toBe(true)
    expect(result.system.rates.ok).toBeGreaterThan(45)
    expect(result.nodes.fn?.type).toBe("aws.lambda")
    expect(result.nodes.api?.rates.in).toBeGreaterThan(45)
    expect(Object.keys(result.edges)).toHaveLength(2)
    expect(result.assertions.every((a) => a.passed)).toBe(true)
    expect(result.wallMs).toBeGreaterThanOrEqual(0)
  })

  it("is deterministic: the same design and seed give the same result", async () => {
    const strip = (r: Awaited<ReturnType<typeof play>>) => ({ ...r, wallMs: 0 })
    expect(strip(await play({ seed: 9 }))).toEqual(strip(await play({ seed: 9 })))
  })

  it("scales traffic, and applies starting overrides over the design's settings", async () => {
    const doubled = await play({ traffic: { scale: 2 } })
    expect(doubled.system.rates.sent).toBeGreaterThan(95)
    const slowed = await play({ overrides: { nodes: { fn: { duration: { mean: 400, cv: 0 } } } } })
    expect(slowed.system.dist.latency!.p50).toBeGreaterThan(400)
  })

  it("injects a fault at a time and lifts it, and the assertions see only their window", async () => {
    const result = await play({
      duration: "30s",
      warmup: "5s",
      timeline: [{ at: "10s", inject: { target: "node:fn", fault: "Outage", for: "10s" } }],
      assert: [
        { check: "system.errorRatio > 0.9", from: "11s", to: "19s", name: "down while the fault lasts" },
        { check: "system.errorRatio == 0", from: "22s", to: "30s", name: "recovered after" },
        "system.errorRatio > 0.1"
      ]
    })
    expect(result.assertions.map((a) => a.passed)).toEqual([true, true, true])
    expect(result.faults).toEqual([{ id: expect.any(String), target: "node:fn", fault: "Outage", from: 10_000, to: 20_000 }])
    expect(result.timeline[0]).toMatchObject({ at: 10_000 })
  })

  it("can clear a fault by name, and all faults", async () => {
    const result = await play({
      duration: "30s",
      timeline: [
        { at: "8s", inject: { target: "node:fn", fault: "Outage", id: "bad" } },
        { at: "15s", clear: "bad" },
        { at: "16s", inject: { target: "node:api", fault: "Slow(100ms)" } },
        { at: "20s", clear: "all" }
      ],
      assert: [{ check: "system.errorRatio == 0", from: "21s" }]
    })
    expect(result.faults.map((f) => [f.fault, f.from, f.to])).toEqual([["Outage", 8000, 15000], ["Slow", 16000, 20000]])
    expect(result.assertions[0]!.passed).toBe(true)
  })

  it("changes settings while running, merged over what the node already has, and merges quotas too", async () => {
    const result = await play({
      duration: "30s",
      timeline: [{ at: "10s", set: { node: "web", settings: { rps: 200 } } }],
      assert: [
        { check: "web.rate.sent < 60", from: "6s", to: "10s" },
        { check: "web.rate.sent > 150", from: "12s", to: "30s" }
      ]
    })
    expect(result.assertions.map((a) => a.passed)).toEqual([true, true])
    const quota = await play({
      duration: "30s",
      doc: undefined,
      timeline: [{ at: "5s", account: { placement: "aws:us-east-1", settings: { lambdaConcurrency: 10 } } }],
      traffic: { scale: 4 },
      overrides: { nodes: { fn: { duration: { mean: 500, cv: 0 } } } },
      assert: [{ check: "fn.rate.fail.Throttled > 0", from: "10s" }]
    } as Partial<Scenario>)
    expect(quota.assertions[0]!.passed).toBe(true)
  })

  it("fails a scenario whose assertion fails, saying what was measured", async () => {
    const result = await play({ assert: ["system.latency.p50 < 1ms"] })
    expect(result.passed).toBe(false)
    expect(result.assertions[0]).toMatchObject({ passed: false, expected: { op: "<", value: 1 } })
    expect(result.assertions[0]!.actual).toBeGreaterThan(1)
  })

  it("keeps the frames when asked", async () => {
    const result = await play({}, base(), { keepFrames: true })
    expect(result.frames!.length).toBeGreaterThan(50)
  })
})
