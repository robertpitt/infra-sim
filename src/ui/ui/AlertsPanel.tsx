import { Alarm } from "#simulator"
import { fmtMs, fmtTime, fmtUnit } from "../lib/format.ts"
import { useStore } from "../lib/store.ts"
import { doc } from "../state/document.ts"
import { showNode } from "../state/files.ts"
import { type FaultSpan, run } from "../state/run.ts"
import type { Alert } from "../state/types.ts"
import { Icon } from "./Icon.tsx"

/**
 * What the run's alarms have raised. Firing alerts come first, most severe on top; below them the history: alerts that
 * have cleared, with the faults injected along the way, so a cause sits next to what it set off. Clicking one shows the
 * node it is about, and with it the path it is on.
 */
export function AlertsPanel() {
  const alerts = useStore(run, (s) => s.alerts)
  const spans = useStore(run, (s) => s.spans)
  const nodes = useStore(doc, (s) => s.design.nodes)
  const now = useStore(run, (s) => s.status?.t ?? 0)
  const firing = alerts.filter((a) => a.resolvedAt === undefined)
  const history: Array<{ readonly at: number; readonly alert?: Alert; readonly fault?: FaultSpan }> = [
    ...alerts.filter((a) => a.resolvedAt !== undefined).map((alert) => ({ at: alert.firedAt, alert })),
    ...spans.map((fault) => ({ at: fault.from, fault }))
  ].sort((a, b) => b.at - a.at)
  const name = (id: string) => nodes[id]?.name ?? id

  if (firing.length === 0 && history.length === 0) {
    return (
      <div className="alerts-empty">
        <p>
          <Icon name="bell" size={14} /> <b>No alerts.</b> Every component is watched for what a team would set alarms on, checked every 10 seconds of simulated time:
        </p>
        <ul>
          {Alarm.rules.map((r) => (
            <li key={r.id}>
              <b>{r.title(false)}</b> <span>{r.description}</span>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  return (
    <div className="alerts">
      {firing.length > 0 && <h4 className="alerts-head">Firing</h4>}
      {firing.map((a) => (
        <button key={a.id} className="alert-row" data-severity={a.severity} onClick={() => showNode(a.target.id)}>
          <span className="sev">{a.severity === "critical" ? "Critical" : "Warning"}</span>
          <span className="alert-what">
            <b>{a.title}</b>
            <code>{a.check}</code>
          </span>
          <span className="alert-node">{name(a.target.id)}</span>
          <span className="alert-value" title={`Worst so far: ${fmtUnit(a.unit, a.peak)}`}>
            {fmtUnit(a.unit, a.value)}
          </span>
          <span className="alert-time" title={`Fired at ${fmtTime(a.firedAt)}`}>
            {fmtTime(a.firedAt)} <i>for {fmtMs(Math.max(0, now - a.firedAt))}</i>
          </span>
        </button>
      ))}
      {history.length > 0 && <h4 className="alerts-head">History</h4>}
      {history.map(({ alert, fault }) =>
        alert !== undefined ? (
          <button key={alert.id} className="alert-row" data-resolved onClick={() => showNode(alert.target.id)}>
            <span className="sev">
              <Icon name="check" size={12} /> Cleared
            </span>
            <span className="alert-what">
              <b>{alert.title}</b>
              <code>{alert.check}</code>
            </span>
            <span className="alert-node">{name(alert.target.id)}</span>
            <span className="alert-value" title="The worst it got">
              {fmtUnit(alert.unit, alert.peak)}
            </span>
            <span className="alert-time">
              {fmtTime(alert.firedAt)} – {fmtTime(alert.resolvedAt!)} <i>{fmtMs(alert.resolvedAt! - alert.firedAt)}</i>
            </span>
          </button>
        ) : (
          <button
            key={fault!.id}
            className="alert-row"
            data-fault
            onClick={() => fault!.target.kind === "node" && showNode(fault!.target.id)}
          >
            <span className="sev">
              <Icon name="bolt" size={12} /> Fault
            </span>
            <span className="alert-what">
              <b>{fault!.kind} injected</b>
              <code>{fault!.target.kind}:{fault!.target.id}</code>
            </span>
            <span className="alert-node">{fault!.target.kind === "node" ? name(fault!.target.id) : fault!.target.id}</span>
            <span className="alert-value" />
            <span className="alert-time">
              {fmtTime(fault!.from)} – {fault!.to === undefined ? "now" : fmtTime(fault!.to)}
            </span>
          </button>
        )
      )}
    </div>
  )
}
