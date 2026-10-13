import { describe, expect, it } from "vitest"
import { type Expression, nextCron, parse, parseDateTime } from "../expression.ts"

const at = (text: string): number => parseDateTime(text)!
const iso = (ms: number | undefined): string | undefined => (ms === undefined ? undefined : new Date(ms).toISOString().slice(0, 16))
const cron = (text: string) => {
  const parsed = parse(text) as Expression
  if (typeof parsed === "string" || parsed.kind !== "cron") throw new Error(`not a cron: ${String(parsed)}`)
  return parsed.cron
}
const next = (expression: string, from: string) => iso(nextCron(cron(expression), at(from)))

describe("schedule expressions", () => {
  it("reads rate expressions in minutes, hours and days", () => {
    expect(parse("rate(5 minutes)")).toEqual({ kind: "rate", periodMs: 300_000 })
    expect(parse("rate(1 minute)")).toEqual({ kind: "rate", periodMs: 60_000 })
    expect(parse("rate(2 hours)")).toEqual({ kind: "rate", periodMs: 7_200_000 })
    expect(parse("rate(1 day)")).toEqual({ kind: "rate", periodMs: 86_400_000 })
    expect(parse("rate(0 minutes)")).toBeTypeOf("string")
    expect(parse("rate(30 seconds)")).toBeTypeOf("string")
    expect(parse("every 5 minutes")).toBeTypeOf("string")
  })

  it("reads one-time at expressions", () => {
    expect(parse("at(2026-01-06T00:00:00)")).toEqual({ kind: "at", atMs: Date.UTC(2026, 0, 6) })
    expect(parse("at(2026-02-30T00:00:00)")).toBeTypeOf("string")
  })

  it("finds the next minute a cron names", () => {
    expect(next("cron(0 0 * * ? *)", "2026-01-05T23:55")).toBe("2026-01-06T00:00")
    expect(next("cron(0 0 * * ? *)", "2026-01-06T00:00")).toBe("2026-01-06T00:00")
    expect(next("cron(0/15 * * * ? *)", "2026-01-05T10:07")).toBe("2026-01-05T10:15")
    expect(next("cron(*/5 9-17 * * ? *)", "2026-01-05T17:56")).toBe("2026-01-06T09:00")
    expect(next("cron(30 8 1,15 * ? *)", "2026-01-02T00:00")).toBe("2026-01-15T08:30")
    expect(next("cron(0 0 1 JAN-MAR ? *)", "2026-04-01T00:01")).toBe("2027-01-01T00:00")
  })

  it("reads days of the week, 1 being Sunday", () => {
    // 2026-01-10 is a Saturday.
    expect(next("cron(0 9 ? * MON-FRI *)", "2026-01-10T08:00")).toBe("2026-01-12T09:00")
    expect(next("cron(0 9 ? * 2-6 *)", "2026-01-10T08:00")).toBe("2026-01-12T09:00")
    expect(next("cron(0 9 ? * 1 *)", "2026-01-10T08:00")).toBe("2026-01-11T09:00")
  })

  it("supports L, W and #", () => {
    expect(next("cron(15 10 ? * 6L 2026)", "2026-01-01T00:00")).toBe("2026-01-30T10:15") // the last Friday
    expect(next("cron(0 12 ? * 3#2 *)", "2026-01-01T00:00")).toBe("2026-01-13T12:00") // the second Tuesday
    expect(next("cron(0 0 L * ? *)", "2026-01-05T00:00")).toBe("2026-01-31T00:00")
    expect(next("cron(0 0 L * ? *)", "2028-02-02T00:00")).toBe("2028-02-29T00:00")
    expect(next("cron(0 0 15W * ? *)", "2026-02-01T00:00")).toBe("2026-02-16T00:00") // the 15th is a Sunday
    expect(next("cron(0 0 1W * ? *)", "2026-08-01T00:00")).toBe("2026-08-03T00:00") // the 1st is a Saturday
    expect(next("cron(0 0 LW * ? *)", "2026-01-05T00:00")).toBe("2026-01-30T00:00") // the 31st is a Saturday
  })

  it("never comes due when the years have passed", () => {
    expect(next("cron(0 0 * * ? 2020-2022)", "2026-01-01T00:00")).toBeUndefined()
  })

  it("says what is wrong with an expression it can't read", () => {
    expect(parse("cron(0 0 * * * *)")).toMatch(/\?/)
    expect(parse("cron(0 0 ? * ? *)")).toMatch(/\?/)
    expect(parse("cron(60 0 * * ? *)")).toMatch(/Minutes/)
    expect(parse("cron(0 0 * * ?)")).toMatch(/six fields/)
    expect(parse("cron(0 0 ? * 8 *)")).toMatch(/Day-of-week/)
    expect(parse("cron(0 0 ? FOO * *)")).toMatch(/Month/)
  })

  it("reads the clock with or without a Z", () => {
    expect(parseDateTime("2026-01-05T23:55:00")).toBe(Date.UTC(2026, 0, 5, 23, 55))
    expect(parseDateTime("2026-01-05T23:55Z")).toBe(Date.UTC(2026, 0, 5, 23, 55))
    expect(parseDateTime("23:55")).toBeUndefined()
  })
})
