import type * as Design from "./Design.ts"
import type { Frame, Stats } from "./Telemetry.ts"

/**
 * Checks: the small language scenarios assert with and alarms watch with.
 *
 *   api.errorRatio < 1%
 *   orders-queue.gauge.depth:max < 5000
 *   edge:web.out->api.rate.fail < 5/s @ 4m..6m
 *
 * A check names a subject (a node, an edge, or `system`: every client together), a metric, how to combine the frames
 * of a window, and a comparison. `measure` reads it off telemetry frames, so the same check means the same thing in a
 * scenario's verdict, an alarm in the browser, and a CI job.
 */

// ---------------------------------------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------------------------------------

const UNITS: Readonly<Record<string, number>> = {
  ms: 1, millis: 1, millisecond: 1, milliseconds: 1,
  s: 1_000, sec: 1_000, secs: 1_000, second: 1_000, seconds: 1_000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000
}

/**
 * A duration in milliseconds: `"250ms"`, `"90s"`, `"2m"`, `"1h30m"`, `"2 minutes"`. A bare number is **seconds**.
 * `undefined` if it isn't one.
 */
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

// ---------------------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------------------

export type Op = "<" | "<=" | ">" | ">=" | "==" | "!="

export interface Assertion {
  /** The text it was written as. */
  readonly text: string
  readonly name: string | undefined
  readonly subject: { readonly scope: "node" | "edge" | "system"; readonly id: string }
  readonly metric: Metric
  readonly agg: Aggregate | undefined
  readonly op: Op
  readonly value: number
  /** The window in ms from the start of the run, when the assertion sets one. */
  readonly from: number | undefined
  readonly to: number | undefined
}

export type Aggregate = "mean" | "max" | "min" | "last" | "sum"
export type Metric =
  | { readonly kind: "rate"; readonly name: string }
  | { readonly kind: "total"; readonly name: string }
  | { readonly kind: "gauge"; readonly name: string }
  | { readonly kind: "dist"; readonly name: string; readonly stat: "mean" | "p50" | "p95" | "p99" | "max" }
  | { readonly kind: "errorRatio" }
  | { readonly kind: "successRatio" }
  | { readonly kind: "throughput" }

/** What an assertion can say, for help text and for agents writing one. */
export const ASSERTION_SYNTAX = `<subject>.<metric>[:<aggregate>] <op> <value> [@ <from>..<to>]

subject   a node id; edge:<edge id>; or system (every client together)
metric    errorRatio | successRatio | throughput
          rate.<counter>          per-second rate of a counter: rate.ok, rate.fail, rate.fail.Throttled, rate.in, rate.sent
          total.<counter>         how many events in the window
          gauge.<name>            a gauge: gauge.depth, gauge.concurrent, gauge.inflight, gauge.cacheHitRate
          latency.<stat>          p50 | p95 | p99 | mean | max, of the 'latency' distribution (other distributions: dist.<name>.<stat>)
aggregate how to combine the window's frames: mean (default) | max | min | last | sum
op        < <= > >= == !=
value     a number, with optional unit: 500ms, 2s, 1.5%, 10/s
window    @ 2m..3m measures only that stretch (default: after the warm-up, to the end of the run)

examples  api.errorRatio < 1%
          system.latency.p99 < 800ms
          orders-queue.gauge.depth:max < 5000
          fn.rate.fail.Throttled == 0
          edge:web.out->api.rate.fail < 5/s @ 4m..6m`

const OPS: ReadonlyArray<Op> = ["<=", ">=", "==", "!=", "<", ">"]

/** Parse an assertion written as text. Returns the reason it can't be read as a string. */
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

// ---------------------------------------------------------------------------------------------------------
// Measuring frames
// ---------------------------------------------------------------------------------------------------------

export type Scope = "nodes" | "edges"

/** Frames whose window ends in (from, to]. */
export const within = (frames: ReadonlyArray<Frame>, from: number, to: number) => frames.filter((f) => f.t > from && f.t <= to)

export const statsOf = (frame: Frame, scope: Scope, id: string): Stats | undefined => frame[scope][id]

export const combine = (values: ReadonlyArray<number>, agg: Aggregate): number => {
  if (values.length === 0) return 0
  switch (agg) {
    case "max": return Math.max(...values)
    case "min": return Math.min(...values)
    case "last": return values[values.length - 1]!
    case "sum": return values.reduce((a, b) => a + b, 0)
    case "mean": return values.reduce((a, b) => a + b, 0) / values.length
  }
}

/** Events per second of a counter, over the frames. `sum` of rates would be meaningless, so it counts events instead. */
export const rateOver = (frames: ReadonlyArray<Frame>, scope: Scope, id: string, name: string, agg: Aggregate): number =>
  agg === "sum"
    ? frames.reduce((n, f) => n + ((statsOf(f, scope, id)?.rates[name] ?? 0) * f.dt) / 1000, 0)
    : combine(frames.map((f) => statsOf(f, scope, id)?.rates[name] ?? 0), agg)

export const totalOver = (frames: ReadonlyArray<Frame>, scope: Scope, id: string, name: string): number => rateOver(frames, scope, id, name, "sum")

/**
 * A statistic of a distribution over the frames. Percentiles can't be merged exactly from per-frame summaries, so the
 * mean-aggregate is each frame's value weighted by its sample count: a good estimate, not an exact quantile.
 */
const distOver = (frames: ReadonlyArray<Frame>, scope: Scope, id: string, name: string, stat: "mean" | "p50" | "p95" | "p99" | "max", agg: Aggregate): number => {
  const points = frames.flatMap((f) => {
    const d = statsOf(f, scope, id)?.dist[name]
    return d === undefined ? [] : [{ n: d.n, v: d[stat] }]
  })
  if (points.length === 0) return 0
  if (agg === "mean" || agg === "sum") {
    const n = points.reduce((s, p) => s + p.n, 0)
    return n === 0 ? 0 : points.reduce((s, p) => s + p.v * p.n, 0) / n
  }
  return combine(points.map((p) => p.v), agg)
}

const gaugeOver = (frames: ReadonlyArray<Frame>, scope: Scope, id: string, name: string, agg: Aggregate): number =>
  combine(frames.map((f) => statsOf(f, scope, id)?.gauges[name] ?? 0), agg)

/** The clients are the system's edge: what they see is what a user sees. */
export const clientIds = (design: Design.Doc, registry: { readonly get: (type: string) => { readonly inputs: boolean } | undefined }): ReadonlyArray<string> =>
  Object.entries(design.nodes).filter(([, n]) => registry.get(n.type)?.inputs === false).map(([id]) => id)

export interface Subject {
  readonly nodes: ReadonlyArray<string>
  readonly scope: Scope
}

export const measure = (frames: ReadonlyArray<Frame>, subject: Subject, metric: Metric, agg: Aggregate | undefined): number => {
  const { nodes, scope } = subject
  const sumOf = (f: (id: string) => number) => nodes.reduce((n, id) => n + f(id), 0)
  switch (metric.kind) {
    case "rate": {
      const a = agg ?? "mean"
      return a === "mean" || a === "sum" || nodes.length === 1
        ? sumOf((id) => rateOver(frames, scope, id, metric.name, a))
        : combine(frames.map((f) => nodes.reduce((n, id) => n + (statsOf(f, scope, id)?.rates[metric.name] ?? 0), 0)), a)
    }
    case "total":
      return sumOf((id) => totalOver(frames, scope, id, metric.name))
    case "gauge":
      return agg === "sum" || nodes.length === 1
        ? sumOf((id) => gaugeOver(frames, scope, id, metric.name, agg ?? "mean"))
        : combine(frames.map((f) => nodes.reduce((n, id) => n + (statsOf(f, scope, id)?.gauges[metric.name] ?? 0), 0)), agg ?? "mean")
    case "dist": {
      // Several nodes: weight each by its own sample count.
      const parts = nodes.map((id) => ({ id, n: frames.reduce((s, f) => s + (statsOf(f, scope, id)?.dist[metric.name]?.n ?? 0), 0) }))
      const total = parts.reduce((s, p) => s + p.n, 0)
      if (total === 0) return 0
      const stat = metric.stat
      if ((agg ?? "mean") === "max" || stat === "max") return Math.max(...parts.map((p) => distOver(frames, scope, p.id, metric.name, stat, agg ?? "mean")))
      return parts.reduce((s, p) => s + distOver(frames, scope, p.id, metric.name, stat, agg ?? "mean") * p.n, 0) / total
    }
    case "errorRatio":
    case "successRatio": {
      const ok = sumOf((id) => totalOver(frames, scope, id, "ok"))
      const fail = sumOf((id) => totalOver(frames, scope, id, "fail"))
      const ratio = ok + fail === 0 ? 0 : fail / (ok + fail)
      return metric.kind === "errorRatio" ? ratio : ok + fail === 0 ? 0 : 1 - ratio
    }
    case "throughput":
      return sumOf((id) => rateOver(frames, scope, id, "ok", agg ?? "mean"))
  }
}

export const compare = (actual: number, op: Op, expected: number): boolean => {
  // Measured values are floats: treat a difference below rounding noise as equal.
  const eps = 1e-9
  switch (op) {
    case "<": return actual < expected
    case "<=": return actual <= expected + eps
    case ">": return actual > expected
    case ">=": return actual >= expected - eps
    case "==": return Math.abs(actual - expected) <= Math.max(eps, Math.abs(expected) * 1e-6)
    case "!=": return Math.abs(actual - expected) > Math.max(eps, Math.abs(expected) * 1e-6)
  }
}

/** What a check's value is measured in, for showing it. */
export type Unit = "ratio" | "ms" | "count" | "rate" | "number"

export const unitOf = (metric: Metric): Unit => {
  switch (metric.kind) {
    case "errorRatio":
    case "successRatio":
      return "ratio"
    case "throughput":
    case "rate":
      return "rate"
    case "total":
      return "count"
    case "dist":
      return metric.name === "latency" || metric.name === "age" || metric.name.toLowerCase().endsWith("latency") ? "ms" : "number"
    case "gauge":
      return metric.name.endsWith("Ms") || metric.name.endsWith("Age") ? "ms" : /Rate$|^utilization$|Ratio$/.test(metric.name) ? "ratio" : "number"
  }
}

/** The nodes or edges a check reads: `system` is every client. */
export const subjectOf = (assertion: Assertion, clients: ReadonlyArray<string>): Subject => ({
  nodes: assertion.subject.scope === "system" ? clients : [assertion.subject.id],
  scope: assertion.subject.scope === "edge" ? "edges" : "nodes"
})

/** A check's value over `frames`. */
export const evaluate = (assertion: Assertion, frames: ReadonlyArray<Frame>, clients: ReadonlyArray<string>): number =>
  measure(frames, subjectOf(assertion, clients), assertion.metric, assertion.agg)

/** Whether a check holds over `frames`, and the value it measured. */
export const holds = (assertion: Assertion, frames: ReadonlyArray<Frame>, clients: ReadonlyArray<string>): { readonly value: number; readonly holds: boolean } => {
  const value = evaluate(assertion, frames, clients)
  return { value, holds: compare(value, assertion.op, assertion.value) }
}
