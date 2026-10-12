import { Dashboard } from "#simulator"
import { fmtValue } from "../lib/format.ts"
import { useSteady } from "../lib/steady.ts"
import { useStore } from "../lib/store.ts"
import { history, run } from "../state/run.ts"
import { FIGURE_FRAMES, TONE } from "./charts.ts"

/**
 * The key figures of a node or an edge (its dashboard's), over the last two seconds: the numbers an operator looks at
 * first. One that means trouble (throttles, errors) is coloured when it isn't 0.
 */
export function Figures({ figures, scope, id, compact = false }: { figures: ReadonlyArray<Dashboard.Figure>; scope: "nodes" | "edges"; id: string; compact?: boolean }) {
  useStore(run, (s) => s.version)
  const frames = history.tail(FIGURE_FRAMES).map((f) => f[scope][id])
  // Not one of a level the node doesn't have (a Fargate service's container instances).
  const shown = figures.filter((f) => Dashboard.applies(f, frames[frames.length - 1]))
  const values = useSteady(
    shown.map((f) => Dashboard.valueOver(f.metric, frames)),
    `${scope}:${id}:${shown.map((f) => f.label).join()}`
  )
  if (shown.length === 0) return null
  return (
    <div className="figures" data-compact={compact || undefined}>
      {shown.map((f, i) => {
        const v = values[i]
        const alarming = f.tone !== undefined && f.tone !== "primary" && v !== undefined && v > 0
        return (
          <div
            key={f.label}
            className="figure"
            title={f.cloudwatch === undefined ? undefined : `CloudWatch: ${f.cloudwatch}`}
            style={alarming ? { ["--tone" as string]: TONE[f.tone!] } : undefined}
            data-alarming={alarming || undefined}
          >
            <span className="figure-label">{f.label}</span>
            <b className="figure-value">{v === undefined ? "—" : fmtValue(f.unit, v)}</b>
          </div>
        )
      })}
    </div>
  )
}
