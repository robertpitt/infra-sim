import { Describe } from "#simulator"
import type { Stats } from "../state/types.ts"
import { fmtCount, fmtMs, fmtPct, fmtRate } from "../lib/format.ts"

const LABELS: Record<string, string> = {
  in: "Arriving",
  sent: "Sent",
  ok: "Succeeded",
  partial: "Succeeded, some records failed",
  itemFailures: "Records failed",
  itemFailuresIgnored: "Record failures ignored",
  concurrency: "Concurrency",
  fail: "Failed",
  calls: "Attempts",
  retries: "Retries",
  "fail.Throttled": "Throttled",
  "fail.Unavailable": "Unavailable",
  "fail.Timeout": "Timed out",
  "fail.Failed": "Errored",
  deleted: "Acknowledged",
  redelivered: "Redelivered",
  deadLettered: "Dead-lettered",
  dlqFailed: "Dead-letter failed",
  dropped: "Dropped",
  duplicates: "Duplicate completions",
  nacks: "Failed deliveries",
  delivered: "Delivered",
  undelivered: "Undelivered",
  noroute: "No route",
  inflight: "In flight",
  busy: "Workers busy",
  waiting: "Waiting",
  utilization: "Utilisation",
  depth: "Waiting in queue",
  hidden: "In flight (hidden)",
  oldestAgeMs: "Oldest message",
  tokens: "Burst capacity left"
}

const label = (key: string) => LABELS[key] ?? Describe.humanize(key.replace(".", " "))

const gaugeText = (key: string, v: number) =>
  key === "utilization" ? fmtPct(v) : key.endsWith("Ms") ? fmtMs(v) : fmtCount(v)

/** Everything the engine reports for a node or edge, generically. */
export function Metrics({ stats }: { stats: Stats | undefined }) {
  if (stats === undefined) return <p className="muted small">No data yet. Press play.</p>
  const rates = Object.entries(stats.rates).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
  const gauges = Object.entries(stats.gauges)
  const dists = Object.entries(stats.dist)
  return (
    <div className="metrics">
      {rates.length > 0 && (
        <dl>
          {rates.map(([k, v]) => (
            <div key={k} data-tone={k.startsWith("fail") ? "bad" : undefined}>
              <dt>{label(k)}</dt>
              <dd>
                {fmtRate(v)}
                <small>/s</small>
              </dd>
            </div>
          ))}
        </dl>
      )}
      {gauges.length > 0 && (
        <dl>
          {gauges.map(([k, v]) => (
            <div key={k}>
              <dt>{label(k)}</dt>
              <dd>{gaugeText(k, v)}</dd>
            </div>
          ))}
        </dl>
      )}
      {dists.map(([k, d]) => (
        <dl key={k}>
          {(["p50", "p95", "p99"] as const).map((q) => (
            <div key={q}>
              <dt>{label(k === "age" ? "Message age" : "Latency")} {q}</dt>
              <dd>{fmtMs(d[q])}</dd>
            </div>
          ))}
        </dl>
      ))}
    </div>
  )
}

const ORDER = ["sent", "in", "ok", "fail", "calls", "retries"]
const rank = (key: string) => {
  const i = ORDER.indexOf(key)
  return i === -1 ? (key.startsWith("fail.") ? 4.5 : 10) : i
}
