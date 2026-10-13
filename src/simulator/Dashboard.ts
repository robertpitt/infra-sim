import type { Stats } from "./Telemetry.ts"

/**
 * What a component's (or a connector's) metrics look like on screen: a few key figures, and the charts an operator
 * would put on its dashboard. Each service mirrors the metrics AWS publishes for it in CloudWatch (DynamoDB's consumed
 * capacity and throttle events, Lambda's invocations, errors, throttles and concurrency, SQS's visible messages and age
 * of the oldest), named the way AWS names them, so what you learn here reads the same on a real console.
 *
 * It is plain data: it travels in the manifest to any UI, and is evaluated against a frame's `Stats` by `valueOf`.
 */

/** A value read from a node's (or an edge's) stats in one frame, or computed from several. */
export type Metric =
  /** A counter, per second (`in`, `ok`, `fail.Throttled`, `consumedWrite`). A counter that saw nothing is 0. */
  | { readonly rate: string }
  /** A level, as last read (`depth`, `concurrent`, `ready`). */
  | { readonly gauge: string }
  /** A statistic of sampled values (`latency` p95). */
  | { readonly dist: string; readonly stat: DistStat }
  /** One value over another, times `scale`: bytes per item, a hit ratio, an error rate. Nothing when the divisor is 0. */
  | { readonly ratio: readonly [Metric, Metric]; readonly scale?: number }
  /** Values added up: reads and writes, every kind of throttle. */
  | { readonly sum: ReadonlyArray<Metric> }
  /** A fixed number: a threshold or a limit to read a line against (Route 53's 18% healthy, a quota). */
  | { readonly constant: number }

export type DistStat = "p50" | "p95" | "p99" | "mean" | "max"

/**
 * How a value reads. `perSecond` is a rate of things; `perMinute` a rate as CloudWatch reports some per minute (an ALB's
 * RequestCountPerTarget), the value already scaled to a minute; `bytesPerSecond` a rate of bytes; `ratio` a share from 0
 * to 1, shown as a percentage; `ms` a duration; `count` and `bytes` levels or sizes.
 */
export type Unit = "perSecond" | "perMinute" | "count" | "ms" | "bytes" | "bytesPerSecond" | "ratio" | "units"

/** A line's colour, by what it means: the traffic, what worked, what failed, a warning, and two neutral accents. */
export type Tone = "primary" | "ok" | "bad" | "warn" | "accent" | "teal" | "muted"

export interface Line {
  readonly label: string
  readonly metric: Metric
  readonly tone?: Tone
  /** Drawn dashed: a limit or a target to read the others against (provisioned capacity, a reservation). */
  readonly dashed?: boolean
}

export interface Panel {
  /** Stable within the dashboard. */
  readonly id: string
  readonly title: string
  readonly unit: Unit
  readonly lines: ReadonlyArray<Line>
  /** The CloudWatch metrics this panel stands for, shown with it: `ConsumedWriteCapacityUnits`. */
  readonly cloudwatch?: ReadonlyArray<string>
  /** What to read from it, in a sentence. */
  readonly help?: string
  /**
   * A gauge the node records only when the panel applies (a table's stream, a cluster's container instances): without
   * it, the panel isn't shown. A panel of nothing but gauges needs none of this: it is hidden when the node records none of them.
   */
  readonly requires?: string
}

/** A key figure: one number, shown large above the charts. */
export interface Figure {
  readonly label: string
  readonly metric: Metric
  readonly unit: Unit
  /** Coloured when it means trouble (throttles, errors) and isn't 0. */
  readonly tone?: Tone
  readonly cloudwatch?: string
}

export interface Dashboard {
  readonly figures: ReadonlyArray<Figure>
  readonly panels: ReadonlyArray<Panel>
}

// ---------------------------------------------------------------------------------------------------------
// Building one
// ---------------------------------------------------------------------------------------------------------

export const rate = (name: string): Metric => ({ rate: name })
export const gauge = (name: string): Metric => ({ gauge: name })
export const dist = (name: string, stat: DistStat): Metric => ({ dist: name, stat })
export const ratio = (numerator: Metric, denominator: Metric, scale?: number): Metric => ({ ratio: [numerator, denominator], ...(scale === undefined ? {} : { scale }) })
export const sum = (...metrics: ReadonlyArray<Metric>): Metric => ({ sum: metrics })
export const constant = (value: number): Metric => ({ constant: value })

/** The latency panel most things have: p50, p95 and p99 of a sampled duration. */
export const latencyPanel = (id: string, title: string, name = "latency", cloudwatch?: ReadonlyArray<string>): Panel => ({
  id,
  title,
  unit: "ms",
  lines: [
    { label: "p50", metric: dist(name, "p50"), tone: "primary" },
    { label: "p95", metric: dist(name, "p95"), tone: "warn" },
    { label: "p99", metric: dist(name, "p99"), tone: "bad" }
  ],
  ...(cloudwatch === undefined ? {} : { cloudwatch })
})

/**
 * What every node records, as a dashboard: requests (arriving, succeeded, failed), latency, and the gauges its card
 * highlights. What a component without a dashboard of its own shows, and where a component's own one usually starts.
 */
export const generic = (highlights: ReadonlyArray<{ readonly gauge?: string; readonly label: string }> = [], source = false): Dashboard => ({
  figures: [
    { label: source ? "Sent" : "Requests", metric: rate(source ? "sent" : "in"), unit: "perSecond" },
    { label: "Failed", metric: rate("fail"), unit: "perSecond", tone: "bad" },
    { label: "Latency p95", metric: dist("latency", "p95"), unit: "ms" }
  ],
  panels: [
    {
      id: "requests",
      title: "Requests",
      unit: "perSecond",
      lines: [
        { label: source ? "sent" : "arriving", metric: rate(source ? "sent" : "in"), tone: "primary" },
        { label: "ok", metric: rate("ok"), tone: "ok" },
        { label: "failed", metric: rate("fail"), tone: "bad" }
      ]
    },
    latencyPanel("latency", "Latency"),
    ...highlights.flatMap((h): ReadonlyArray<Panel> =>
      h.gauge === undefined ? [] : [{ id: `gauge:${h.gauge}`, title: h.label.charAt(0).toUpperCase() + h.label.slice(1), unit: "count", lines: [{ label: h.label, metric: gauge(h.gauge), tone: "accent" }] }]
    )
  ]
})

/** What every edge records (transport), whatever sits on it: attempts, outcomes, retries, latency per attempt, in flight. */
export const transport: Dashboard = {
  figures: [
    { label: "Calls", metric: rate("calls"), unit: "perSecond" },
    { label: "Failed", metric: rate("fail"), unit: "perSecond", tone: "bad" },
    { label: "Retries", metric: rate("retries"), unit: "perSecond", tone: "warn" },
    { label: "Latency p95", metric: dist("latency", "p95"), unit: "ms" }
  ],
  panels: [
    {
      id: "calls",
      title: "Calls",
      unit: "perSecond",
      lines: [
        { label: "attempts", metric: rate("calls"), tone: "primary" },
        { label: "ok", metric: rate("ok"), tone: "ok" },
        { label: "failed", metric: rate("fail"), tone: "bad" },
        { label: "retries", metric: rate("retries"), tone: "warn", dashed: true }
      ]
    },
    latencyPanel("latency", "Latency per attempt"),
    { id: "inflight", title: "In flight", unit: "count", lines: [{ label: "in flight", metric: gauge("inflight"), tone: "accent" }] }
  ]
}

// ---------------------------------------------------------------------------------------------------------
// Reading one
// ---------------------------------------------------------------------------------------------------------

/** A metric's value in one frame's stats, or `undefined` when there is nothing to show (no stats, no samples, a 0 divisor). */
export const valueOf = (metric: Metric, stats: Stats | undefined): number | undefined => {
  if (stats === undefined) return undefined
  if ("constant" in metric) return metric.constant
  if ("rate" in metric) return stats.rates[metric.rate] ?? 0
  if ("gauge" in metric) return stats.gauges[metric.gauge]
  if ("dist" in metric) {
    const d = stats.dist[metric.dist]
    return d === undefined || d.n === 0 ? undefined : d[metric.stat]
  }
  if ("ratio" in metric) return ratioOf(valueOf(metric.ratio[0], stats), valueOf(metric.ratio[1], stats), metric.scale)
  return sumOf(metric.sum, (m) => valueOf(m, stats))
}

/**
 * A metric over several frames, as one number: counters and sums averaged, sampled values weighted by their sample
 * counts, and a ratio as the ratio of its parts' averages (so an average item size over a second is the bytes over the
 * items, not the mean of each frame's). A gauge is its latest reading, or with `gauges: "mean"` the average of its
 * readings, as CloudWatch's Average of a period (a chart's point; a key figure wants the latest).
 */
export const valueOver = (metric: Metric, frames: ReadonlyArray<Stats | undefined>, gauges: "latest" | "mean" = "latest"): number | undefined => {
  const present = frames.filter((s): s is Stats => s !== undefined)
  if (present.length === 0) return undefined
  if ("constant" in metric) return metric.constant
  if ("gauge" in metric) {
    if (gauges === "latest") return valueOf(metric, present[present.length - 1])
    let total = 0
    let n = 0
    for (const f of present) {
      const v = f.gauges[metric.gauge]
      if (v !== undefined) {
        total += v
        n++
      }
    }
    return n === 0 ? undefined : total / n
  }
  if ("rate" in metric) return present.reduce((s, f) => s + (f.rates[metric.rate] ?? 0), 0) / present.length
  if ("dist" in metric) {
    let n = 0
    let weighted = 0
    let max: number | undefined
    for (const f of present) {
      const d = f.dist[metric.dist]
      if (d === undefined || d.n === 0) continue
      n += d.n
      weighted += d[metric.stat] * d.n
      max = max === undefined ? d.max : Math.max(max, d.max)
    }
    if (n === 0) return undefined
    return metric.stat === "max" ? max : weighted / n
  }
  if ("ratio" in metric) return ratioOf(valueOver(metric.ratio[0], present, gauges), valueOver(metric.ratio[1], present, gauges), metric.scale)
  return sumOf(metric.sum, (m) => valueOver(m, present, gauges))
}

/** One value over another, times `scale`; nothing when either is missing or the divisor is 0. */
const ratioOf = (top: number | undefined, bottom: number | undefined, scale: number | undefined): number | undefined =>
  top === undefined || bottom === undefined || bottom === 0 ? undefined : (top / bottom) * (scale ?? 1)

/** The values that are there, added up; nothing when none is. */
const sumOf = (metrics: ReadonlyArray<Metric>, read: (m: Metric) => number | undefined): number | undefined => {
  let total = 0
  let any = false
  for (const m of metrics) {
    const v = read(m)
    if (v !== undefined) {
      total += v
      any = true
    }
  }
  return any ? total : undefined
}

/**
 * Whether a metric can ever have a value on a node that records these gauges: not one that needs a gauge the node never
 * registered (a serverless cache's ECPUs on a cluster of nodes, an RDS volume's provisioned IOPS on Aurora).
 */
const possible = (m: Metric, gauges: Readonly<Record<string, number>>): boolean =>
  "gauge" in m ? m.gauge in gauges : "ratio" in m ? m.ratio.every((x) => possible(x, gauges)) : "sum" in m ? m.sum.some((x) => possible(x, gauges)) : true

/**
 * Whether a panel (or a figure) has anything to show for a node, given its latest stats: not when it `requires` a gauge
 * the node doesn't record, nor when none of its lines can have a value there (a Fargate service has no container
 * instances; a threshold line alone is nothing to show). Gauges are registered when a node is built, so the answer
 * doesn't change from one frame to the next, and charts don't come and go.
 */
export const applies = (item: Panel | Figure, stats: Stats | undefined): boolean => {
  if (stats === undefined) return true
  if ("requires" in item && item.requires !== undefined && !(item.requires in stats.gauges)) return false
  const metrics = "lines" in item ? item.lines.map((l) => l.metric) : [item.metric]
  return metrics.some((m) => !("constant" in m) && possible(m, stats.gauges))
}

/** A panel's lines that can have a value on a node, given its latest stats: one that needs a gauge the node doesn't record is left out. */
export const linesFor = (panel: Panel, stats: Stats | undefined): ReadonlyArray<Line> =>
  stats === undefined ? panel.lines : panel.lines.filter((l) => possible(l.metric, stats.gauges))

/** Every counter, gauge and distribution a dashboard reads, for checking it against what a component records. */
export const namesIn = (dashboard: Dashboard): { readonly rates: ReadonlySet<string>; readonly gauges: ReadonlySet<string>; readonly dists: ReadonlySet<string> } => {
  const rates = new Set<string>()
  const gauges = new Set<string>()
  const dists = new Set<string>()
  const visit = (m: Metric): void => {
    if ("rate" in m) rates.add(m.rate)
    else if ("gauge" in m) gauges.add(m.gauge)
    else if ("dist" in m) dists.add(m.dist)
    else if ("ratio" in m) m.ratio.forEach(visit)
    else if ("sum" in m) m.sum.forEach(visit)
  }
  for (const f of dashboard.figures) visit(f.metric)
  for (const p of dashboard.panels) {
    for (const l of p.lines) visit(l.metric)
    if (p.requires !== undefined) gauges.add(p.requires)
  }
  return { rates, gauges, dists }
}
