import { useMemo } from "react"
import { isContainer } from "../canvas/groups.ts"
import { fmtMs, fmtPct, fmtRate } from "../lib/format.ts"
import { useStore } from "../lib/store.ts"
import { doc } from "../state/document.ts"
import { catalog } from "../state/engine.ts"
import type { Overview } from "../state/overview.ts"
import { overviewOf, overviewSeries } from "../state/overview.ts"
import { history, run } from "../state/run.ts"
import { setDockTab } from "../state/ui.ts"
import { Icon } from "./Icon.tsx"

/** Frames per number shown: one second of virtual time, as on the canvas. */
const SMOOTHING_FRAMES = 4
/** Sparklines show the last minute, one point per second. */
const SPARK_FRAMES = 240

type Tone = "warn" | "bad" | undefined

/**
 * The headline numbers for the whole design, in the toolbar: requests per second, error rate and latency, each
 * with the last minute as a sparkline. They are what the traffic sources see, so they are end to end.
 */
export function KeyStats() {
  const version = useStore(run, (s) => s.version)
  const nodes = useStore(doc, (s) => s.design.nodes)
  const manifests = useStore(catalog, (s) => s.byType)
  const sources = useMemo(
    () =>
      Object.entries(nodes).flatMap(([id, n]) => {
        const m = manifests[n.type]
        return m !== undefined && !m.inputs && !isContainer(m) ? [id] : []
      }),
    [nodes, manifests]
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the signal that history changed.
  const { now, series } = useMemo(() => {
    const frames = history.tail(SPARK_FRAMES)
    return { now: overviewOf(frames.slice(-SMOOTHING_FRAMES), sources), series: overviewSeries(frames, sources, SMOOTHING_FRAMES) }
  }, [sources, version])

  const ratio = now?.errorRatio ?? 0
  const tone: Tone = ratio > 0.2 ? "bad" : ratio > 0.02 ? "warn" : undefined
  const pick = (read: (o: Overview) => number | undefined) => series.map((o) => (o === undefined ? undefined : read(o)))

  return (
    <div className="kpis" title={sources.length === 0 ? "Add a traffic source (a client) to see these" : undefined}>
      <Kpi
        label="Requests"
        value={now === undefined ? "—" : fmtRate(now.rps)}
        unit="/s"
        hint="Requests per second sent by every traffic source"
        spark={pick((o) => o.rps)}
        floor={1}
        color="var(--blue)"
      />
      <Kpi
        label="Errors"
        value={now === undefined ? "—" : fmtPct(ratio)}
        sub={now === undefined || now.fail < 0.05 ? undefined : `${fmtRate(now.fail)}/s`}
        hint={`Share of requests that failed, as their senders saw it${now === undefined ? "" : `: ${fmtRate(now.fail)}/s`}`}
        tone={tone}
        spark={pick((o) => o.errorRatio)}
        floor={0.05}
        color={tone === undefined ? "var(--green)" : tone === "warn" ? "var(--amber)" : "var(--red)"}
      />
      <Kpi
        label="Latency p95"
        value={now?.p95 === undefined ? "—" : fmtMs(now.p95)}
        sub={now?.p99 === undefined ? undefined : `p99 ${fmtMs(now.p99)}`}
        hint={now?.p50 === undefined ? "End-to-end latency seen by the traffic sources" : `End-to-end latency seen by the traffic sources: p50 ${fmtMs(now.p50)}, p95 ${fmtMs(now.p95!)}, p99 ${fmtMs(now.p99!)}`}
        spark={pick((o) => o.p95)}
        floor={10}
        color="var(--amber)"
      />
      <AlertsKpi />
    </div>
  )
}

/** How many alarms are firing, and how many of those page someone. Opens the alerts. */
function AlertsKpi() {
  const firing = useStore(run, (s) => s.alerts.filter((a) => a.resolvedAt === undefined).length)
  const critical = useStore(run, (s) => s.alerts.filter((a) => a.resolvedAt === undefined && a.severity === "critical").length)
  const tone: Tone = critical > 0 ? "bad" : firing > 0 ? "warn" : undefined
  const said = firing === 0 ? "No alerts firing" : `${firing} alert${firing > 1 ? "s" : ""} firing${critical > 0 ? `, ${critical} critical` : ""}`
  return (
    <button className="kpi kpi-button" data-tone={tone} onClick={() => setDockTab("alerts")} title={`${said}. Show the alerts`} aria-label={said}>
      <Icon name="bell" size={16} className="kpi-icon" />
      <b className="kpi-count">{firing}</b>
    </button>
  )
}

interface KpiProps {
  readonly label: string
  readonly value: string
  readonly unit?: string
  readonly sub?: string | undefined
  readonly hint: string
  readonly tone?: Tone
  readonly spark: ReadonlyArray<number | undefined>
  /** The sparkline's scale never goes below this, so noise near zero stays flat. */
  readonly floor: number
  readonly color: string
}

function Kpi({ label, value, unit, sub, hint, tone, spark, floor, color }: KpiProps) {
  return (
    <div className="kpi" data-tone={tone} title={hint}>
      <span className="kpi-text">
        <span className="kpi-label">{label}</span>
        <span className="kpi-value">
          <b>{value}</b>
          {unit !== undefined && value !== "—" && <small>{unit}</small>}
          {sub !== undefined && <i>{sub}</i>}
        </span>
      </span>
      <Sparkline points={spark} floor={floor} color={color} />
    </div>
  )
}

const SPARK_W = 48
const SPARK_H = 22

function Sparkline({ points, floor, color }: { points: ReadonlyArray<number | undefined>; floor: number; color: string }) {
  const max = Math.max(floor, ...points.map((p) => p ?? 0))
  const x = (i: number) => (points.length < 2 ? SPARK_W : (i / (points.length - 1)) * SPARK_W)
  const y = (v: number) => SPARK_H - 1.5 - (v / max) * (SPARK_H - 3)
  let line = ""
  let first: number | undefined
  let last: number | undefined
  points.forEach((v, i) => {
    if (v === undefined) return
    line += `${line === "" ? "M" : "L"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`
    first ??= x(i)
    last = x(i)
  })
  return (
    <svg className="spark" width={SPARK_W} height={SPARK_H} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} aria-hidden style={{ color }}>
      {line !== "" && (
        <>
          <path className="spark-area" d={`${line}L${last!.toFixed(1)} ${SPARK_H}L${first!.toFixed(1)} ${SPARK_H}Z`} />
          <path className="spark-line" d={line} />
        </>
      )}
    </svg>
  )
}
