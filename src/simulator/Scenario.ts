import { Duration, Effect, Schema } from "effect"
import * as Design from "./Design.ts"
import * as Fault from "./Fault.ts"
import { Registry } from "./Registry.ts"
import * as Simulation from "./Simulation.ts"
import type { Frame, Stats } from "./Telemetry.ts"
import { VirtualTime } from "./VirtualTime.ts"

/**
 * Scenarios: a design plus what happens to it.
 *
 * A design says what the system is; a scenario says how long to run it, with what traffic, which settings changed,
 * what breaks and when, and what must hold. Running one gives a plain-data `Result` (per-node and per-edge summaries,
 * the faults that happened, every assertion with its measured value), so the same scenario can be run from the
 * browser, a command line, a test or a CI job, and its result read by a person or a program.
 *
 *   version: 1
 *   name: Lose us-east-1 at peak
 *   design: ./orders.yaml
 *   duration: 10m
 *   warmup: 30s
 *   traffic: { scale: 3 }
 *   timeline:
 *     - { at: 4m, inject: { target: "region:aws:us-east-1", fault: Outage, for: 2m } }
 *   assert:
 *     - api.errorRatio < 1%
 *     - { check: "web.latency.p99 < 800ms", from: 7m }
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

const DurationInput = Schema.Union([Schema.Number, Schema.String])

// ---------------------------------------------------------------------------------------------------------
// The scenario document
// ---------------------------------------------------------------------------------------------------------

const Settings = Schema.Record(Schema.String, Schema.Unknown)

/** A fault given as `Outage`, `Slow(250ms)`, `Errors(20%)`, or as an object `{ type: Slow, extra: 250ms }`. */
const FaultInput = Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Unknown)])

const Event = Schema.Struct({
  /** When it happens, from the start of the run. */
  at: DurationInput,
  /** Say what this event is, in the result's log. */
  note: Schema.optionalKey(Schema.String),
  /** Break something: `target` is `node:<id>`, `edge:<id>` or `region:<placement>` (`region:aws:us-east-1`). */
  inject: Schema.optionalKey(
    Schema.Struct({
      target: Schema.String,
      fault: FaultInput,
      /** How long it lasts. Without it the fault lasts until cleared. */
      for: Schema.optionalKey(DurationInput),
      /** A name to clear it by later. */
      id: Schema.optionalKey(Schema.String)
    })
  ),
  /** Lift a named fault, or `all` of them. */
  clear: Schema.optionalKey(Schema.String),
  /** Change settings of a node (`node`) or an edge (`edge`) while running. Merged over what it already has. */
  set: Schema.optionalKey(
    Schema.Struct({ node: Schema.optionalKey(Schema.String), edge: Schema.optionalKey(Schema.String), settings: Settings })
  ),
  /** Change account-level quotas of a placement such as `aws:us-east-1` while running. */
  account: Schema.optionalKey(Schema.Struct({ placement: Schema.String, settings: Settings }))
})

const AssertionInput = Schema.Union([
  Schema.String,
  Schema.Struct({
    check: Schema.String,
    name: Schema.optionalKey(Schema.String),
    /** Measure only from here (default: the end of the warm-up). */
    from: Schema.optionalKey(DurationInput),
    /** ... to here (default: the end of the run). */
    to: Schema.optionalKey(DurationInput)
  })
])

export const Scenario = Schema.Struct({
  version: Schema.Literal(1),
  name: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  /** A path to a design file (resolved by whoever loads the scenario), or the design itself. */
  design: Schema.optionalKey(Schema.Union([Schema.String, Design.Doc])),
  seed: Schema.optionalKey(Schema.Int),
  duration: Schema.optionalKey(DurationInput),
  /** Time to let the system settle before measuring. Assertions and summaries start after it. */
  warmup: Schema.optionalKey(DurationInput),
  /** Multiply every client's request rate. */
  traffic: Schema.optionalKey(Schema.Struct({ scale: Schema.Number })),
  /** Settings applied at the start, merged over the design's own, by node id, edge id and placement. */
  overrides: Schema.optionalKey(
    Schema.Struct({
      nodes: Schema.optionalKey(Schema.Record(Schema.String, Settings)),
      edges: Schema.optionalKey(Schema.Record(Schema.String, Settings)),
      accounts: Schema.optionalKey(Schema.Record(Schema.String, Settings))
    })
  ),
  timeline: Schema.optionalKey(Schema.Array(Event)),
  assert: Schema.optionalKey(Schema.Array(AssertionInput))
})
export type Scenario = typeof Scenario.Type

export type TimelineEvent = typeof Event.Type

/** Something is wrong with the scenario, the design or the way they fit together. Every problem is listed. */
export class ScenarioError extends Error {
  override readonly name = "ScenarioError"
  constructor(readonly issues: ReadonlyArray<string>) {
    super(issues.join("\n"))
  }
}

// ---------------------------------------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------------------------------------

type Op = "<" | "<=" | ">" | ">=" | "==" | "!="

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
type Metric =
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

const parseValue = (text: string): number | undefined => {
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

type Scope = "nodes" | "edges"

/** Frames whose window ends in (from, to]. */
const within = (frames: ReadonlyArray<Frame>, from: number, to: number) => frames.filter((f) => f.t > from && f.t <= to)

const statsOf = (frame: Frame, scope: Scope, id: string): Stats | undefined => frame[scope][id]

const combine = (values: ReadonlyArray<number>, agg: Aggregate): number => {
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
const rateOver = (frames: ReadonlyArray<Frame>, scope: Scope, id: string, name: string, agg: Aggregate): number =>
  agg === "sum"
    ? frames.reduce((n, f) => n + ((statsOf(f, scope, id)?.rates[name] ?? 0) * f.dt) / 1000, 0)
    : combine(frames.map((f) => statsOf(f, scope, id)?.rates[name] ?? 0), agg)

const totalOver = (frames: ReadonlyArray<Frame>, scope: Scope, id: string, name: string): number => rateOver(frames, scope, id, name, "sum")

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
const clientIds = (design: Design.Doc, registry: { readonly get: (type: string) => { readonly inputs: boolean } | undefined }): ReadonlyArray<string> =>
  Object.entries(design.nodes).filter(([, n]) => registry.get(n.type)?.inputs === false).map(([id]) => id)

interface Subject {
  readonly nodes: ReadonlyArray<string>
  readonly scope: Scope
}

const measure = (frames: ReadonlyArray<Frame>, subject: Subject, metric: Metric, agg: Aggregate | undefined): number => {
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

// ---------------------------------------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------------------------------------

export interface DistSummary {
  readonly n: number
  readonly mean: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly max: number
}

/** What one node or edge did over the measured window. Rates are per second; latencies are milliseconds. */
export interface Summary {
  readonly type?: string
  readonly name?: string
  readonly rates: Readonly<Record<string, number>>
  readonly gauges: Readonly<Record<string, { readonly mean: number; readonly max: number; readonly last: number }>>
  readonly dist: Readonly<Record<string, DistSummary>>
  /** Events counted in the window. */
  readonly totals: { readonly in: number; readonly ok: number; readonly fail: number }
  /** fail / (ok + fail) over the window. */
  readonly errorRatio: number
}

export interface AssertionResult {
  readonly check: string
  readonly name: string | undefined
  readonly passed: boolean
  /** What was measured, or `undefined` if the subject doesn't exist. */
  readonly actual: number | undefined
  readonly expected: { readonly op: string; readonly value: number }
  readonly window: { readonly from: number; readonly to: number }
  /** Why it couldn't be checked, if it couldn't. */
  readonly problem?: string
}

export interface FaultSpan {
  readonly id: string
  readonly target: string
  readonly fault: Fault.Fault["_tag"]
  readonly from: number
  readonly to: number | undefined
}

export interface Result {
  readonly scenario: string | undefined
  readonly seed: number
  /** Virtual milliseconds run, and measured (after the warm-up). */
  readonly duration: number
  readonly warmup: number
  /** Real milliseconds the run took. */
  readonly wallMs: number
  readonly frameMs: number
  readonly passed: boolean
  /** Every client together: what users saw. */
  readonly system: Summary
  readonly nodes: Readonly<Record<string, Summary>>
  readonly edges: Readonly<Record<string, Summary>>
  readonly timeline: ReadonlyArray<{ readonly at: number; readonly what: string }>
  readonly faults: ReadonlyArray<FaultSpan>
  readonly assertions: ReadonlyArray<AssertionResult>
  /** Components that threw instead of failing a call. */
  readonly defects: ReadonlyArray<{ readonly t: number; readonly node: string; readonly message: string }>
  readonly diagnostics: ReadonlyArray<{ readonly level: string; readonly code: string; readonly message: string; readonly node?: string; readonly edge?: string }>
  /** Every frame, when asked for. */
  readonly frames?: ReadonlyArray<Frame>
}

const summarise = (frames: ReadonlyArray<Frame>, scope: Scope, ids: ReadonlyArray<string>, meta?: { type?: string; name?: string }): Summary => {
  const names = (pick: (s: Stats) => Record<string, unknown>) => {
    const out = new Set<string>()
    for (const f of frames) for (const id of ids) for (const k of Object.keys(pick(statsOf(f, scope, id) ?? { rates: {}, gauges: {}, dist: {} }))) out.add(k)
    return [...out].sort()
  }
  const sumRates = (name: string) => ids.reduce((n, id) => n + rateOver(frames, scope, id, name, "mean"), 0)
  const total = (name: string) => ids.reduce((n, id) => n + totalOver(frames, scope, id, name), 0)
  const rates: Record<string, number> = {}
  for (const name of names((s) => s.rates)) rates[name] = round(sumRates(name))
  const gauges: Record<string, { mean: number; max: number; last: number }> = {}
  for (const name of names((s) => s.gauges)) {
    const series = frames.map((f) => ids.reduce((n, id) => n + (statsOf(f, scope, id)?.gauges[name] ?? 0), 0))
    gauges[name] = { mean: round(combine(series, "mean")), max: round(combine(series, "max")), last: round(combine(series, "last")) }
  }
  const dist: Record<string, DistSummary> = {}
  for (const name of names((s) => s.dist)) {
    const n = frames.reduce((s, f) => ids.reduce((m, id) => m + (statsOf(f, scope, id)?.dist[name]?.n ?? 0), s), 0)
    const stat = (k: "mean" | "p50" | "p95" | "p99" | "max") => round(measure(frames, { nodes: ids, scope }, { kind: "dist", name, stat: k }, k === "max" ? "max" : "mean"))
    dist[name] = { n, mean: stat("mean"), p50: stat("p50"), p95: stat("p95"), p99: stat("p99"), max: stat("max") }
  }
  const ok = total("ok")
  const fail = total("fail")
  return {
    ...(meta?.type === undefined ? {} : { type: meta.type }),
    ...(meta?.name === undefined ? {} : { name: meta.name }),
    rates,
    gauges,
    dist,
    totals: { in: Math.round(total("in") + total("sent")), ok: Math.round(ok), fail: Math.round(fail) },
    errorRatio: ok + fail === 0 ? 0 : round(fail / (ok + fail), 6)
  }
}

const round = (n: number, digits = 3): number => {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

// ---------------------------------------------------------------------------------------------------------
// Preparing and running
// ---------------------------------------------------------------------------------------------------------

type Bag = Record<string, unknown>

const isPlain = (v: unknown): v is Bag => typeof v === "object" && v !== null && !Array.isArray(v)

/** Deep merge: objects merge key by key, anything else replaces. */
export const merge = (base: Bag | undefined, over: Bag): Bag => {
  const out: Bag = { ...(base ?? {}) }
  for (const [k, v] of Object.entries(over)) out[k] = isPlain(v) && isPlain(out[k]) ? merge(out[k] as Bag, v) : v
  return out
}

/** A fault as written in a scenario, as the fault schema's own JSON form. */
export const parseFault = (input: string | Bag): Bag | string => {
  if (typeof input === "string") {
    const m = /^\s*([A-Za-z]+)\s*(?:\(\s*([^)]*)\s*\))?\s*$/.exec(input)
    if (m === null) return `can't read the fault "${input}" (Outage, Blackhole, Slow(250ms), Errors(20%), Loss(10%))`
    const kind = m[1]!
    const arg = m[2]?.trim()
    const tag = Fault.catalog.find((k) => k.tag.toLowerCase() === kind.toLowerCase())?.tag
    if (tag === undefined) return `no fault called "${kind}" (${Fault.catalog.map((k) => k.tag).join(", ")})`
    if (arg === undefined || arg === "") return { _tag: tag }
    if (tag === "Slow") {
      const ms = parseDuration(arg)
      return ms === undefined ? `can't read "${arg}" as a duration (try 250ms or 2s)` : { _tag: tag, extra: ms }
    }
    const rate = parseValue(arg)
    return rate === undefined ? `can't read "${arg}" as a rate` : { _tag: tag, rate }
  }
  const { type, kind, _tag, ...rest } = input as Bag
  const name = String(type ?? kind ?? _tag ?? "")
  const tag = Fault.catalog.find((k) => k.tag.toLowerCase() === name.toLowerCase())?.tag
  if (tag === undefined) return `no fault called "${name}" (${Fault.catalog.map((k) => k.tag).join(", ")})`
  const fields: Bag = { ...rest }
  if (typeof fields.rate === "string") fields.rate = parseValue(fields.rate) ?? fields.rate
  // Like every duration in a scenario: "250ms", "2s", or a bare number of seconds. The fault schema takes milliseconds.
  if (fields.extra !== undefined) {
    const ms = parseDuration(fields.extra)
    if (ms === undefined) return `can't read extra: ${String(fields.extra)} as a duration`
    fields.extra = ms
  }
  return { _tag: tag, ...fields }
}

const parseTarget = (text: string, design: Design.Doc): Fault.Target | string => {
  const colon = text.indexOf(":")
  const kind = colon < 0 ? "" : text.slice(0, colon)
  if (kind === "node" || kind === "edge" || kind === "region") return { kind, id: text.slice(colon + 1) }
  if (text in design.nodes) return { kind: "node", id: text }
  if (text in design.edges) return { kind: "edge", id: text }
  if (text.includes(":")) return { kind: "region", id: text }
  return `can't tell what "${text}" is: write node:<id>, edge:<id> or region:<placement>`
}

/** What a scenario needs from outside: how long to run. The CLI supplies defaults for flags. */
export interface RunOptions {
  /** Return every frame in the result (large). */
  readonly keepFrames?: boolean
  readonly frameMs?: number
}

/**
 * Check a scenario against a design without running it: every problem, listed, in one go. Assertions are parsed, events
 * are checked for ids that exist and times inside the run.
 */
export const check = (design: Design.Doc, scenario: Scenario): ReadonlyArray<string> => {
  const issues: Array<string> = []
  const duration = parseDuration(scenario.duration)
  if (scenario.duration !== undefined && duration === undefined) issues.push(`duration: can't read "${String(scenario.duration)}" (try 90s, 5m, 1h30m)`)
  if (duration !== undefined && duration <= 0) issues.push("duration: must be more than zero")
  const warmup = parseDuration(scenario.warmup ?? 0)
  if (warmup === undefined) issues.push(`warmup: can't read "${String(scenario.warmup)}"`)
  else if (duration !== undefined && warmup >= duration) issues.push("warmup: must be shorter than the duration")
  for (const id of Object.keys(scenario.overrides?.nodes ?? {})) if (!(id in design.nodes)) issues.push(`overrides.nodes: no node "${id}"`)
  for (const id of Object.keys(scenario.overrides?.edges ?? {})) if (!(id in design.edges)) issues.push(`overrides.edges: no edge "${id}"`)
  ;(scenario.timeline ?? []).forEach((event, i) => {
    const where = `timeline[${i}]`
    const at = parseDuration(event.at)
    if (at === undefined) issues.push(`${where}.at: can't read "${String(event.at)}"`)
    else if (duration !== undefined && at > duration) issues.push(`${where}.at: ${String(event.at)} is after the run ends`)
    const kinds = ["inject", "clear", "set", "account"].filter((k) => k in event)
    // An event does one thing. One with no action and a note is an annotation in the timeline.
    if (kinds.length > 1) issues.push(`${where}: does more than one thing (${kinds.join(", ")}): split it into separate events`)
    else if (kinds.length === 0 && event.note === undefined) issues.push(`${where}: needs one of inject, clear, set, account (or a note, to annotate the timeline)`)
    if (event.inject !== undefined) {
      const target = parseTarget(event.inject.target, design)
      if (typeof target === "string") issues.push(`${where}.inject.target: ${target}`)
      else if (target.kind === "node" && !(target.id in design.nodes)) issues.push(`${where}.inject.target: no node "${target.id}"`)
      else if (target.kind === "edge" && !(target.id in design.edges)) issues.push(`${where}.inject.target: no edge "${target.id}"`)
      const fault = parseFault(event.inject.fault as string | Bag)
      if (typeof fault === "string") issues.push(`${where}.inject.fault: ${fault}`)
      if (event.inject.for !== undefined && parseDuration(event.inject.for) === undefined) issues.push(`${where}.inject.for: can't read "${String(event.inject.for)}"`)
    }
    if (event.set !== undefined) {
      const { node, edge } = event.set
      if ((node === undefined) === (edge === undefined)) issues.push(`${where}.set: give either node or edge`)
      else if (node !== undefined && !(node in design.nodes)) issues.push(`${where}.set.node: no node "${node}"`)
      else if (edge !== undefined && !(edge in design.edges)) issues.push(`${where}.set.edge: no edge "${edge}"`)
    }
  })
  for (const a of scenario.assert ?? []) {
    const parsed = typeof a === "string" ? parseAssertion(a) : parseAssertion(a.check, { ...(a.name === undefined ? {} : { name: a.name }), ...(a.from === undefined ? {} : { from: parseDuration(a.from) ?? 0 }), ...(a.to === undefined ? {} : { to: parseDuration(a.to) ?? 0 }) })
    if (typeof parsed === "string") issues.push(`assert: ${parsed}`)
    else if (parsed.subject.scope === "node" && !(parsed.subject.id in design.nodes)) issues.push(`assert: "${parsed.text}": no node "${parsed.subject.id}"`)
    else if (parsed.subject.scope === "edge" && !(parsed.subject.id in design.edges)) issues.push(`assert: "${parsed.text}": no edge "${parsed.subject.id}"`)
  }
  return issues
}

/**
 * Apply the scenario's traffic scale and starting overrides to the design's own settings. The design is not changed:
 * a new document comes back.
 */
export const prepare = (design: Design.Doc, scenario: Scenario, registry: { readonly get: (type: string) => { readonly type: string } | undefined }): Design.Doc => {
  let doc = design
  const scale = scenario.traffic?.scale
  if (scale !== undefined && scale !== 1) {
    doc = {
      ...doc,
      nodes: Object.fromEntries(
        Object.entries(doc.nodes).map(([id, n]) => {
          const rps = (n.settings as Bag | undefined)?.rps
          // A client with no `rps` of its own runs at its component's default, which scaling must start from.
          return n.type === "common.client" && registry.get(n.type) !== undefined
            ? [id, { ...n, settings: { ...(n.settings ?? {}), rps: (typeof rps === "number" ? rps : 100) * scale } }]
            : [id, n]
        })
      )
    }
  }
  for (const [id, over] of Object.entries(scenario.overrides?.nodes ?? {})) {
    const node = doc.nodes[id]
    if (node !== undefined) doc = { ...doc, nodes: { ...doc.nodes, [id]: { ...node, settings: merge(node.settings as Bag | undefined, over) } } }
  }
  for (const [id, over] of Object.entries(scenario.overrides?.edges ?? {})) {
    const edge = doc.edges[id]
    if (edge !== undefined) doc = { ...doc, edges: { ...doc.edges, [id]: { ...edge, settings: merge(edge.settings as Bag | undefined, over) } } }
  }
  for (const [placement, over] of Object.entries(scenario.overrides?.accounts ?? {})) {
    doc = { ...doc, accounts: { ...(doc.accounts ?? {}), [placement]: merge(doc.accounts?.[placement] as Bag | undefined, over) } }
  }
  return doc
}

const describe = (event: TimelineEvent): string => {
  if (event.note !== undefined) return event.note
  if (event.inject !== undefined) return `inject ${typeof event.inject.fault === "string" ? event.inject.fault : JSON.stringify(event.inject.fault)} on ${event.inject.target}${event.inject.for === undefined ? "" : ` for ${String(event.inject.for)}`}`
  if (event.clear !== undefined) return `clear ${event.clear === "all" ? "all faults" : `fault ${event.clear}`}`
  if (event.set !== undefined) return `set ${event.set.node === undefined ? `edge ${event.set.edge}` : `node ${event.set.node}`} ${JSON.stringify(event.set.settings)}`
  if (event.account !== undefined) return `set quotas of ${event.account.placement} ${JSON.stringify(event.account.settings)}`
  return "event"
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Run a scenario against a design. The design is checked first (every problem reported, by id), then run on a fresh
 * virtual-time world, stopping at each timeline event to apply it. The result is plain data.
 */
export const run = (design: Design.Doc, scenario: Scenario, options: RunOptions = {}): Effect.Effect<Result, ScenarioError, Registry> =>
  Effect.gen(function*() {
    const registry = yield* Registry
    const problems = check(design, scenario)
    if (problems.length > 0) return yield* Effect.fail(new ScenarioError(problems))
    const duration = parseDuration(scenario.duration)
    if (duration === undefined) return yield* Effect.fail(new ScenarioError(["duration: a scenario needs one (for example 5m)"]))
    const warmup = parseDuration(scenario.warmup ?? 0) ?? 0
    const prepared = prepare(design, scenario, registry)
    const seed = scenario.seed ?? prepared.seed ?? 1

    const decoded = yield* Schema.decodeUnknownEffect(Design.codec(registry))(prepared, { errors: "all" }).pipe(
      Effect.mapError((e) => new ScenarioError(e.message.split("\n").map((l) => l.trim()).filter(Boolean)))
    )
    const started = Date.now()

    const body = Effect.gen(function*() {
      const sim = yield* Simulation.make(decoded, { seed, ...(options.frameMs === undefined ? {} : { frameMs: options.frameMs }) }).pipe(
        Effect.provide(VirtualTime.layer),
        Effect.mapError((e) => new ScenarioError([e.message]))
      )
      // What each node, edge and account currently has as overrides, so a later change merges over it.
      const current = {
        nodes: new Map(Object.entries(prepared.nodes).map(([id, n]) => [id, (n.settings ?? {}) as Bag])),
        edges: new Map(Object.entries(prepared.edges).map(([id, e]) => [id, (e.settings ?? {}) as Bag])),
        accounts: new Map(Object.entries(prepared.accounts ?? {}).map(([k, v]) => [k, v as Bag]))
      }
      const frames: Array<Frame> = []
      const spans: Array<{ id: string; target: string; fault: Fault.Fault["_tag"]; from: number; to: number | undefined }> = []
      const log: Array<{ at: number; what: string }> = []
      const named = new Map<string, string>()
      const fail = (message: string) => Effect.fail(new ScenarioError([message]))

      const events = (scenario.timeline ?? [])
        .map((event, index) => ({ event, at: parseDuration(event.at)!, index }))
        .sort((a, b) => a.at - b.at || a.index - b.index)

      for (const { event, at } of events) {
        frames.push(...(yield* sim.advanceTo(at)))
        log.push({ at, what: describe(event) })
        if (event.inject !== undefined) {
          const target = parseTarget(event.inject.target, prepared) as Fault.Target
          const encoded = parseFault(event.inject.fault as string | Bag) as Bag
          const fault = yield* Schema.decodeUnknownEffect(Fault.Fault)(encoded).pipe(Effect.mapError((e) => new ScenarioError([`timeline: ${e.message}`])))
          const lasts = event.inject.for === undefined ? undefined : parseDuration(event.inject.for)
          const active = yield* sim.faults.inject(target, fault, lasts).pipe(Effect.mapError(() => new ScenarioError([`timeline: nothing to inject into at ${event.inject!.target}`])))
          const span = { id: active.id, target: event.inject.target, fault: fault._tag, from: at, to: lasts === undefined ? undefined : at + lasts }
          spans.push(span)
          if (event.inject.id !== undefined) named.set(event.inject.id, active.id)
        } else if (event.clear !== undefined) {
          const open = yield* sim.faults.active
          const ids = event.clear === "all" ? open.map((f) => f.id) : [named.get(event.clear) ?? event.clear]
          for (const id of ids) {
            yield* sim.faults.clear(id)
            const span = spans.find((s) => s.id === id)
            if (span !== undefined && span.to === undefined) span.to = at
          }
        } else if (event.set !== undefined) {
          const { node, edge, settings } = event.set
          if (node !== undefined) {
            const next = merge(current.nodes.get(node), settings)
            yield* sim.configureNode(node, next).pipe(Effect.catch((e) => fail(`timeline: ${node}: ${messageOf(e)}`)))
            current.nodes.set(node, next)
          } else if (edge !== undefined) {
            const next = merge(current.edges.get(edge), settings)
            yield* sim.configureEdge(edge, next).pipe(Effect.catch((e) => fail(`timeline: ${edge}: ${messageOf(e)}`)))
            current.edges.set(edge, next)
          }
        } else if (event.account !== undefined) {
          const { placement, settings } = event.account
          const next = merge(current.accounts.get(placement), settings)
          yield* sim.configureAccount(placement, next).pipe(Effect.catch((e) => fail(`timeline: ${placement}: ${messageOf(e)}`)))
          current.accounts.set(placement, next)
        }
      }
      frames.push(...(yield* sim.advanceTo(duration)))
      const defects = yield* sim.defects
      return { frames, spans, log, defects }
    })

    const { frames, spans, log, defects } = yield* Effect.scoped(body)

    const measured = within(frames, warmup, duration)
    const clients = clientIds(prepared, registry)
    const nodes: Record<string, Summary> = {}
    for (const [id, n] of Object.entries(prepared.nodes)) nodes[id] = summarise(measured, "nodes", [id], { type: n.type, name: n.name ?? id })
    const edges: Record<string, Summary> = {}
    for (const id of Object.keys(prepared.edges)) edges[id] = summarise(measured, "edges", [id])
    const system = summarise(measured, "nodes", clients)

    const assertions: Array<AssertionResult> = (scenario.assert ?? []).map((a) => {
      const text = typeof a === "string" ? a : a.check
      const parsed = typeof a === "string" ? parseAssertion(a) : parseAssertion(a.check, { ...(a.name === undefined ? {} : { name: a.name }), ...(a.from === undefined ? {} : { from: parseDuration(a.from) ?? 0 }), ...(a.to === undefined ? {} : { to: parseDuration(a.to) ?? 0 }) })
      const window = { from: typeof parsed === "string" ? warmup : (parsed.from ?? warmup), to: typeof parsed === "string" ? duration : (parsed.to ?? duration) }
      if (typeof parsed === "string") return { check: text, name: undefined, passed: false, actual: undefined, expected: { op: "?", value: 0 }, window, problem: parsed }
      const subjectNodes = parsed.subject.scope === "system" ? clients : [parsed.subject.id]
      const scope: Scope = parsed.subject.scope === "edge" ? "edges" : "nodes"
      const actual = measure(within(frames, window.from, window.to), { nodes: subjectNodes, scope }, parsed.metric, parsed.agg)
      return { check: text, name: parsed.name, passed: compare(actual, parsed.op, parsed.value), actual: round(actual, 6), expected: { op: parsed.op, value: parsed.value }, window }
    })

    const result: Result = {
      scenario: scenario.name,
      seed,
      duration,
      warmup,
      wallMs: Date.now() - started,
      frameMs: frames.length > 1 ? frames[1]!.t - frames[0]!.t : 250,
      passed: assertions.every((a) => a.passed) && defects.length === 0,
      system,
      nodes,
      edges,
      timeline: log,
      faults: spans,
      assertions,
      defects: defects.map((d) => ({ t: d.t, node: d.node, message: d.message })),
      diagnostics: [],
      ...(options.keepFrames === true ? { frames } : {})
    }
    return result
  })

const compare = (actual: number, op: Op, expected: number): boolean => {
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

/** Seconds helper for callers that format durations. */
export const toSeconds = (ms: number): number => Duration.toSeconds(Duration.millis(ms))
