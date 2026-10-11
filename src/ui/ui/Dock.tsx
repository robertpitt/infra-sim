import { useState } from "react"
import { Topology } from "#simulator"
import { useStore } from "../lib/store.ts"
import { doc } from "../state/document.ts"
import { catalog, registry } from "../state/engine.ts"
import { history, run } from "../state/run.ts"
import { togglePanel, ui } from "../state/ui.ts"
import { chartsFor } from "./charts.ts"
import { Icon } from "./Icon.tsx"
import { LineChart } from "./LineChart.tsx"

const WINDOWS = [
  { label: "1m", ms: 60_000 },
  { label: "2m", ms: 120_000 },
  { label: "5m", ms: 300_000 },
  { label: "10m", ms: 600_000 }
]

export function Dock() {
  const state = useStore(doc, (s) => s)
  const manifests = useStore(catalog, (s) => s.byType)
  const spans = useStore(run, (s) => s.spans)
  useStore(run, (s) => s.version)
  const [windowMs, setWindowMs] = useState(120_000)
  const collapsed = useStore(ui, (s) => s.dockCollapsed)

  const now = history.last()?.t ?? 0
  const tMax = Math.max(now, windowMs)
  const tMin = tMax - windowMs
  const selection = state.selection
  const sources = Topology.sources(Topology.fromDoc(state.design, registry))
  const type = selection?.kind === "node" ? state.design.nodes[selection.id]?.type : undefined
  const highlights = (type === undefined ? [] : (manifests[type]?.highlights ?? []).flatMap((h) => (h.gauge === undefined ? [] : [h.gauge])))
  const charts = collapsed ? [] : chartsFor(selection, state, windowMs, now, sources, highlights)
  const relevant = spans
    .filter((s) => selection === undefined || (s.target.kind === selection.kind && s.target.id === selection.id))
    .map((s) => ({ from: s.from, to: s.to ?? tMax }))

  const subject =
    selection === undefined
      ? "Whole design"
      : selection.kind === "node"
      ? (state.design.nodes[selection.id]?.name ?? selection.id)
      : "Connection"

  return (
    <section className="dock" data-collapsed={collapsed || undefined}>
      <header className="dock-head">
        <button className="icon-btn" onClick={() => togglePanel("dockCollapsed")} title={collapsed ? "Show charts" : "Hide charts"}>
          <Icon name={collapsed ? "chevron" : "down"} size={14} />
        </button>
        <span className="dock-title">{subject}</span>
        {relevant.length > 0 && <span className="legend-item"><i className="band-swatch" /> fault injected</span>}
        <span className="spacer" />
        <div className="segmented small">
          {WINDOWS.map((w) => (
            <button key={w.label} data-on={w.ms === windowMs || undefined} onClick={() => setWindowMs(w.ms)}>
              {w.label}
            </button>
          ))}
        </div>
      </header>
      {!collapsed && (
        <div className="charts">
          {charts.length === 0 ? (
            <p className="muted small pad">Charts appear here once the simulation is running.</p>
          ) : (
            charts.map((c) => <LineChart key={c.id} title={c.title} series={c.series} tMin={tMin} tMax={tMax} spans={relevant} format={c.format} />)
          )}
        </div>
      )}
    </section>
  )
}
