import { memo } from "react"
import { fmtPct, fmtRate, clamp } from "../lib/format.ts"
import { useStore } from "../lib/store.ts"
import { run } from "../state/run.ts"
import type { ConnectorManifest } from "../state/types.ts"
import { Icon } from "../ui/Icon.tsx"
import type { Point } from "./geometry.ts"
import { edgePath, midpoint } from "./geometry.ts"
import { failRatio, useStats } from "./stats.ts"

interface EdgeProps {
  readonly id: string
  readonly a: Point
  readonly b: Point
  readonly selected: boolean
  /** Whether the edge is on the path through the selection; undefined when nothing is in focus. */
  readonly path: boolean | undefined
  readonly label: string | undefined
  /** What sits between the two nodes, when it is more than a plain link: drawn as a badge on the line. */
  readonly connector: ConnectorManifest | undefined
}

export const EdgeView = memo(function EdgeView({ id, a, b, selected, path, label, connector }: EdgeProps) {
  const stats = useStats("edges", id)
  const faults = useStore(run, (s) => s.faults.filter((f) => f.target.kind === "edge" && f.target.id === id).length)
  const calls = stats?.rates.calls ?? 0
  const retries = stats?.rates.retries ?? 0
  const ratio = failRatio(stats)
  const d = edgePath(a, b)
  const mid = midpoint(a, b)
  const tone = faults > 0 ? "fault" : calls < 0.05 ? "idle" : ratio > 0.2 ? "bad" : ratio > 0.02 ? "warn" : "ok"
  const width = clamp(1.6 + Math.log10(1 + calls) * 1.3, 1.6, 6.5)
  const flow = clamp(3 - Math.log10(1 + calls) * 0.75, 0.3, 3)
  const text = [
    calls >= 0.05 ? `${fmtRate(calls)}/s` : undefined,
    ratio > 0.005 ? `✕ ${fmtPct(ratio)}` : undefined,
    retries >= 0.5 ? `↻ ${fmtRate(retries)}/s` : undefined
  ].filter(Boolean)

  return (
    <g className="edge" data-tone={tone} data-selected={selected || undefined} data-path={path} data-edge-id={id}>
      <path className="edge-hit" d={d} data-edge-id={id} />
      {selected && <path className="edge-glow" d={d} style={{ strokeWidth: width + 7 }} />}
      <path className="edge-line" d={d} markerEnd={`url(#arrow-${tone})`} style={{ strokeWidth: width }} />
      {tone !== "idle" && <path className="edge-flow" d={d} style={{ strokeWidth: Math.max(1.2, width - 0.6), ["--flow" as string]: `${flow}s` }} />}
      {(text.length > 0 || label !== undefined) && (
        <text className="edge-label" x={mid.x} y={mid.y - (connector === undefined ? 9 : 16)} textAnchor="middle">
          {label !== undefined && text.length === 0 ? label : text.join("  ")}
        </text>
      )}
      {connector !== undefined && (
        <g transform={`translate(${mid.x}, ${mid.y})`} className="edge-connector" data-edge-id={id}>
          <title>{connector.title}</title>
          <circle r="10" />
          <g transform="translate(-6.5, -6.5)">
            <Icon name={connector.icon} size={13} />
          </g>
        </g>
      )}
      {faults > 0 && (
        <g transform={`translate(${mid.x}, ${mid.y + (connector === undefined ? 8 : 22)})`} className="edge-fault">
          <circle r="9" />
          <path d="M1.5 -6 L-4 1 H0 L-1.5 6 L4 -1 H0 Z" />
        </g>
      )}
    </g>
  )
})

const ARROWS: ReadonlyArray<readonly [string, string]> = [
  ["idle", "#364256"],
  ["ok", "#3a8f86"],
  ["warn", "#c9962f"],
  ["bad", "#d95858"],
  ["fault", "#d95858"]
]

/** One marker per tone: SVG markers can't see CSS variables set on the edge that references them. */
export const Arrowhead = () => (
  <defs>
    {ARROWS.map(([tone, color]) => (
      <marker key={tone} id={`arrow-${tone}`} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto" markerUnits="userSpaceOnUse">
        <path d="M1 1 L9 5 L1 9 z" fill={color} />
      </marker>
    ))}
  </defs>
)
