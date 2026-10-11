import { type ReactNode, useState } from "react"
import { Topology } from "#simulator"
import { fmtTime } from "../lib/format.ts"
import { useStore } from "../lib/store.ts"
import { doc } from "../state/document.ts"
import { catalog, registry } from "../state/engine.ts"
import { history, run } from "../state/run.ts"
import { type DockTab, setDockTab, togglePanel, ui } from "../state/ui.ts"
import { AlertsPanel } from "./AlertsPanel.tsx"
import { chartsFor } from "./charts.ts"
import { Icon } from "./Icon.tsx"
import { LineChart } from "./LineChart.tsx"
import { ScenarioPanel } from "./ScenarioPanel.tsx"

const WINDOWS = [
  { label: "1m", ms: 60_000 },
  { label: "2m", ms: 120_000 },
  { label: "5m", ms: 300_000 },
  { label: "10m", ms: 600_000 }
]

/**
 * The dock under the canvas: charts, alerts and the scenario, one at a time. Folded away it is a single bar that still
 * says what matters (alerts firing, a scenario's progress), so nothing urgent hides behind a closed panel.
 */
export function Dock() {
  const collapsed = useStore(ui, (s) => s.dockCollapsed)
  const tab = useStore(ui, (s) => s.dockTab)
  const [windowMs, setWindowMs] = useState(120_000)
  const subject = useStore(doc, (s) =>
    s.selection === undefined ? "Whole design" : s.selection.kind === "node" ? (s.design.nodes[s.selection.id]?.name ?? s.selection.id) : "Connection"
  )
  // Fault bands on the charts: the ones about what the charts show.
  const selection = useStore(doc, (s) => s.selection)
  const spans = useStore(run, (s) => s.spans)
  const faulted = spans.some((f) => selection === undefined || (f.target.kind === selection.kind && f.target.id === selection.id))
  const open = !collapsed

  // Clicking the tab that is showing folds the dock away; any other tab opens it there.
  const choose = (next: DockTab) => (open && next === tab ? togglePanel("dockCollapsed") : setDockTab(next))

  return (
    <section className="dock" data-collapsed={collapsed || undefined}>
      <header className="dock-head">
        <button className="icon-btn" onClick={() => togglePanel("dockCollapsed")} title={collapsed ? "Show the dock" : "Hide the dock"}>
          <Icon name={collapsed ? "chevron" : "down"} size={14} />
        </button>
        <div className="dock-tabs" role="tablist">
          <Tab id="charts" current={tab} open={open} onClick={choose}>
            <Icon name="charts" size={13} /> Charts
          </Tab>
          <Tab id="alerts" current={tab} open={open} onClick={choose}>
            <Icon name="bell" size={13} /> Alerts <AlertsBadge />
          </Tab>
          <Tab id="scenario" current={tab} open={open} onClick={choose}>
            <Icon name="flag" size={13} /> Scenario <ScenarioBadge />
          </Tab>
        </div>
        {open && tab === "charts" && <span className="dock-title">{subject}</span>}
        {open && tab === "charts" && faulted && (
          <span className="legend-item">
            <i className="band-swatch" /> fault injected
          </span>
        )}
        <span className="spacer" />
        {open && tab === "charts" && (
          <div className="segmented small">
            {WINDOWS.map((w) => (
              <button key={w.label} data-on={w.ms === windowMs || undefined} onClick={() => setWindowMs(w.ms)}>
                {w.label}
              </button>
            ))}
          </div>
        )}
      </header>
      {open && (
        <div className="dock-body" role="tabpanel">
          {tab === "charts" ? <Charts windowMs={windowMs} /> : tab === "alerts" ? <AlertsPanel /> : <ScenarioPanel />}
        </div>
      )}
    </section>
  )
}

function Tab({ id, current, open, onClick, children }: { id: DockTab; current: DockTab; open: boolean; onClick: (tab: DockTab) => void; children: ReactNode }) {
  const on = open && id === current
  return (
    <button className="dock-tab" role="tab" aria-selected={on} data-on={on || undefined} onClick={() => onClick(id)}>
      {children}
    </button>
  )
}

function AlertsBadge() {
  const firing = useStore(run, (s) => s.alerts.filter((a) => a.resolvedAt === undefined).length)
  const critical = useStore(run, (s) => s.alerts.some((a) => a.resolvedAt === undefined && a.severity === "critical"))
  if (firing === 0) return null
  return (
    <span className="tab-badge" data-tone={critical ? "critical" : "warning"}>
      {firing}
    </span>
  )
}

function ScenarioBadge() {
  const label = useStore(run, (s) => {
    const p = s.scenario
    if (p === undefined) return undefined
    if (p.finished) return p.passed ? "passed" : "failed"
    return `${fmtTime(Math.min(p.t, p.duration))}/${fmtTime(p.duration)}`
  })
  if (label === undefined) return null
  return (
    <span className="tab-badge" data-tone={label === "passed" ? "ok" : label === "failed" ? "critical" : "info"}>
      {label}
    </span>
  )
}

function Charts({ windowMs }: { windowMs: number }) {
  const state = useStore(doc, (s) => s)
  const manifests = useStore(catalog, (s) => s.byType)
  const spans = useStore(run, (s) => s.spans)
  useStore(run, (s) => s.version)

  const now = history.last()?.t ?? 0
  const tMax = Math.max(now, windowMs)
  const tMin = tMax - windowMs
  const selection = state.selection
  const sources = Topology.sources(Topology.fromDoc(state.design, registry))
  const type = selection?.kind === "node" ? state.design.nodes[selection.id]?.type : undefined
  const highlights = type === undefined ? [] : (manifests[type]?.highlights ?? []).flatMap((h) => (h.gauge === undefined ? [] : [h.gauge]))
  const charts = chartsFor(selection, state, windowMs, now, sources, highlights)
  const relevant = spans
    .filter((s) => selection === undefined || (s.target.kind === selection.kind && s.target.id === selection.id))
    .map((s) => ({ from: s.from, to: s.to ?? tMax }))

  return (
    <div className="charts">
      {charts.length === 0 ? (
        <p className="muted small pad">Charts appear here once the simulation is running.</p>
      ) : (
        charts.map((c) => <LineChart key={c.id} title={c.title} series={c.series} tMin={tMin} tMax={tMax} spans={relevant} format={c.format} height={136} />)
      )}
    </div>
  )
}
