/**
 * The alarm monitor's state machine (`Alarm.monitor`), the way CloudWatch evaluates alarms: frames are cut into periods,
 * every watch is measured at the end of each, and an alert fires after enough breaching periods in a row and resolves
 * after enough calm ones.
 */
import type { Alert, Monitor, MonitorOptions, Rule, Severity } from "../Alarm.ts"
import { type Assertion, compare, evaluate, type Unit } from "../Check.ts"
import type { Frame } from "../Telemetry.ts"

/** One rule applied to one node, and where it stands. */
export interface Watch {
  readonly key: string
  readonly rule: Rule
  readonly checks: ReadonlyArray<Assertion>
  readonly title: string
  readonly severity: Severity
  readonly unit: Unit
  readonly target: Alert["target"]
  breaching: number
  calm: number
  fired: number
  alert: Alert | undefined
}

/** A monitor over these watches. */
export const monitor = (watches: ReadonlyArray<Watch>, options: MonitorOptions): Monitor => {
  const clearAfter = options.clearAfter ?? 3
  const history = options.history ?? 100
  let periodMs = options.periodMs ?? 10_000
  let periodEnd: number | undefined
  let buffer: Array<Frame> = []
  const resolved: Array<Alert> = []

  /** Measure every rule over the period that just ended. */
  const close = (end: number): boolean => {
    let changed = false
    for (const w of watches) {
      const values = w.checks.map((c) => evaluate(c, buffer, []))
      const breach = w.checks.every((c, i) => compare(values[i]!, c.op, c.value))
      const value = values[0]!
      const main = w.checks[0]!
      if (breach) {
        w.breaching++
        w.calm = 0
      } else {
        w.breaching = 0
        if (w.alert !== undefined) w.calm++
      }
      if (w.alert === undefined) {
        if (breach && w.breaching >= w.rule.after) {
          w.fired++
          w.alert = {
            id: `${w.key}#${w.fired}`,
            rule: w.rule.id,
            title: w.title,
            description: w.rule.description,
            severity: w.severity,
            target: w.target,
            check: main.text,
            unit: w.unit,
            firedAt: end,
            value,
            peak: value
          }
          changed = true
        }
        continue
      }
      const worse = main.op === "<" || main.op === "<=" ? Math.min : Math.max
      if (w.calm >= clearAfter) {
        resolved.unshift({ ...w.alert, value, resolvedAt: end })
        if (resolved.length > history) resolved.length = history
        w.alert = undefined
        w.calm = 0
        changed = true
      } else if (value !== w.alert.value) {
        w.alert = { ...w.alert, value, peak: worse(w.alert.peak, value) }
        changed = true
      }
    }
    buffer = []
    return changed
  }

  const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1 }

  return {
    observe: (frames) => {
      let changed = false
      for (const f of frames) {
        if (periodEnd === undefined) {
          // A coarse run (minute-long frames) gets periods at least a frame long.
          periodMs = Math.max(periodMs, f.dt)
          periodEnd = Math.ceil(f.t / periodMs) * periodMs
        }
        while (f.t > periodEnd) {
          changed = close(periodEnd) || changed
          periodEnd += periodMs
        }
        buffer.push(f)
      }
      return changed
    },
    alerts: () => {
      const firing = watches.flatMap((w) => (w.alert === undefined ? [] : [w.alert]))
      firing.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.firedAt - a.firedAt)
      return [...firing, ...resolved]
    }
  }
}
