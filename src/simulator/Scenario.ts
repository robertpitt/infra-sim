import { Duration, Effect, Schema } from "effect"
import * as Alarm from "./Alarm.ts"
import { type Assertion, clientIds, combine, compare, evaluate, measure, parseAssertion, parseDuration, parseValue, rateOver, type Scope, statsOf, subjectOf, totalOver, unitOf, within } from "./Check.ts"
import * as Design from "./Design.ts"
import * as Fault from "./Fault.ts"
import { Registry } from "./Registry.ts"
import * as ScenarioSpec from "./ScenarioSpec.ts"
import * as Simulation from "./Simulation.ts"
import type { Frame, Stats } from "./Telemetry.ts"
import { VirtualTime } from "./VirtualTime.ts"

/**
 * Scenarios: a design plus what happens to it.
 *
 * A design says what the system is; a scenario says how long to run it, with what traffic, which settings changed,
 * what breaks and when, and what must hold. A design carries the scenarios written for it (`scenarios` in the design);
 * a scenario can also be a file of its own that names its design, as below. Running one gives a plain-data `Result` (per-node and per-edge summaries,
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

// Durations and assertions are written in the check language, which lives in `Check.ts` and is shared with alarms.
export { type Aggregate, ASSERTION_SYNTAX, type Assertion, parseAssertion, parseDuration } from "./Check.ts"

// ---------------------------------------------------------------------------------------------------------
// The scenario document
// ---------------------------------------------------------------------------------------------------------

/**
 * A scenario file: the scenario's fields (`ScenarioSpec.ts`, the same ones a design carries under `scenarios`) plus the
 * format version and the design it is for.
 */
export const Scenario = Schema.Struct({
  /** The JSON Schema the file follows, for editors. */
  $schema: Schema.optionalKey(Schema.String),
  version: Schema.Literal(1),
  /** A path to a design file (resolved by whoever loads the scenario), or the design itself. */
  design: Schema.optionalKey(Schema.Union([Schema.String, Design.Doc])),
  ...ScenarioSpec.fields
})
export type Scenario = typeof Scenario.Type

/** A scenario wherever it is written: in a file of its own, or in a design under `scenarios`. */
export type Spec = ScenarioSpec.Spec
export type TimelineEvent = ScenarioSpec.TimelineEvent

/** The scenarios a design carries, by id, in the order it lists them. */
export const ofDesign = (design: Design.Doc): ReadonlyArray<readonly [id: string, scenario: Spec]> => Object.entries(design.scenarios ?? {})

/** Something is wrong with the scenario, the design or the way they fit together. Every problem is listed. */
export class ScenarioError extends Error {
  override readonly name = "ScenarioError"
  constructor(readonly issues: ReadonlyArray<string>) {
    super(issues.join("\n"))
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
  /** Alarms that went off during the run, as a monitoring system would have raised them. */
  readonly alerts: ReadonlyArray<Alarm.Alert>
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
    if (m === null) return `can't read the fault "${input}" (Outage, Blackhole, Slow(250ms), Errors(20%), Loss(10%), Crash(2))`
    const kind = m[1]!
    const arg = m[2]?.trim()
    const tag = Fault.catalog.find((k) => k.tag.toLowerCase() === kind.toLowerCase())?.tag
    if (tag === undefined) return `no fault called "${kind}" (${Fault.catalog.map((k) => k.tag).join(", ")})`
    if (arg === undefined || arg === "") return { _tag: tag }
    if (tag === "Slow") {
      const ms = parseDuration(arg)
      return ms === undefined ? `can't read "${arg}" as a duration (try 250ms or 2s)` : { _tag: tag, extra: ms }
    }
    if (tag === "Crash") {
      // Crash(2): two units; Crash(2 hosts): two of the hosts under them.
      const c = /^(\d+)\s*(units?|hosts?)?$/.exec(arg)
      return c === null ? `can't read "${arg}" as a number of units (try Crash(2) or Crash(1 host))` : { _tag: tag, units: Number(c[1]), on: c[2]?.startsWith("host") ? "hosts" : "units" }
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
  if (kind === "node" || kind === "edge" || kind === "region" || kind === "zone") return { kind, id: text.slice(colon + 1) }
  if (text in design.nodes) return { kind: "node", id: text }
  if (text in design.edges) return { kind: "edge", id: text }
  // `aws:us-east-1` is a placement; `aws:us-east-1:us-east-1a` one of its zones.
  const colons = text.split(":").length - 1
  if (colons === 1) return { kind: "region", id: text }
  if (colons === 2) return { kind: "zone", id: text }
  return `can't tell what "${text}" is: write node:<id>, edge:<id>, region:<placement> or zone:<placement>:<zone>`
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
export const check = (design: Design.Doc, scenario: Spec): ReadonlyArray<string> => {
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
      else if (target.kind === "zone" && target.id.split(":").length !== 3) issues.push(`${where}.inject.target: write a zone as zone:<placement>:<zone>, such as zone:aws:us-east-1:us-east-1a`)
      const fault = parseFault(event.inject.fault as string | Bag)
      if (typeof fault === "string") issues.push(`${where}.inject.fault: ${fault}`)
      else if (typeof target !== "string") {
        const kind = Fault.catalog.find((k) => k.tag === fault._tag)
        if (kind !== undefined && !kind.targets.includes(target.kind)) issues.push(`${where}.inject: ${kind.label} can't be applied to a ${target.kind} (only to ${kind.targets.join(", ")})`)
      }
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
export const prepare = (design: Design.Doc, scenario: Spec, registry: { readonly get: (type: string) => { readonly type: string } | undefined }): Design.Doc => {
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

// ---------------------------------------------------------------------------------------------------------
// Playing a scenario
// ---------------------------------------------------------------------------------------------------------

const EventKind = Schema.Literals(["inject", "clear", "set", "account", "note"])

/** Where a check stands: before its window opens, measuring (and so far holding or breaking), or decided. */
export const CheckState = Schema.Literals(["waiting", "holding", "breaking", "passed", "failed"])
export type CheckState = typeof CheckState.Type

export const CheckProgress = Schema.Struct({
  check: Schema.String,
  name: Schema.optionalKey(Schema.String),
  window: Schema.Struct({ from: Schema.Number, to: Schema.Number }),
  expected: Schema.Struct({ op: Schema.String, value: Schema.Number }),
  unit: Schema.Literals(["ratio", "ms", "count", "rate", "number"]),
  state: CheckState,
  /** What it measures over its window so far; absent while waiting. */
  actual: Schema.optionalKey(Schema.Number)
})
export type CheckProgress = typeof CheckProgress.Type

/** A scenario part-way through: what has happened, what is coming, and how each assertion is doing. Plain data. */
export const Progress = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  duration: Schema.Number,
  warmup: Schema.Number,
  t: Schema.Number,
  /** The run has reached its duration and every check is decided. */
  finished: Schema.Boolean,
  /** Once finished: did every check pass. */
  passed: Schema.optionalKey(Schema.Boolean),
  timeline: Schema.Array(Schema.Struct({ at: Schema.Number, what: Schema.String, kind: EventKind, done: Schema.Boolean })),
  checks: Schema.Array(CheckProgress)
})
export type Progress = typeof Progress.Type

/**
 * A scenario being played against a running simulation. Whoever drives time (`run` below, as fast as it can; the engine,
 * paced against the clock) asks where to stop next, advances there, records the frames and applies what is due, so an
 * event lands at exactly its time however fast the run. The checks are measured from the recorded frames, at any moment
 * (for a live view) or once the end is reached (for the verdict), the same way either way.
 */
export interface Playback {
  /** The design the scenario runs: its traffic scale and overrides applied over the design's own settings. */
  readonly design: Design.Doc
  readonly seed: number
  readonly duration: number
  readonly warmup: number
  /** Where the run has to stop next: the next event, or the end. Infinity once it has ended. */
  readonly nextStop: () => number
  /** Apply every event due by `now`, in order. */
  readonly apply: (sim: Simulation.Service, now: number) => Effect.Effect<void, ScenarioError>
  /** Keep what the checks will measure from new frames. */
  readonly record: (frames: ReadonlyArray<Frame>) => void
  /** Mark the end of the scenario. Time may go on (a live run can be played further), but nothing more happens. */
  readonly end: () => void
  readonly ended: () => boolean
  readonly progress: (now: number) => Progress
  /** Every assertion's verdict. Final once the end is reached. */
  readonly results: () => ReadonlyArray<AssertionResult>
  /** What happened, as it happened. */
  readonly log: ReadonlyArray<{ readonly at: number; readonly what: string }>
  readonly spans: ReadonlyArray<FaultSpan>
}

const kindOf = (event: TimelineEvent): typeof EventKind.Type =>
  event.inject !== undefined ? "inject" : event.clear !== undefined ? "clear" : event.set !== undefined ? "set" : event.account !== undefined ? "account" : "note"

/**
 * Get a scenario ready to play against a design: checked (every problem reported, by id), its overrides applied, its
 * timeline in order and its assertions parsed.
 */
export const playback = (
  design: Design.Doc,
  scenario: Spec,
  registry: { readonly get: (type: string) => { readonly type: string; readonly inputs: boolean } | undefined }
): Effect.Effect<Playback, ScenarioError> =>
  Effect.gen(function*() {
    const problems = check(design, scenario)
    if (problems.length > 0) return yield* Effect.fail(new ScenarioError(problems))
    const duration = parseDuration(scenario.duration)
    if (duration === undefined) return yield* Effect.fail(new ScenarioError(["duration: a scenario needs one (for example 5m)"]))
    const warmup = parseDuration(scenario.warmup ?? 0) ?? 0
    const prepared = prepare(design, scenario, registry)
    const clients = clientIds(prepared, registry)

    const events = (scenario.timeline ?? [])
      .map((event, index) => ({ event, at: parseDuration(event.at)!, index }))
      .sort((a, b) => a.at - b.at || a.index - b.index)
    // `check` has parsed every assertion already.
    const assertions = (scenario.assert ?? []).map((a) =>
      (typeof a === "string"
        ? parseAssertion(a)
        : parseAssertion(a.check, { ...(a.name === undefined ? {} : { name: a.name }), ...(a.from === undefined ? {} : { from: parseDuration(a.from) ?? 0 }), ...(a.to === undefined ? {} : { to: parseDuration(a.to) ?? 0 }) })) as Assertion
    )
    const windows = assertions.map((a) => ({ from: a.from ?? warmup, to: a.to ?? duration }))

    // Only what the assertions read is kept, so a long live run doesn't hold every frame of a large design.
    const keep = { nodes: new Set<string>(), edges: new Set<string>() }
    for (const a of assertions) for (const id of subjectOf(a, clients).nodes) keep[a.subject.scope === "edge" ? "edges" : "nodes"].add(id)
    const pick = (stats: Frame["nodes"], ids: ReadonlySet<string>) => {
      const out: Record<string, Frame["nodes"][string]> = {}
      for (const id of ids) if (stats[id] !== undefined) out[id] = stats[id]
      return out
    }
    const recorded: Array<Frame> = []

    const spans: Array<{ id: string; target: string; fault: Fault.Fault["_tag"]; from: number; to: number | undefined }> = []
    const log: Array<{ at: number; what: string }> = []
    const named = new Map<string, string>()
    const decided = new Map<number, number>()
    let applied = 0
    let ended = false
    const fail = (message: string) => Effect.fail(new ScenarioError([message]))

    const applyOne = (sim: Simulation.Service, event: TimelineEvent, at: number) =>
      Effect.gen(function*() {
        log.push({ at, what: describe(event) })
        if (event.inject !== undefined) {
          const target = parseTarget(event.inject.target, prepared) as Fault.Target
          const encoded = parseFault(event.inject.fault as string | Bag) as Bag
          const fault = yield* Schema.decodeUnknownEffect(Fault.Fault)(encoded).pipe(Effect.mapError((e) => new ScenarioError([`timeline: ${e.message}`])))
          const lasts = event.inject.for === undefined ? undefined : parseDuration(event.inject.for)
          const active = yield* sim.faults.inject(target, fault, lasts).pipe(Effect.mapError(() => new ScenarioError([`timeline: nothing to inject into at ${event.inject!.target}`])))
          spans.push({ id: active.id, target: event.inject.target, fault: fault._tag, from: at, to: lasts === undefined ? undefined : at + lasts })
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
          // Over what is live: a person's edit, an earlier set, an autoscaler's decision all stay.
          const { node, edge, settings } = event.set
          if (node !== undefined) {
            yield* sim.patchNode(node, settings).pipe(Effect.catch((e) => fail(`timeline: ${node}: ${messageOf(e)}`)))
          } else if (edge !== undefined) {
            yield* sim.patchEdge(edge, settings).pipe(Effect.catch((e) => fail(`timeline: ${edge}: ${messageOf(e)}`)))
          }
        } else if (event.account !== undefined) {
          const { placement, settings } = event.account
          yield* sim.patchAccount(placement, settings).pipe(Effect.catch((e) => fail(`timeline: ${placement}: ${messageOf(e)}`)))
        }
      })

    /** An assertion's value over its window up to `now`, and whether that window has closed. */
    const measureAt = (i: number, now: number): { readonly actual: number; readonly closed: boolean } | undefined => {
      const final = decided.get(i)
      if (final !== undefined) return { actual: final, closed: true }
      const { from, to } = windows[i]!
      if (now <= from) return undefined
      const closed = now >= to
      const actual = evaluate(assertions[i]!, within(recorded, from, Math.min(now, to)), clients)
      if (closed) decided.set(i, actual)
      return { actual, closed }
    }

    const results = (): ReadonlyArray<AssertionResult> =>
      assertions.map((a, i) => {
        const actual = measureAt(i, Math.max(duration, windows[i]!.to))?.actual ?? 0
        return { check: a.text, name: a.name, passed: compare(actual, a.op, a.value), actual: round(actual, 6), expected: { op: a.op, value: a.value }, window: windows[i]! }
      })

    return {
      design: prepared,
      seed: scenario.seed ?? prepared.seed ?? 1,
      duration,
      warmup,
      nextStop: () => (ended ? Infinity : Math.min(events[applied]?.at ?? Infinity, duration)),
      apply: (sim, now) =>
        Effect.gen(function*() {
          while (applied < events.length && events[applied]!.at <= now) {
            const { event, at } = events[applied]!
            applied++
            yield* applyOne(sim, event, at)
          }
        }),
      record: (frames) => {
        if (keep.nodes.size === 0 && keep.edges.size === 0) return
        for (const f of frames) recorded.push({ ...f, nodes: pick(f.nodes, keep.nodes), edges: pick(f.edges, keep.edges) })
      },
      end: () => {
        ended = true
      },
      ended: () => ended,
      progress: (now) => {
        const checks = assertions.map((a, i): CheckProgress => {
          const m = measureAt(i, now)
          const base = {
            check: a.text,
            ...(a.name === undefined ? {} : { name: a.name }),
            window: windows[i]!,
            expected: { op: a.op, value: a.value },
            unit: unitOf(a.metric)
          }
          if (m === undefined) return { ...base, state: "waiting" }
          const ok = compare(m.actual, a.op, a.value)
          return { ...base, actual: round(m.actual, 6), state: m.closed ? (ok ? "passed" : "failed") : ok ? "holding" : "breaking" }
        })
        const finished = ended || now >= duration
        return {
          ...(scenario.name === undefined ? {} : { name: scenario.name }),
          ...(scenario.description === undefined ? {} : { description: scenario.description }),
          duration,
          warmup,
          t: now,
          finished,
          ...(finished ? { passed: checks.every((c) => c.state === "passed") } : {}),
          timeline: events.map(({ event, at }, i) => ({ at, what: describe(event), kind: kindOf(event), done: i < applied })),
          checks
        }
      },
      results,
      log,
      spans
    }
  })

/**
 * Run a scenario against a design, as fast as it goes. The design is checked first (every problem reported, by id),
 * then run on a fresh virtual-time world, stopping at each timeline event to apply it. The result is plain data.
 */
export const run = (design: Design.Doc, scenario: Spec, options: RunOptions = {}): Effect.Effect<Result, ScenarioError, Registry> =>
  Effect.gen(function*() {
    const registry = yield* Registry
    const play = yield* playback(design, scenario, registry)
    const { duration, warmup, seed } = play
    const prepared = play.design

    const decoded = yield* Schema.decodeUnknownEffect(Design.codec(registry))(prepared, { errors: "all" }).pipe(
      Effect.mapError((e) => new ScenarioError(e.message.split("\n").map((l) => l.trim()).filter(Boolean)))
    )
    const started = Date.now()

    const body = Effect.gen(function*() {
      const sim = yield* Simulation.make(decoded, { seed, ...(options.frameMs === undefined ? {} : { frameMs: options.frameMs }) }).pipe(
        Effect.provide(VirtualTime.layer),
        Effect.mapError((e) => new ScenarioError([e.message]))
      )
      const frames: Array<Frame> = []
      const alarms = Alarm.monitor(prepared, registry)
      yield* play.apply(sim, 0)
      while ((yield* sim.now) < duration) {
        const stop = play.nextStop()
        const advanced = yield* sim.advanceTo(stop)
        frames.push(...advanced)
        play.record(advanced)
        alarms.observe(advanced)
        yield* play.apply(sim, stop)
      }
      play.end()
      const defects = yield* sim.defects
      return { frames, defects, alerts: alarms.alerts() }
    })

    const { frames, defects, alerts } = yield* Effect.scoped(body)

    const measured = within(frames, warmup, duration)
    const clients = clientIds(prepared, registry)
    const nodes: Record<string, Summary> = {}
    for (const [id, n] of Object.entries(prepared.nodes)) nodes[id] = summarise(measured, "nodes", [id], { type: n.type, name: n.name ?? id })
    const edges: Record<string, Summary> = {}
    for (const id of Object.keys(prepared.edges)) edges[id] = summarise(measured, "edges", [id])
    const system = summarise(measured, "nodes", clients)
    const assertions = play.results()

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
      timeline: play.log,
      faults: play.spans,
      assertions,
      alerts,
      defects: defects.map((d) => ({ t: d.t, node: d.node, message: d.message })),
      diagnostics: [],
      ...(options.keepFrames === true ? { frames } : {})
    }
    return result
  })

/** Seconds helper for callers that format durations. */
export const toSeconds = (ms: number): number => Duration.toSeconds(Duration.millis(ms))
