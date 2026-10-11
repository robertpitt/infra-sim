import type { Component, Connector, Controller, Describe, ImportReport, Scenario, Telemetry } from "#simulator"

/** Plain-text output. Colour only when asked for, and never required to read it. */

export interface Style {
  readonly bold: (s: string) => string
  readonly dim: (s: string) => string
  readonly red: (s: string) => string
  readonly green: (s: string) => string
  readonly yellow: (s: string) => string
}

export const makeStyle = (color: boolean): Style => {
  const wrap = (open: number, close: number) => (s: string) => (color ? `\u001b[${open}m${s}\u001b[${close}m` : s)
  return { bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39) }
}

// -- Numbers ----------------------------------------------------------------------------------------------

export const fmtMs = (ms: number): string => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : ms >= 10 ? `${Math.round(ms)}ms` : `${ms.toFixed(1)}ms`)
export const fmtRate = (n: number): string => (n === 0 ? "0" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n >= 100 ? `${Math.round(n)}` : n >= 1 ? n.toFixed(1) : n >= 0.01 ? n.toFixed(2) : n.toExponential(1))
export const fmtPct = (r: number): string => (r === 0 ? "0%" : r < 0.001 ? "<0.1%" : `${(r * 100).toFixed(r < 0.1 ? 1 : 0)}%`)
export const fmtCount = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(0)}k` : String(Math.round(n)))
export const fmtDuration = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${Number(s.toFixed(1))}s`
  const m = Math.floor(s / 60)
  const rest = Math.round(s % 60)
  return m < 60 ? `${m}m${rest === 0 ? "" : `${rest}s`}` : `${Math.floor(m / 60)}h${m % 60 === 0 ? "" : `${m % 60}m`}`
}

/** A value in the unit its assertion was written in, so a failure reads like the expectation. */
export const fmtMeasured = (check: string, value: number): string =>
  /errorRatio|successRatio/.test(check) ? fmtPct(value) : /latency|dist\./.test(check) ? fmtMs(value) : fmtRate(value)

// -- Tables -----------------------------------------------------------------------------------------------

export const table = (rows: ReadonlyArray<ReadonlyArray<string>>, align: ReadonlyArray<"l" | "r"> = [], gap = 2): string => {
  const widths = rows[0]?.map((_, c) => Math.max(...rows.map((r) => stripAnsi(r[c] ?? "").length))) ?? []
  return rows
    .map((row) =>
      row
        .map((cell, c) => {
          const pad = " ".repeat(Math.max(0, (widths[c] ?? 0) - stripAnsi(cell).length))
          return c === row.length - 1 && align[c] !== "r" ? cell : align[c] === "r" ? pad + cell : cell + pad
        })
        .join(" ".repeat(gap))
        .trimEnd()
    )
    .join("\n")
}

const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "")

// -- A run ------------------------------------------------------------------------------------------------

interface Result {
  readonly scenario: string | undefined
  readonly seed: number
  readonly duration: number
  readonly warmup: number
  readonly wallMs: number
  readonly passed: boolean
  readonly system: Summary
  readonly nodes: Readonly<Record<string, Summary>>
  readonly timeline: ReadonlyArray<{ readonly at: number; readonly what: string }>
  readonly faults: ReadonlyArray<{ readonly id: string; readonly target: string; readonly fault: string; readonly from: number; readonly to: number | undefined }>
  readonly assertions: ReadonlyArray<{ readonly check: string; readonly name: string | undefined; readonly passed: boolean; readonly actual: number | undefined; readonly expected: { readonly op: string; readonly value: number }; readonly problem?: string }>
  readonly alerts: ReadonlyArray<{ readonly severity: string; readonly title: string; readonly target: { readonly id: string }; readonly unit: string; readonly firedAt: number; readonly resolvedAt?: number; readonly peak: number }>
  readonly defects: ReadonlyArray<{ readonly t: number; readonly node: string; readonly message: string }>
}
type Summary = Scenario.Summary

const fmtUnit = (unit: string, v: number): string =>
  unit === "ratio" ? fmtPct(v) : unit === "ms" ? fmtMs(v) : unit === "rate" ? `${fmtRate(v)}/s` : fmtCount(v)

/** What went wrong at a node, in a few words: its throttles and failures by kind, and any deep backlog. */
const notes = (s: Summary): string => {
  const parts: Array<string> = []
  for (const [k, v] of Object.entries(s.rates)) if (k.startsWith("fail.") && v >= 0.05) parts.push(`${k.slice(5)} ${fmtRate(v)}/s`)
  for (const g of ["depth", "concurrent"]) {
    const gauge = s.gauges[g]
    if (gauge !== undefined && gauge.max > 0 && (g === "depth" ? gauge.max >= 10 : false)) parts.push(`${g} max ${fmtCount(gauge.max)}`)
  }
  return parts.slice(0, 4).join(", ")
}

export const renderResult = (result: Result, style: Style, options: { readonly nodes?: number } = {}): string => {
  const out: Array<string> = []
  const speed = result.wallMs > 0 ? Math.round(result.duration / result.wallMs) : 0
  out.push(
    style.bold(result.scenario ?? "Simulation") +
      style.dim(` · seed ${result.seed} · ${fmtDuration(result.duration)} simulated in ${fmtDuration(result.wallMs)} (${speed}x)${result.warmup > 0 ? ` · measured after ${fmtDuration(result.warmup)}` : ""}`)
  )
  out.push("")
  const sys = result.system
  const lat = sys.dist.latency
  out.push(
    `${style.bold("System")}  sent ${fmtRate(sys.rates.sent ?? 0)}/s  ok ${fmtRate(sys.rates.ok ?? 0)}/s  failed ${fmtRate(sys.rates.fail ?? 0)}/s  errors ${colorRatio(sys.errorRatio, style)}` +
      (lat === undefined ? "" : `  latency p50 ${fmtMs(lat.p50)}  p95 ${fmtMs(lat.p95)}  p99 ${fmtMs(lat.p99)}`)
  )

  const rows = Object.entries(result.nodes)
    .filter(([, s]) => (s.rates.in ?? 0) > 0 || (s.rates.sent ?? 0) > 0)
    .sort((a, b) => (b[1].rates.in ?? b[1].rates.sent ?? 0) - (a[1].rates.in ?? a[1].rates.sent ?? 0))
  const shown = rows.slice(0, options.nodes ?? 20)
  if (shown.length > 0) {
    out.push("")
    out.push(style.bold(`Nodes${rows.length > shown.length ? ` (top ${shown.length} of ${rows.length} by traffic)` : ""}`))
    out.push(
      table(
        [
          ["node", "type", "in/s", "errors", "p95", "notes"].map((h) => style.dim(h)),
          ...shown.map(([id, s]) => [
            id,
            (s.type ?? "").replace(/^(aws|common)\./, ""),
            fmtRate(s.rates.in ?? s.rates.sent ?? 0),
            colorRatio(s.errorRatio, style),
            s.dist.latency === undefined ? "" : fmtMs(s.dist.latency.p95),
            notes(s)
          ])
        ],
        ["l", "l", "r", "r", "r", "l"]
      )
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n")
    )
  }

  if (result.timeline.length > 0) {
    out.push("")
    out.push(style.bold("Timeline"))
    for (const e of result.timeline) out.push(`  ${fmtDuration(e.at).padStart(6)}  ${e.what}`)
  }

  // What would have paged someone. Worth knowing, but not a verdict: only assertions pass or fail a run.
  if (result.alerts.length > 0) {
    out.push("")
    out.push(style.bold(`Alerts (${result.alerts.length})`))
    const byTime = [...result.alerts].sort((a, b) => a.firedAt - b.firedAt)
    out.push(
      table(
        [
          ["fired", "cleared", "severity", "node", "alert", "worst"].map((h) => style.dim(h)),
          ...byTime.map((a) => [
            fmtDuration(a.firedAt),
            a.resolvedAt === undefined ? "still firing" : fmtDuration(a.resolvedAt),
            a.severity === "critical" ? style.red(a.severity) : style.yellow(a.severity),
            a.target.id,
            a.title,
            fmtUnit(a.unit, a.peak)
          ])
        ],
        ["r", "r", "l", "l", "l", "r"]
      )
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n")
    )
  }

  if (result.assertions.length > 0) {
    out.push("")
    out.push(style.bold("Assertions"))
    for (const a of result.assertions) {
      const mark = a.passed ? style.green("✔") : style.red("✘")
      const label = a.name === undefined ? a.check : `${a.name} (${a.check})`
      const measured = a.actual === undefined ? "" : `  ${style.dim(a.passed ? "measured" : "measured")} ${fmtMeasured(a.check, a.actual)}`
      out.push(`  ${mark} ${label}${a.problem === undefined ? measured : `  ${style.red(a.problem)}`}`)
    }
  }
  if (result.defects.length > 0) {
    out.push("")
    out.push(style.red(style.bold(`Components that crashed (${result.defects.length})`)))
    for (const d of result.defects.slice(0, 5)) out.push(`  ${fmtDuration(d.t)}  ${d.node}: ${d.message}`)
  }
  out.push("")
  out.push(result.passed ? style.green(style.bold("PASS")) : style.red(style.bold("FAIL")))
  return `${out.join("\n")}\n`
}

const colorRatio = (r: number, style: Style): string => {
  const text = fmtPct(r)
  return r > 0.2 ? style.red(text) : r > 0.02 ? style.yellow(text) : text
}

/** Every frame as long-format CSV (t, scope, id, metric, value): one table every plotting tool can read. */
export const renderFrames = (frames: ReadonlyArray<Telemetry.Frame>): string => {
  const lines = ["t_ms,scope,id,metric,value"]
  for (const f of frames) {
    for (const scope of ["nodes", "edges"] as const) {
      for (const [id, s] of Object.entries(f[scope])) {
        const kind = scope === "nodes" ? "node" : "edge"
        for (const [k, v] of Object.entries(s.rates)) lines.push(`${f.t},${kind},${csv(id)},rate.${csv(k)},${v}`)
        for (const [k, v] of Object.entries(s.gauges)) lines.push(`${f.t},${kind},${csv(id)},gauge.${csv(k)},${v}`)
        for (const [k, d] of Object.entries(s.dist)) for (const stat of ["mean", "p50", "p95", "p99", "max"] as const) lines.push(`${f.t},${kind},${csv(id)},${csv(k)}.${stat},${d[stat]}`)
      }
    }
  }
  return `${lines.join("\n")}\n`
}

const csv = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)

// -- Import reports and diagnostics -----------------------------------------------------------------------

export const renderImportReport = (report: ImportReport, style: Style): string => {
  const out: Array<string> = []
  const loud = report.skipped.filter((s) => !s.quiet)
  const quiet = report.skipped.length - loud.length
  out.push(
    style.bold(`Imported (${report.importer}): `) +
      `${report.converted.length} resources became components, ${report.settings.preserved} settings carried over, ${report.connections.declared + report.connections.inferred} connections (${report.connections.inferred} inferred)`
  )
  const list = (title: string, items: ReadonlyArray<string>, tone: (s: string) => string = (s) => s) => {
    if (items.length === 0) return
    out.push("")
    out.push(style.bold(title))
    for (const item of items) out.push(`  ${tone("-")} ${item}`)
  }
  list(`Worth a look (${report.warnings.length})`, report.warnings, style.yellow)
  list("Added, because the source doesn't say", report.added)
  list("Settings that didn't carry over as written", [...report.settings.adjusted, ...report.settings.unresolved.map((u) => `${u}; kept the default`)], style.yellow)
  list(`Left out: no component yet (${loud.length})`, loud.map((s) => `${s.id} (${s.type}): ${s.reason}`))
  if (quiet > 0) out.push(style.dim(`\n${quiet} more left out because they don't change behaviour under load (permissions, logging, ...)`))
  return `${out.join("\n")}\n`
}

export const renderDiagnostics = (diagnostics: ReadonlyArray<{ readonly level: string; readonly code: string; readonly message: string }>, style: Style): string =>
  diagnostics
    .map((d) => `${d.level === "error" ? style.red("error  ") : d.level === "warning" ? style.yellow("warning") : style.dim("info   ")} ${d.message} ${style.dim(`[${d.code}]`)}`)
    .join("\n")

// -- Components -------------------------------------------------------------------------------------------

type Field = Describe.FieldSpec

const flatten = (fields: ReadonlyArray<Field>, prefix = ""): ReadonlyArray<{ readonly path: string; readonly spec: Exclude<Field, { kind: "group" }> }> =>
  fields.flatMap((f) => (f.kind === "group" ? flatten(f.fields, `${prefix}${f.key}.`) : [{ path: `${prefix}${f.key}`, spec: f }]))

const range = (spec: Exclude<Field, { kind: "group" }>): string => {
  if (spec.kind === "choice") return spec.options.map((o) => o.value).join(" | ")
  if (spec.kind === "boolean") return "true | false"
  if (spec.kind === "text") return "text"
  const unit = spec.kind === "duration" ? "ms" : (spec.unit ?? "")
  return spec.min === undefined && spec.max === undefined ? "" : `${spec.min ?? ""}..${spec.max ?? ""}${unit === "" ? "" : ` ${unit}`}`
}

const limitKind = (spec: Exclude<Field, { kind: "group" }>): string =>
  spec.kind === "choice" || spec.kind === "boolean" || spec.kind === "text" ? "" : (spec.limit?.kind ?? "")

/** A settings table, indented, under a heading. Nothing at all for no settings. */
const settingsBlock = (fields: ReadonlyArray<Field>, style: Style, heading = "Settings"): Array<string> => {
  const settings = flatten(fields)
  if (settings.length === 0) return []
  return [
    "",
    style.bold(heading) + style.dim("  (durations are milliseconds in ranges; write them as \"30 seconds\" or a number of ms)"),
    table(
      [
        ["setting", "default", "range", "limit"].map((h) => style.dim(h)),
        ...settings.map(({ path, spec }) => [path, String(spec.default), range(spec), limitKind(spec)])
      ],
      ["l", "l", "l", "l"]
    )
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n")
  ]
}

export const renderComponent = (m: Component.Manifest, style: Style): string => {
  const out: Array<string> = []
  out.push(`${style.bold(m.type)}  ${m.title}`)
  out.push(m.description)
  if (m.docs !== undefined) out.push(style.dim(m.docs))
  out.push(...settingsBlock(m.settings, style))
  if (m.outputs.length > 0) {
    out.push("")
    out.push(style.bold("Ports") + style.dim("  (an edge leaves from a port)"))
    for (const o of m.outputs) {
      const own = flatten(o.settings).map((f) => f.path)
      const how = o.protocol === "pull" ? " (pull: whatever is wired here takes from it)" : o.many ? "" : " (one connection)"
      out.push(`  ${o.port}  ${o.label}${how}${own.length > 0 ? `  edge settings: ${own.join(", ")}` : ""}`)
    }
  }
  if (m.limits.length > 0) {
    out.push("")
    out.push(style.bold("Service limits"))
    for (const l of m.limits) out.push(`  ${l.label}: ${l.value} ${style.dim(l.adjustable ? "(quota)" : "(hard)")}`)
  }
  if (m.container !== undefined) out.push(`\nA container: draws a box round ${m.container.accepts.join(", ")}${m.container.decidesRegion ? "; its region decides where they run" : ""}.`)
  return `${out.join("\n")}\n`
}

/** One controller: what it can be attached to, and its settings. */
export const renderController = (m: Controller.Manifest, style: Style): string => {
  const out: Array<string> = []
  out.push(`${style.bold(m.type)}  ${m.title}  ${style.dim("(a controller: attach it to a node under controllers:)")}`)
  if (m.description !== "") out.push(m.description)
  if (m.docs !== undefined) out.push(style.dim(m.docs))
  out.push(`Controls: ${m.targets === undefined ? "any component" : m.targets.join(", ")}`)
  out.push(...settingsBlock(m.settings, style))
  return `${out.join("\n")}\n`
}

/** One connector: what it fits between, and its own settings (an edge adds its port's before them and transport's after). */
export const renderConnector = (m: Connector.Manifest, transport: ReadonlyArray<Field>, style: Style): string => {
  const end = (component: string | undefined, port: string | undefined, protocol: string) =>
    `${component ?? `any ${protocol} port`}${port === undefined ? "" : `:${port}`}`
  const out: Array<string> = []
  out.push(`${style.bold(m.type)}  ${m.title}  ${style.dim("(a connector: it sits on an edge)")}`)
  if (m.description !== "") out.push(m.description)
  if (m.docs !== undefined) out.push(style.dim(m.docs))
  out.push(`Fits: ${end(m.from.component, m.from.port, m.from.protocol)} → ${m.to.component ?? `anything that accepts ${m.to.protocol}`}`)
  out.push(...settingsBlock(m.settings, style))
  out.push(...settingsBlock(transport, style, "Transport"))
  return `${out.join("\n")}\n`
}
