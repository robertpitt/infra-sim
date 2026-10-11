import { Handle, type NodeProps, Position } from "@xyflow/react"
import type { ComponentManifest, Highlight, Stats } from "../state/types.ts"
import { memo } from "react"
import { fmtCount, fmtMs, fmtPct, fmtRate } from "../lib/format.ts"
import { useStore } from "../lib/store.ts"
import { doc } from "../state/document.ts"
import { run, smoothed } from "../state/run.ts"
import { Icon } from "../ui/Icon.tsx"
import type { ComponentNode } from "./flow.ts"
import { HEAD_H, NODE_W, PORT_H, STATS_H, nodeHeight } from "./geometry.ts"
import { failRatio, healthOf, useStats } from "./stats.ts"

const highlightValue = (h: Highlight, stats: Stats | undefined): string => {
  if (stats === undefined) return "—"
  const raw = h.gauge !== undefined ? stats.gauges[h.gauge] : h.rate !== undefined ? stats.rates[h.rate] : undefined
  if (raw === undefined) return h.rate !== undefined ? "0" : "—"
  if (h.format === "percent") return fmtPct(raw)
  if (h.format === "ms") return fmtMs(raw)
  return h.rate !== undefined ? fmtRate(raw) : fmtCount(raw)
}

/**
 * A component on the canvas: a card with its live numbers. React Flow places it and draws the wires between its
 * handles: one input on the left, an output on the right for each port.
 *
 * The numbers change several times a second; the card around them hardly ever. So the numbers are a component of
 * their own (`Figures`), and the card re-renders only when what it shows changes: its health, a fault, an alert.
 */
export const NodeView = memo(function NodeView({ id, data, selected }: NodeProps<ComponentNode>) {
  const { spec, manifest, path, level } = data
  const faults = useStore(run, (s) => s.faults.filter((f) => f.target.kind === "node" && f.target.id === id).length)
  const down = useStore(run, (s) => s.faults.some((f) => f.target.kind === "node" && f.target.id === id && f.fault._tag === "Outage"))
  // Alarms firing on this node: the worst severity, and what they are, for the badge.
  const alerting = useStore(run, (s) => {
    let worst: "critical" | "warning" | undefined
    for (const a of s.alerts) {
      if (a.resolvedAt !== undefined || a.target.id !== id) continue
      if (a.severity === "critical") return "critical"
      worst = "warning"
    }
    return worst
  })
  const alertTitles = useStore(run, (s) => s.alerts.filter((a) => a.resolvedAt === undefined && a.target.id === id).map((a) => a.title).join(", "))
  const controlled = useStore(doc, (s) => Object.values(s.design.controllers ?? {}).filter((c) => c.target === id).length)
  // Read on every frame, but only a change of health re-renders the card.
  const health = useStore(run, () => healthOf(smoothed("nodes", id), down))
  const height = nodeHeight(manifest)
  const outputs = manifest?.outputs ?? []
  const multi = outputs.length > 1

  return (
    <div
      className="node"
      data-node-id={id}
      data-selected={selected || undefined}
      data-path={path}
      data-health={health}
      data-faulted={faults > 0 || undefined}
      data-unknown={manifest === undefined || undefined}
      style={{ width: NODE_W, height, ["--accent" as string]: manifest?.accent ?? "#8893a5" }}
    >
      <div className="node-head" style={{ height: HEAD_H }}>
        <span className="node-icon">
          <Icon name={manifest?.icon ?? "box"} size={16} />
        </span>
        <span className="node-title">
          <span className="node-name">{spec.name ?? id}</span>
          <span className="node-type">{manifest?.title ?? `Unknown: ${spec.type}`}</span>
        </span>
        {controlled > 0 && (
          <span className="node-badge controlled" title={`${controlled} controller${controlled > 1 ? "s" : ""} change${controlled > 1 ? "" : "s"} this while it runs`}>
            <Icon name="charts" size={12} />
          </span>
        )}
        {alerting !== undefined && (
          <span className={`node-badge alert ${alerting}`} title={`Alert: ${alertTitles}`}>
            <Icon name="bell" size={12} />
          </span>
        )}
        {faults > 0 && (
          <span className="node-badge fault" title={`${faults} fault${faults > 1 ? "s" : ""} injected`}>
            <Icon name="bolt" size={12} />
          </span>
        )}
        {level !== undefined && level !== "info" && (
          <span className={`node-badge ${level}`} title="This node has design diagnostics">
            <Icon name="warn" size={12} />
          </span>
        )}
      </div>

      <Figures id={id} manifest={manifest} />

      {multi && (
        <div className="node-ports" style={{ top: HEAD_H + STATS_H }}>
          {outputs.map((o) => (
            <div className="port-row" key={o.port} style={{ height: PORT_H }}>
              {o.label}
            </div>
          ))}
        </div>
      )}

      {manifest?.inputs !== false && (
        <Handle type="target" id="in" position={Position.Left} className="handle in" isConnectableStart={false} style={{ top: height / 2 }} />
      )}
      {outputs.map((o, i) => (
        <Handle
          type="source"
          id={o.port}
          position={Position.Right}
          className="handle out"
          key={o.port}
          isConnectableEnd={false}
          title={multi ? o.label : "Drag to connect"}
          style={{ top: multi ? HEAD_H + STATS_H + 4 + i * PORT_H + PORT_H / 2 : height / 2 }}
        />
      ))}
    </div>
  )
})

/** The live numbers on a card: rate, errors, p95, and up to three of the component's own highlights. */
function Figures({ id, manifest }: { id: string; manifest: ComponentManifest | undefined }) {
  const stats = useStats("nodes", id)
  const source = manifest !== undefined && !manifest.inputs
  const rate = source ? stats?.rates.sent : stats?.rates.in
  const p95 = stats?.dist.latency?.p95
  const ratio = failRatio(stats)
  return (
    <div className="node-stats" style={{ height: STATS_H }}>
      <div className="stat-row">
        <Stat label={source ? "sent/s" : "in/s"} value={rate === undefined ? "—" : fmtRate(rate)} />
        <Stat label="errors" value={stats === undefined ? "—" : fmtPct(ratio)} tone={ratio > 0.2 ? "bad" : ratio > 0.02 ? "warn" : undefined} />
        <Stat label="p95" value={p95 === undefined ? "—" : fmtMs(p95)} />
      </div>
      <div className="chip-row">
        {(manifest?.highlights ?? []).slice(0, 3).map((h) => (
          <span className="chip" key={h.label}>
            <b>{highlightValue(h, stats)}</b> {h.label}
          </span>
        ))}
      </div>
    </div>
  )
}

const Stat = ({ label, value, tone }: { label: string; value: string; tone?: "warn" | "bad" | undefined }) => (
  <span className="stat" data-tone={tone}>
    <b>{value}</b>
    <i>{label}</i>
  </span>
)
