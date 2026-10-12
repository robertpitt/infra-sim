import { Dashboard } from "#simulator"
import type { Frame, Stats } from "../state/types.ts"
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
  readonly unit: Dashboard.Unit
  readonly series: ReadonlyArray<Series>
  /** The CloudWatch metrics the chart stands for. */
  readonly cloudwatch?: ReadonlyArray<string>
  readonly help?: string
}

export const TONE: Record<Dashboard.Tone, string> = {
  primary: "#5aa2ff",
  ok: "#3ecf9a",
  bad: "#ff6b6b",
  warn: "#f2b84b",
  accent: "#a478f0",
  teal: "#35c4d6",
  muted: "#8995a8"
}

// ---------------------------------------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------------------------------------

/** Points per chart at most: one per pixel or two on a wide screen, and cheap to redraw sixteen times a second. */
const MAX_POINTS = 300
const BUCKETS = [1_000, 2_000, 4_000, 5_000, 10_000]

/**
 * How long one point stands for. Each point is the average of the frames in a stretch of time aligned to the clock (the
 * second from 1:02 to 1:03, not "the fourth point from the start of the window"), so a point never changes once its
 * stretch is over, and the lines don't wobble as the window slides. A second is the least: frames are a quarter of a
 * second, too noisy to read on their own.
 */
export const bucketMsFor = (windowMs: number): number => BUCKETS.find((b) => windowMs / b <= MAX_POINTS) ?? BUCKETS[BUCKETS.length - 1]!

/** Frames grouped by bucket, only complete buckets: the one still filling would jump about as its frames arrive. */
const bucketsOf = (frames: ReadonlyArray<Frame>, bucketMs: number): ReadonlyArray<{ readonly t: number; readonly frames: ReadonlyArray<Frame> }> => {
  const out: Array<{ t: number; frames: Array<Frame> }> = []
  const last = frames[frames.length - 1]
  if (last === undefined) return out
  // A frame ending at t covers (t - dt, t]: it belongs to the bucket its end falls in, the bucket ending at or after t.
  const complete = Math.floor(last.t / bucketMs) * bucketMs
  for (const f of frames) {
    if (f.t > complete) break
    const end = Math.ceil(f.t / bucketMs) * bucketMs
    const tail = out[out.length - 1]
    if (tail !== undefined && tail.t === end) tail.frames.push(f)
    else out.push({ t: end, frames: [f] })
  }
  return out
}

type Scope = "nodes" | "edges"

/**
 * One line's points: the metric over each bucket. A rate is averaged over the last few buckets too (`smooth`): arrivals
 * are random, so a second's count wobbles by its square root, and CloudWatch's minute-long periods never show that.
 */
const pointsOf = (
  buckets: ReadonlyArray<{ readonly t: number; readonly frames: ReadonlyArray<Frame> }>,
  read: (frames: ReadonlyArray<Frame>) => number | undefined,
  smooth = 1
): ReadonlyArray<Point> => {
  const out: Array<Point> = []
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i]!
    const v = smooth <= 1 ? read(b.frames) : read(buckets.slice(Math.max(0, i - smooth + 1), i + 1).flatMap((x) => x.frames))
    if (v !== undefined && Number.isFinite(v)) out.push({ t: b.t, v })
  }
  return out
}

/**
 * Buckets a line is averaged over: three seconds' worth at the finest, one bucket once buckets are long enough. Rates,
 * shares (utilization, hit rates) and durations wobble from one second to the next; a level (`count`: tasks, messages
 * visible) is left sharp, so a step shows as a step.
 */
const smoothingFor = (unit: Dashboard.Unit, bucketMs: number): number => (unit === "count" ? 1 : Math.max(1, Math.round(3_000 / bucketMs)))

const statsOf = (frames: ReadonlyArray<Frame>, scope: Scope, id: string): ReadonlyArray<Stats | undefined> => frames.map((f) => f[scope][id])

// ---------------------------------------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------------------------------------

/** A dashboard's panels as charts of one node or edge. */
const panelsOf = (
  panels: ReadonlyArray<Dashboard.Panel>,
  scope: Scope,
  id: string,
  buckets: ReadonlyArray<{ readonly t: number; readonly frames: ReadonlyArray<Frame> }>,
  bucketMs: number
): ReadonlyArray<ChartSpec> => {
  const latest = buckets[buckets.length - 1]?.frames.at(-1)?.[scope][id]
  return panels.filter((p) => Dashboard.applies(p, latest)).map((p) => ({
    id: p.id,
    title: p.title,
    unit: p.unit,
    ...(p.cloudwatch === undefined ? {} : { cloudwatch: p.cloudwatch }),
    ...(p.help === undefined ? {} : { help: p.help }),
    series: Dashboard.linesFor(p, latest).map((line, i) => ({
      key: `${i}:${line.label}`,
      label: line.label,
      color: TONE[line.tone ?? (["primary", "ok", "bad", "warn", "accent", "teal"] as const)[i % 6]!],
      points: pointsOf(buckets, (frames) => Dashboard.valueOver(line.metric, statsOf(frames, scope, id), "mean"), smoothingFor(p.unit, bucketMs)),
      ...(line.dashed ? { dashed: true } : {})
    }))
  }))
}

/** What to chart for what is selected: a node's dashboard, an edge's (transport's and its connector's), or the whole design. */
export const chartsFor = (
  selection: Selection | undefined,
  doc: DocState,
  windowMs: number,
  now: number,
  sources: ReadonlyArray<string>,
  dashboards: { readonly node: (id: string) => Dashboard.Dashboard | undefined; readonly edge: (id: string) => ReadonlyArray<Dashboard.Panel> }
): ReadonlyArray<ChartSpec> => {
  const bucketMs = bucketMsFor(windowMs)
  const tMin = Math.max(now, windowMs) - windowMs - bucketMs
  const buckets = bucketsOf(history.since((f) => f.t > tMin), bucketMs)
  if (buckets.length === 0) return []

  if (selection?.kind === "edge") return panelsOf(dashboards.edge(selection.id), "edges", selection.id, buckets, bucketMs)
  if (selection?.kind === "node") return panelsOf(dashboards.node(selection.id)?.panels ?? [], "nodes", selection.id, buckets, bucketMs)

  // The whole design: what its clients see, and every queue's backlog.
  const total = (key: string) => (frames: ReadonlyArray<Frame>) =>
    frames.reduce((sum, f) => sum + sources.reduce((s, id) => s + (f.nodes[id]?.rates[key] ?? 0), 0), 0) / frames.length
  const worst = (q: Dashboard.DistStat) => (frames: ReadonlyArray<Frame>) => {
    let max: number | undefined
    for (const id of sources) {
      const v = Dashboard.valueOver(Dashboard.dist("latency", q), statsOf(frames, "nodes", id))
      if (v !== undefined) max = max === undefined ? v : Math.max(max, v)
    }
    return max
  }
  const queues = Object.entries(doc.design.nodes).filter(([, n]) => n.type === "aws.sqs").map(([id]) => id)
  const charts: Array<ChartSpec> = []
  if (sources.length > 0) {
    charts.push({
      id: "offered",
      title: "Client requests",
      unit: "perSecond",
      series: [
        { key: "sent", label: "sent", color: TONE.primary, points: pointsOf(buckets, total("sent"), smoothingFor("perSecond", bucketMs)) },
        { key: "ok", label: "ok", color: TONE.ok, points: pointsOf(buckets, total("ok"), smoothingFor("perSecond", bucketMs)) },
        { key: "fail", label: "failed", color: TONE.bad, points: pointsOf(buckets, total("fail"), smoothingFor("perSecond", bucketMs)) }
      ]
    })
    charts.push({
      id: "e2e",
      title: "Client latency (worst client)",
      unit: "ms",
      series: [
        { key: "p50", label: "p50", color: TONE.primary, points: pointsOf(buckets, worst("p50"), smoothingFor("ms", bucketMs)) },
        { key: "p95", label: "p95", color: TONE.warn, points: pointsOf(buckets, worst("p95"), smoothingFor("ms", bucketMs)) },
        { key: "p99", label: "p99", color: TONE.bad, points: pointsOf(buckets, worst("p99"), smoothingFor("ms", bucketMs)) }
      ]
    })
  }
  if (queues.length > 0) {
    charts.push({
      id: "backlog",
      title: "Queue backlog",
      unit: "count",
      cloudwatch: ["ApproximateNumberOfMessagesVisible"],
      series: queues.slice(0, 6).map((id, i) => ({
        key: id,
        label: doc.design.nodes[id]?.name ?? id,
        color: [TONE.accent, TONE.teal, TONE.warn, TONE.primary, TONE.ok, TONE.muted][i]!,
        points: pointsOf(buckets, (frames) => Dashboard.valueOver(Dashboard.gauge("depth"), statsOf(frames, "nodes", id), "mean"))
      }))
    })
  }
  return charts
}

/** The frames a key figure is read over: the last two seconds, so the big numbers are steady enough to read. */
export const FIGURE_FRAMES = 8
