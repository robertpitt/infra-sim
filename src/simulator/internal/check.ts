/**
 * The parsers of the check language (`Check.ts`): durations, values with units, metrics and whole assertions, read by
 * hand from the text people write in scenarios and alarm rules.
 */
import type { Aggregate, Assertion, Metric, Op } from "../Check.ts"

/** Milliseconds in each unit a duration may be written in. */
const UNITS: Readonly<Record<string, number>> = {
  ms: 1, millis: 1, millisecond: 1, milliseconds: 1,
  s: 1_000, sec: 1_000, secs: 1_000, second: 1_000, seconds: 1_000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000
}

/** A duration in milliseconds (`Check.parseDuration`). */
export const parseDuration = (input: unknown): number | undefined => {
  if (typeof input === "number") return Number.isFinite(input) && input >= 0 ? input * 1000 : undefined
  if (typeof input !== "string") return undefined
  const text = input.trim().toLowerCase()
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text) * 1000
  let total = 0
  let rest = text
  while (rest.length > 0) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)\s*/.exec(rest)
    if (m === null || UNITS[m[2]!] === undefined) return undefined
    total += Number(m[1]) * UNITS[m[2]!]!
    rest = rest.slice(m[0].length)
  }
  return text.length === 0 ? undefined : total
}

const OPS: ReadonlyArray<Op> = ["<=", ">=", "==", "!=", "<", ">"]

/** Parse an assertion written as text (`Check.parseAssertion`). */
export const parseAssertion = (text: string, extra: { readonly name?: string; readonly from?: number; readonly to?: number } = {}): Assertion | string => {
  let body = text.trim()
  let from = extra.from
  let to = extra.to
  const window = /\s@\s*([^\s.]+(?:\s*[a-z]+)?)\s*\.\.\s*([^\s]+(?:\s*[a-z]+)?)\s*$/i.exec(body)
  if (window !== null) {
    const a = parseDuration(window[1])
    const b = parseDuration(window[2])
    if (a === undefined || b === undefined) return `"${text}": can't read the window ${window[1]}..${window[2]}`
    from = a
    to = b
    body = body.slice(0, window.index).trim()
  }
  const op = OPS.find((o) => body.includes(` ${o} `) || body.includes(o))
  if (op === undefined) return `"${text}": no comparison (use one of ${OPS.join(" ")})`
  const at = body.indexOf(` ${op} `) >= 0 ? body.indexOf(` ${op} `) + 1 : body.indexOf(op)
  const left = body.slice(0, at).trim()
  const right = body.slice(at + op.length).trim()
  const value = parseValue(right)
  if (value === undefined) return `"${text}": can't read the value "${right}" (a number, with an optional unit: 500ms, 2s, 1.5%, 10/s)`

  const m = /^(?<subject>edge:\S+?|\S+?)\.(?<metric>(?:errorRatio|successRatio|throughput|rate|total|gauge|latency|dist)\S*?)(?::(?<agg>mean|max|min|last|sum))?$/.exec(left)
  if (m?.groups === undefined) return `"${text}": expected <subject>.<metric>, e.g. api.errorRatio or orders-queue.gauge.depth:max`
  const { subject, metric, agg } = m.groups as { subject: string; metric: string; agg: Aggregate | undefined }
  const parsed = parseMetric(metric)
  if (typeof parsed === "string") return `"${text}": ${parsed}`
  const scope = subject === "system" ? "system" : subject.startsWith("edge:") ? "edge" : "node"
  return {
    text,
    name: extra.name,
    subject: { scope, id: scope === "edge" ? subject.slice(5) : subject },
    metric: parsed,
    agg,
    op,
    value,
    from,
    to
  }
}

/** A number with an optional unit (`500ms`, `2s`, `1.5%`, `10/s`), in milliseconds, a fraction or per second. */
export const parseValue = (text: string): number | undefined => {
  const m = /^(-?\d+(?:\.\d+)?)\s*(%|ms|s|m|h|\/s|)$/.exec(text.trim())
  if (m === null) return undefined
  const n = Number(m[1])
  switch (m[2]) {
    case "%": return n / 100
    case "ms": return n
    case "s": return n * 1000
    case "m": return n * 60_000
    case "h": return n * 3_600_000
    default: return n
  }
}

const parseMetric = (text: string): Metric | string => {
  const [head, ...rest] = text.split(".")
  const name = rest.join(".")
  switch (head) {
    case "errorRatio": return { kind: "errorRatio" }
    case "successRatio": return { kind: "successRatio" }
    case "throughput": return { kind: "throughput" }
    case "rate":
    case "total":
    case "gauge":
      return name === "" ? `${head} needs a name, like ${head}.ok` : { kind: head, name }
    case "latency": {
      const stat = name
      return ["mean", "p50", "p95", "p99", "max"].includes(stat) ? { kind: "dist", name: "latency", stat: stat as "mean" } : "latency needs a statistic: p50, p95, p99, mean or max"
    }
    case "dist": {
      const stat = rest[rest.length - 1]
      const dist = rest.slice(0, -1).join(".")
      return dist !== "" && ["mean", "p50", "p95", "p99", "max"].includes(stat ?? "") ? { kind: "dist", name: dist, stat: stat as "mean" } : "dist needs a name and a statistic, like dist.age.p95"
    }
    default:
      return `unknown metric "${text}"`
  }
}
