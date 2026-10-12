import { describe, expect, it } from "vitest"
import { monitor, rules } from "./Alarm.ts"
import type * as Design from "./Design.ts"
import type { Frame, Stats } from "./Telemetry.ts"

const design: Design.Doc = {
  version: 1,
  nodes: {
    web: { type: "common.client" },
    api: { type: "aws.lambda" },
    queue: { type: "aws.sqs" },
    region: { type: "aws.region" }
  },
  edges: {}
}
const registry = {
  get: (type: string) =>
    type === "common.client" ? { inputs: false } : type === "aws.region" ? { inputs: false, container: {} } : { inputs: true }
}

/** Frames of 250 ms from `from` to `to` seconds, with the rates and gauges `stats` gives each node at that second. */
const frames = (from: number, to: number, stats: (s: number) => Record<string, { rates?: Record<string, number>; gauges?: Record<string, number> }>): Array<Frame> => {
  const out: Array<Frame> = []
  for (let t = from * 1000 + 250; t <= to * 1000; t += 250) {
    const nodes: Record<string, Stats> = {}
    for (const [id, s] of Object.entries(stats(t / 1000))) nodes[id] = { rates: s.rates ?? {}, gauges: s.gauges ?? {}, dist: {} }
    out.push({ t, dt: 250, nodes, edges: {}, controllers: {} })
  }
  return out
}

const healthy = () => ({ web: { rates: { sent: 100, ok: 100 } }, api: { rates: { in: 100, ok: 100 } } })
const failing = () => ({ web: { rates: { sent: 100, ok: 50, fail: 50 } }, api: { rates: { in: 100, ok: 50, fail: 50, "fail.Throttled": 50 } } })

describe("Alarm", () => {
  it("parses every standard rule", () => {
    expect(rules.length).toBeGreaterThan(5)
    expect(() => monitor(design, registry)).not.toThrow()
  })

  it("stays quiet on a healthy run", () => {
    const m = monitor(design, registry)
    expect(m.observe(frames(0, 120, healthy))).toBe(false)
    expect(m.alerts()).toEqual([])
  })

  it("fires once a rule has breached for its periods, and resolves after three calm ones", () => {
    const m = monitor(design, registry)
    m.observe(frames(0, 30, healthy))
    // One bad period isn't enough for the error rule (it wants two in a row).
    m.observe(frames(30, 40, failing))
    m.observe(frames(40, 41, failing))
    expect(m.alerts().filter((a) => a.rule === "errors")).toEqual([])
    m.observe(frames(41, 60, failing))
    const firing = m.alerts()
    const errors = firing.filter((a) => a.rule === "errors")
    expect(errors.map((a) => a.target.id).sort()).toEqual(["api", "web"])
    // What the clients see is what users see: that one pages.
    expect(errors.find((a) => a.target.id === "web")).toMatchObject({ severity: "critical", title: "Clients are seeing errors", firedAt: 50_000, check: "web.errorRatio > 5%", unit: "ratio" })
    expect(errors.find((a) => a.target.id === "api")).toMatchObject({ severity: "warning", value: 0.5, peak: 0.5 })
    expect(firing.some((a) => a.rule === "throttled" && a.target.id === "api")).toBe(true)
    // Critical first.
    expect(firing[0]!.severity).toBe("critical")
    expect(firing.every((a) => a.resolvedAt === undefined)).toBe(true)

    m.observe(frames(60, 100, healthy))
    const after = m.alerts()
    expect(after.every((a) => a.resolvedAt !== undefined)).toBe(true)
    expect(after.find((a) => a.rule === "errors" && a.target.id === "web")).toMatchObject({ resolvedAt: 90_000 })
  })

  it("leaves out the rules a component says don't fit it, and only those", () => {
    // A firewall: its 403s are its job. Its other alarms still apply.
    const quiet = { get: (type: string) => (type === "aws.lambda" ? { inputs: true, quietAlarms: ["errors"] } : registry.get(type)) }
    const m = monitor(design, quiet)
    m.observe(frames(0, 60, failing))
    const fired = m.alerts()
    expect(fired.filter((a) => a.rule === "errors").map((a) => a.target.id)).toEqual(["web"])
    expect(fired.some((a) => a.rule === "throttled" && a.target.id === "api")).toBe(true)
  })

  it("applies a rule only where its metric exists, and never to a container", () => {
    const m = monitor(design, registry)
    m.observe(frames(0, 30, () => ({ queue: { gauges: { oldestAgeMs: 120_000 } }, region: { gauges: { oldestAgeMs: 120_000 } } })))
    expect(m.alerts().map((a) => `${a.rule}:${a.target.id}`)).toEqual(["backlog:queue"])
  })

  it("counts a later firing of the same alarm as a new alert", () => {
    const m = monitor(design, registry)
    m.observe(frames(0, 30, failing))
    m.observe(frames(30, 80, healthy))
    m.observe(frames(80, 110, failing))
    const web = m.alerts().filter((a) => a.rule === "errors" && a.target.id === "web")
    expect(web).toHaveLength(2)
    expect(new Set(web.map((a) => a.id)).size).toBe(2)
    expect(web[0]!.resolvedAt).toBeUndefined()
  })
})
