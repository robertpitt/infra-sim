import { Duration, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { defaultsOf, fields } from "./Describe.ts"
import * as Setting from "./Setting.ts"

const Config = Schema.Struct({
  workers: Setting.int({ default: 4, min: 1, max: 64, unit: "workers", help: "Handled at once" }),
  mode: Setting.choice(["fast", "safe"], { default: "safe", labels: { fast: "Fast and loose" } }),
  timeout: Setting.duration({ default: "30 seconds", min: "1 second", max: "10 minutes" }),
  latency: Setting.latency({ mean: 20 }),
  rate: Setting.ratio({ default: 0.1 }),
  on: Setting.bool({ default: true })
})

const decode = (input: unknown) => Schema.decodeUnknownSync(Config)(input)

describe("Setting", () => {
  it("fills defaults for anything not given, including nested groups and durations", () => {
    const c = decode({})
    expect(c.workers).toBe(4)
    expect(c.mode).toBe("safe")
    expect(Duration.toMillis(c.timeout)).toBe(30_000)
    expect(Duration.toMillis(c.latency.mean)).toBe(20)
    expect(c.latency.cv).toBe(0.3)
  })

  it("reads durations from milliseconds or from strings, and writes them back as milliseconds", () => {
    expect(Duration.toMillis(decode({ timeout: 5000 }).timeout)).toBe(5000)
    expect(Duration.toMillis(decode({ timeout: "2 minutes" }).timeout)).toBe(120_000)
    expect(Schema.encodeSync(Config)(decode({ timeout: "2 minutes" })).timeout).toBe(120_000)
    expect(Schema.encodeSync(Config)(decode({})).latency).toEqual({ mean: 20, cv: 0.3 })
  })

  it("rejects out-of-range and malformed values with readable reasons", () => {
    expect(() => decode({ workers: 500 })).toThrow(/between 1 and 64/)
    expect(() => decode({ workers: 1.5 })).toThrow(/integer/)
    expect(() => decode({ timeout: 100 })).toThrow(/at least/)
    expect(() => decode({ timeout: "a while" })).toThrow(/duration/)
    expect(() => decode({ mode: "nope" })).toThrow()
  })

  it("ignores keys it doesn't know, so old designs survive a component dropping a setting", () => {
    expect(() => decode({ removedLongAgo: true })).not.toThrow()
  })

  it("round-trips: decode(encode(x)) is x", () => {
    const original = decode({ workers: 9, mode: "fast", timeout: "45 seconds", latency: { mean: 7, cv: 1 } })
    const again = decode(Schema.encodeSync(Config)(original))
    expect(again).toEqual(original)
  })
})

describe("Describe", () => {
  it("derives a form from the schema alone", () => {
    const form = fields(Config)
    expect(form.map((f) => [f.key, f.kind, f.label])).toEqual([
      ["workers", "int", "Workers"],
      ["mode", "choice", "Mode"],
      ["timeout", "duration", "Timeout"],
      ["latency", "group", "Latency"],
      ["rate", "number", "Rate"],
      ["on", "boolean", "On"]
    ])
  })

  it("carries bounds, units, defaults, help and choice labels", () => {
    const form = fields(Config)
    expect(form[0]).toMatchObject({ default: 4, min: 1, max: 64, unit: "workers", help: "Handled at once" })
    expect(form[1]).toMatchObject({
      default: "safe",
      options: [{ value: "fast", label: "Fast and loose" }, { value: "safe", label: "Safe" }]
    })
    expect(form[2]).toMatchObject({ kind: "duration", default: 30_000, min: 1000, max: 600_000, unit: "ms" })
    expect(form[4]).toMatchObject({ default: 0.1, min: 0, max: 1, display: "percent" })
    const latency = form[3]!
    expect(latency.kind === "group" && latency.fields.map((f) => [f.key, f.kind === "duration" ? f.default : "default" in f ? f.default : undefined])).toEqual([
      ["mean", 20],
      ["cv", 0.3]
    ])
  })

  it("gives the same defaults a decode of {} gives", () => {
    expect(defaultsOf(Config).workers).toBe(4)
  })
})
