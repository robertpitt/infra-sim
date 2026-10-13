/**
 * The machinery behind `Scenario.ts`: reading the parts of a scenario written as text (faults, targets, assertions),
 * checking a scenario against its design, applying its overrides, keeping the frames its checks read and measuring
 * them, and summarising a run's frames into the plain-data result.
 */
import {
  type Assertion,
  clientIds,
  combine,
  compare,
  evaluate,
  measure,
  parseAssertion,
  parseDuration,
  parseValue,
  rateOver,
  type Scope,
  statsOf,
  subjectOf,
  totalOver,
  unitOf,
  within
} from "../Check.ts"
import { Predicate } from "effect"
import type * as Design from "../Design.ts"
import * as Fault from "../Fault.ts"
import type { AssertionResult, CheckProgress, DistSummary, Progress, Spec, Summary, TimelineEvent } from "../Scenario.ts"
import type { Frame, Stats } from "../Telemetry.ts"

/** A loose settings object, as a scenario writes them. */
export type Bag = Record<string, unknown>

/** `n` rounded to `digits` decimal places. */
export const round = (n: number, digits = 3): number => {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

/** An error's message, or the thing itself as text. */
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// ---------------------------------------------------------------------------------------------------------
// Reading what a scenario writes as text
// ---------------------------------------------------------------------------------------------------------

/** Deep merge: objects merge key by key, anything else replaces. */
export const merge = (base: Bag | undefined, over: Bag): Bag => {
  const out: Bag = { ...(base ?? {}) }
  for (const [k, v] of Object.entries(over)) out[k] = Predicate.isObject(v) && Predicate.isObject(out[k]) ? merge(out[k] as Bag, v) : v
  return out
}

/** The fault kind called `name`, in any case. */
const faultTag = (name: string): Fault.Fault["_tag"] | undefined => Fault.catalog.find((k) => k.tag.toLowerCase() === name.toLowerCase())?.tag

const noFault = (name: string): string => `no fault called "${name}" (${Fault.catalog.map((k) => k.tag).join(", ")})`

/** A fault as written in a scenario, as the fault schema's own JSON form. */
export const parseFault = (input: string | Bag): Bag | string => {
  if (typeof input === "string") {
    const m = /^\s*([A-Za-z]+)\s*(?:\(\s*([^)]*)\s*\))?\s*$/.exec(input)
    if (m === null) return `can't read the fault "${input}" (Outage, Blackhole, Slow(250ms), Errors(20%), Loss(10%), Crash(2))`
    const kind = m[1]!
    const arg = m[2]?.trim()
    const tag = faultTag(kind)
    if (tag === undefined) return noFault(kind)
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
  const tag = faultTag(name)
  if (tag === undefined) return noFault(name)
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

/** What a fault's `target` names: a node or edge of the design, a placement or one of its zones. */
export const parseTarget = (text: string, design: Design.Doc): Fault.Target | string => {
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

type AssertionInput = NonNullable<Spec["assert"]>[number]

/** An assertion as a scenario writes it (text, or an object with a name and a window), parsed. */
export const parseAssertionInput = (a: AssertionInput): Assertion | string =>
  typeof a === "string"
    ? parseAssertion(a)
    : parseAssertion(a.check, {
      ...(a.name === undefined ? {} : { name: a.name }),
      ...(a.from === undefined ? {} : { from: parseDuration(a.from) ?? 0 }),
      ...(a.to === undefined ? {} : { to: parseDuration(a.to) ?? 0 })
    })

/** A timeline event, in words, for the log. */
export const describe = (event: TimelineEvent): string => {
  if (event.note !== undefined) return event.note
  if (event.inject !== undefined) return `inject ${typeof event.inject.fault === "string" ? event.inject.fault : JSON.stringify(event.inject.fault)} on ${event.inject.target}${event.inject.for === undefined ? "" : ` for ${String(event.inject.for)}`}`
  if (event.clear !== undefined) return `clear ${event.clear === "all" ? "all faults" : `fault ${event.clear}`}`
  if (event.set !== undefined) return `set ${event.set.node === undefined ? `edge ${event.set.edge}` : `node ${event.set.node}`} ${JSON.stringify(event.set.settings)}`
  if (event.account !== undefined) return `set quotas of ${event.account.placement} ${JSON.stringify(event.account.settings)}`
  return "event"
}

/** What a timeline event does. */
export const kindOf = (event: TimelineEvent): Progress["timeline"][number]["kind"] =>
  event.inject !== undefined ? "inject" : event.clear !== undefined ? "clear" : event.set !== undefined ? "set" : event.account !== undefined ? "account" : "note"

// ---------------------------------------------------------------------------------------------------------
// Checking and preparing
// ---------------------------------------------------------------------------------------------------------

/** Every problem with a scenario against a design (`Scenario.check`). */
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
    const parsed = parseAssertionInput(a)
    if (typeof parsed === "string") issues.push(`assert: ${parsed}`)
    else if (parsed.subject.scope === "node" && !(parsed.subject.id in design.nodes)) issues.push(`assert: "${parsed.text}": no node "${parsed.subject.id}"`)
    else if (parsed.subject.scope === "edge" && !(parsed.subject.id in design.edges)) issues.push(`assert: "${parsed.text}": no edge "${parsed.subject.id}"`)
  }
  return issues
}

/** The design with the scenario's traffic scale and starting overrides applied (`Scenario.prepare`). */
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

// ---------------------------------------------------------------------------------------------------------
// The checks of a playback
// ---------------------------------------------------------------------------------------------------------

/**
 * A scenario's assertions over a run: the frames they read, kept as they arrive, and each one's value over its window.
 * A window that has closed is measured once and remembered.
 */
export class Checks {
  readonly windows: ReadonlyArray<{ readonly from: number; readonly to: number }>
  /** Only what the assertions read is kept, so a long live run doesn't hold every frame of a large design. */
  private readonly keep = { nodes: new Set<string>(), edges: new Set<string>() }
  private readonly recorded: Array<Frame> = []
  private readonly decided = new Map<number, number>()

  constructor(
    readonly assertions: ReadonlyArray<Assertion>,
    private readonly clients: ReadonlyArray<string>,
    warmup: number,
    private readonly duration: number
  ) {
    this.windows = assertions.map((a) => ({ from: a.from ?? warmup, to: a.to ?? duration }))
    for (const a of assertions) for (const id of subjectOf(a, clients).nodes) this.keep[a.subject.scope === "edge" ? "edges" : "nodes"].add(id)
  }

  /** Keep what the checks will measure from new frames. */
  record(frames: ReadonlyArray<Frame>): void {
    if (this.keep.nodes.size === 0 && this.keep.edges.size === 0) return
    for (const f of frames) this.recorded.push({ ...f, nodes: pick(f.nodes, this.keep.nodes), edges: pick(f.edges, this.keep.edges) })
  }

  /** An assertion's value over its window up to `now`, and whether that window has closed. */
  measureAt(i: number, now: number): { readonly actual: number; readonly closed: boolean } | undefined {
    const final = this.decided.get(i)
    if (final !== undefined) return { actual: final, closed: true }
    const { from, to } = this.windows[i]!
    if (now <= from) return undefined
    const closed = now >= to
    const actual = evaluate(this.assertions[i]!, within(this.recorded, from, Math.min(now, to)), this.clients)
    if (closed) this.decided.set(i, actual)
    return { actual, closed }
  }

  /** Every assertion's verdict. Final once the end is reached. */
  results(): ReadonlyArray<AssertionResult> {
    return this.assertions.map((a, i) => {
      const actual = this.measureAt(i, Math.max(this.duration, this.windows[i]!.to))?.actual ?? 0
      return { check: a.text, name: a.name, passed: compare(actual, a.op, a.value), actual: round(actual, 6), expected: { op: a.op, value: a.value }, window: this.windows[i]! }
    })
  }

  /** How each assertion stands at `now`. */
  progress(now: number): ReadonlyArray<CheckProgress> {
    return this.assertions.map((a, i): CheckProgress => {
      const m = this.measureAt(i, now)
      const base = {
        check: a.text,
        ...(a.name === undefined ? {} : { name: a.name }),
        window: this.windows[i]!,
        expected: { op: a.op, value: a.value },
        unit: unitOf(a.metric)
      }
      if (m === undefined) return { ...base, state: "waiting" }
      const ok = compare(m.actual, a.op, a.value)
      return { ...base, actual: round(m.actual, 6), state: m.closed ? (ok ? "passed" : "failed") : ok ? "holding" : "breaking" }
    })
  }
}

const pick = (stats: Frame["nodes"], ids: ReadonlySet<string>) => {
  const out: Record<string, Frame["nodes"][string]> = {}
  for (const id of ids) if (stats[id] !== undefined) out[id] = stats[id]
  return out
}

// ---------------------------------------------------------------------------------------------------------
// Summarising a run
// ---------------------------------------------------------------------------------------------------------

/** What one node or edge (or several together) did over `frames`. */
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

/** Every node's and edge's summary over the measured frames, and the system's: every client together. */
export const summaries = (
  measured: ReadonlyArray<Frame>,
  design: Design.Doc,
  registry: { readonly get: (type: string) => { readonly inputs: boolean } | undefined }
): { readonly system: Summary; readonly nodes: Record<string, Summary>; readonly edges: Record<string, Summary> } => {
  const nodes: Record<string, Summary> = {}
  for (const [id, n] of Object.entries(design.nodes)) nodes[id] = summarise(measured, "nodes", [id], { type: n.type, name: n.name ?? id })
  const edges: Record<string, Summary> = {}
  for (const id of Object.keys(design.edges)) edges[id] = summarise(measured, "edges", [id])
  return { system: summarise(measured, "nodes", clientIds(design, registry)), nodes, edges }
}
