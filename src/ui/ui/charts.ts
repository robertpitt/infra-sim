import type { Frame, Stats } from "../state/types.ts"
import { fmtCount, fmtMs, fmtRate } from "../lib/format.ts"
import type { Selection } from "../state/document.ts"
import type { DocState } from "../state/document.ts"
import { history } from "../state/run.ts"

export interface Point {
  readonly t: number
  readonly v: number
}

export interface Series {
  readonly key: string
  readonly label: string
  readonly color: string
  readonly points: ReadonlyArray<Point>
  readonly dashed?: boolean
}

export interface ChartSpec {
  readonly id: string
  readonly title: string
  readonly format: (n: number) => string
  readonly series: ReadonlyArray<Series>
}

const C = {
  in: "#5aa2ff",
  ok: "#3ecf9a",
  fail: "#ff6b6b",
  warn: "#f2b84b",
  violet: "#a478f0",
  teal: "#35c4d6"
}

const MAX_POINTS = 360

/** Reduce to at most MAX_POINTS by averaging blocks, so long windows stay cheap and smooth. */
const thin = (points: Array<Point>): Array<Point> => {
  if (points.length <= MAX_POINTS) return points
  const stride = Math.ceil(points.length / MAX_POINTS)
  const out: Array<Point> = []
  for (let i = 0; i < points.length; i += stride) {
    const block = points.slice(i, i + stride)
    out.push({ t: block[block.length - 1]!.t, v: block.reduce((s, p) => s + p.v, 0) / block.length })
  }
  return out
}

/** Trailing moving average over this many 250ms frames (one second): per-window rates are too noisy to read raw. */
const SMOOTH = 4

const extract = (frames: ReadonlyArray<Frame>, read: (f: Frame) => number | undefined, smooth = SMOOTH): Array<Point> => {
  const raw = frames.map((f) => ({ t: f.t, v: read(f) }))
  const out: Array<Point> = []
  raw.forEach((p, i) => {
    if (p.v === undefined) return
    let sum = 0
    let n = 0
    for (let j = Math.max(0, i - smooth + 1); j <= i; j++) {
      const v = raw[j]!.v
      if (v !== undefined) {
        sum += v
        n++
      }
    }
    out.push({ t: p.t, v: sum / n })
  })
  return thin(out)
}

type Scope = "nodes" | "edges"
const stat = (f: Frame, scope: Scope, id: string): Stats | undefined => f[scope][id]
const rate = (scope: Scope, id: string, key: string) => (f: Frame) => stat(f, scope, id)?.rates[key] ?? 0
const gauge = (scope: Scope, id: string, key: string) => (f: Frame) => stat(f, scope, id)?.gauges[key]
const dist = (scope: Scope, id: string, key: string, q: "p50" | "p95" | "p99") => (f: Frame) => stat(f, scope, id)?.dist[key]?.[q]

const latencySeries = (frames: ReadonlyArray<Frame>, scope: Scope, id: string): ChartSpec => ({
  id: "latency",
  title: "Latency",
  format: fmtMs,
  series: [
    { key: "p50", label: "p50", color: C.in, points: extract(frames, dist(scope, id, "latency", "p50")) },
    { key: "p95", label: "p95", color: C.warn, points: extract(frames, dist(scope, id, "latency", "p95")) },
    { key: "p99", label: "p99", color: C.fail, points: extract(frames, dist(scope, id, "latency", "p99")) }
  ]
})

const GAUGE_TITLES: Record<string, [string, (n: number) => string]> = {
  depth: ["Queue depth", fmtCount],
  oldestAgeMs: ["Oldest message", fmtMs],
  utilization: ["Worker utilisation", (n) => `${Math.round(n * 100)}%`],
  waiting: ["Waiting for a worker", fmtCount],
  busy: ["Busy workers", fmtCount],
  tokens: ["Burst capacity left", fmtCount],
  hidden: ["Messages in flight", fmtCount],
  inflight: ["In flight", fmtCount]
}

export const chartsFor = (selection: Selection | undefined, doc: DocState, windowMs: number, now: number, sources: ReadonlyArray<string>, highlights: ReadonlyArray<string>): ReadonlyArray<ChartSpec> => {
  const tMin = Math.max(now, windowMs) - windowMs
  const frames = history.since((f) => f.t >= tMin)
  if (frames.length === 0) return []

  if (selection?.kind === "edge") {
    const id = selection.id
    return [
      {
        id: "calls",
        title: "Calls per second",
        format: fmtRate,
        series: [
          { key: "calls", label: "attempts", color: C.in, points: extract(frames, rate("edges", id, "calls")) },
          { key: "ok", label: "ok", color: C.ok, points: extract(frames, rate("edges", id, "ok")) },
          { key: "fail", label: "failed", color: C.fail, points: extract(frames, rate("edges", id, "fail")) },
          { key: "retries", label: "retries", color: C.warn, points: extract(frames, rate("edges", id, "retries")), dashed: true }
        ]
      },
      {
        id: "latency",
        title: "Latency per attempt",
        format: fmtMs,
        series: [
          { key: "p50", label: "p50", color: C.in, points: extract(frames, dist("edges", id, "latency", "p50")) },
          { key: "p95", label: "p95", color: C.warn, points: extract(frames, dist("edges", id, "latency", "p95")) },
          { key: "p99", label: "p99", color: C.fail, points: extract(frames, dist("edges", id, "latency", "p99")) }
        ]
      },
      {
        id: "inflight",
        title: "In flight",
        format: fmtCount,
        series: [{ key: "inflight", label: "in flight", color: C.violet, points: extract(frames, gauge("edges", id, "inflight"), 1) }]
      }
    ]
  }

  if (selection?.kind === "node") {
    const id = selection.id
    const isSource = sources.includes(id)
    const charts: Array<ChartSpec> = [
      {
        id: "rate",
        title: "Requests per second",
        format: fmtRate,
        series: [
          { key: "in", label: isSource ? "sent" : "arriving", color: C.in, points: extract(frames, rate("nodes", id, isSource ? "sent" : "in")) },
          { key: "ok", label: "ok", color: C.ok, points: extract(frames, rate("nodes", id, "ok")) },
          { key: "fail", label: "failed", color: C.fail, points: extract(frames, rate("nodes", id, "fail")) }
        ]
      },
    ]
    // Components that answer instantly (queues acknowledging a send) would just chart noise below 1ms.
    const latency = latencySeries(frames, "nodes", id)
    if (Math.max(0, ...latency.series.flatMap((s) => s.points.map((p) => p.v))) >= 1.5) charts.push(latency)
    const wanted = highlights.length > 0 ? highlights : ["inflight"]
    for (const key of wanted.slice(0, 2)) {
      const [title, format] = GAUGE_TITLES[key] ?? [key, fmtCount]
      charts.push({ id: key, title, format, series: [{ key, label: title, color: C.violet, points: extract(frames, gauge("nodes", id, key), 1) }] })
    }
    return charts
  }

  // Overview across every traffic source and every queue.
  const sum = (key: string, ids: ReadonlyArray<string>) => (f: Frame) => ids.reduce((s, id) => s + (f.nodes[id]?.rates[key] ?? 0), 0)
  const queues = Object.entries(doc.design.nodes).filter(([, n]) => n.type === "queue").map(([id]) => id)
  const charts: Array<ChartSpec> = []
  if (sources.length > 0) {
    charts.push({
      id: "offered",
      title: "Client requests per second",
      format: fmtRate,
      series: [
        { key: "sent", label: "sent", color: C.in, points: extract(frames, sum("sent", sources)) },
        { key: "ok", label: "ok", color: C.ok, points: extract(frames, sum("ok", sources)) },
        { key: "fail", label: "failed", color: C.fail, points: extract(frames, sum("fail", sources)) }
      ]
    })
    const p = (q: "p50" | "p95" | "p99") => (f: Frame) => {
      const vals = sources.flatMap((id) => (f.nodes[id]?.dist.latency?.[q] === undefined ? [] : [f.nodes[id]!.dist.latency![q]]))
      return vals.length === 0 ? undefined : Math.max(...vals)
    }
    charts.push({
      id: "e2e",
      title: "Client latency (worst client)",
      format: fmtMs,
      series: [
        { key: "p50", label: "p50", color: C.in, points: extract(frames, p("p50")) },
        { key: "p95", label: "p95", color: C.warn, points: extract(frames, p("p95")) },
        { key: "p99", label: "p99", color: C.fail, points: extract(frames, p("p99")) }
      ]
    })
  }
  if (queues.length > 0) {
    charts.push({
      id: "backlog",
      title: "Queue backlog",
      format: fmtCount,
      series: queues.map((id, i) => ({
        key: id,
        label: doc.design.nodes[id]?.name ?? id,
        color: [C.violet, C.teal, C.warn, C.in][i % 4]!,
        points: extract(frames, gauge("nodes", id, "depth"), 1)
      }))
    })
  }
  return charts
}
