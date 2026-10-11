import { Schema } from "effect"
import { type Assertion, compare, evaluate, parseAssertion, type Unit, unitOf } from "./Check.ts"
import type * as Design from "./Design.ts"
import type { Frame } from "./Telemetry.ts"

/**
 * Alarms: what a monitoring system would page someone about.
 *
 * Every design is watched by the alarms a team sets up on day one: errors, throttling, timeouts, dead letters, messages
 * that expired unprocessed, a backlog getting old, a pool at capacity. Each is written in the check language
 * (`Check.ts`) and applied to every node; a node that doesn't report a metric never breaches it, so a queue's backlog
 * rule simply never fires on a function.
 *
 * The monitor works the way CloudWatch alarms do. Telemetry is cut into periods; at the end of each one every rule is
 * measured over it. A rule has to breach for some consecutive periods before it fires, so a blip doesn't page anyone,
 * and stay calm for a few before it resolves, so a flapping alarm doesn't page twice. It is plain code over frames: the
 * engine feeds it as a run plays, a scenario run feeds it as fast as it goes, and both raise the same alerts.
 */

export const Severity = Schema.Literals(["critical", "warning"])
export type Severity = typeof Severity.Type

/** One firing of an alarm: when it went off, how bad it got, and when (if yet) it cleared. Plain data. */
export const Alert = Schema.Struct({
  /** Unique per firing: the same alarm firing again later is a new alert. */
  id: Schema.String,
  /** The rule that fired: `errors`, `throttled`, ... */
  rule: Schema.String,
  title: Schema.String,
  /** What the rule watches, in words. */
  description: Schema.String,
  severity: Severity,
  target: Schema.Struct({ kind: Schema.Literals(["node", "edge"]), id: Schema.String }),
  /** The check that breached, in the check language, naming the node. */
  check: Schema.String,
  unit: Schema.Literals(["ratio", "ms", "count", "rate", "number"]),
  firedAt: Schema.Number,
  /** Absent while it is still firing. */
  resolvedAt: Schema.optionalKey(Schema.Number),
  /** The check's value in the latest period, and the worst it got while firing. */
  value: Schema.Number,
  peak: Schema.Number
})
export type Alert = typeof Alert.Type

// ---------------------------------------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------------------------------------

export interface Rule {
  readonly id: string
  /** `source` is whether the node originates traffic: what it sees, the people using the system see. */
  readonly title: (source: boolean) => string
  readonly description: string
  readonly severity: (source: boolean) => Severity
  /** Checks that must all breach, with `$` for the node. The first is the one shown. */
  readonly checks: ReadonlyArray<string>
  /** Consecutive breaching periods before it fires. */
  readonly after: number
}

const fixed = <A>(value: A) => () => value

/** The standard alarms, in the order they are worth reading. */
export const rules: ReadonlyArray<Rule> = [
  {
    id: "errors",
    title: (source) => (source ? "Clients are seeing errors" : "Error rate above 5%"),
    description: "More than 5% of calls failed (and at least 5 of them) for two periods in a row",
    // Alert on symptoms: failures the clients see are what users see. Failures inside may still be absorbed by retries.
    severity: (source) => (source ? "critical" : "warning"),
    checks: ["$.errorRatio > 5%", "$.total.fail >= 5"],
    after: 2
  },
  {
    id: "throttled",
    title: fixed("Throttling"),
    description: "Calls refused for being over a rate, concurrency or capacity limit",
    severity: fixed("warning"),
    checks: ["$.total.fail.Throttled >= 5"],
    after: 2
  },
  {
    id: "timeouts",
    title: fixed("Calls timing out"),
    description: "Calls given up on after their timeout",
    severity: fixed("warning"),
    checks: ["$.total.fail.Timeout >= 5"],
    after: 2
  },
  {
    id: "expired",
    title: fixed("Messages expired unprocessed"),
    description: "Messages deleted by the retention period before anyone processed them: they are lost",
    severity: fixed("critical"),
    checks: ["$.total.expired >= 1"],
    after: 1
  },
  {
    id: "dead-letters",
    title: fixed("Messages dead-lettered"),
    description: "Messages that failed too many times and were moved to the dead-letter queue",
    severity: fixed("warning"),
    checks: ["$.total.deadLettered >= 1"],
    after: 1
  },
  {
    id: "backlog",
    title: fixed("Backlog getting old"),
    description: "The oldest message waiting has been there more than a minute",
    severity: fixed("warning"),
    checks: ["$.gauge.oldestAgeMs:max > 60s"],
    after: 1
  },
  {
    id: "saturated",
    title: fixed("Running at capacity"),
    description: "Workers more than 90% busy for three periods in a row: requests start to queue",
    severity: fixed("warning"),
    checks: ["$.gauge.utilization > 90%"],
    after: 3
  }
]

/** The rules' checks, parsed once. A placeholder subject stands in for the node until a rule is applied to one. */
const parsed = new Map(
  rules.map((rule) => [
    rule.id,
    rule.checks.map((text) => {
      const a = parseAssertion(text.replace("$", "_"))
      if (typeof a === "string") throw new Error(`Alarm rule ${rule.id}: ${a}`)
      return a
    })
  ])
)

const forNode = (rule: Rule, id: string): ReadonlyArray<Assertion> =>
  parsed.get(rule.id)!.map((a, i) => ({ ...a, text: rule.checks[i]!.replace("$", id), subject: { scope: "node", id } }))

// ---------------------------------------------------------------------------------------------------------
// The monitor
// ---------------------------------------------------------------------------------------------------------

export interface Monitor {
  /** Feed frames as the run produces them. True when an alert fired, resolved or changed. */
  readonly observe: (frames: ReadonlyArray<Frame>) => boolean
  /** Firing alerts first (critical, then newest), then resolved ones, newest first. */
  readonly alerts: () => ReadonlyArray<Alert>
}

export interface MonitorOptions {
  /** Length of an evaluation period in virtual ms. Default 10 s (never shorter than a frame). */
  readonly periodMs?: number
  /** Calm periods in a row before a firing alert resolves. Default 3. */
  readonly clearAfter?: number
  /** Resolved alerts kept. Default 100. */
  readonly history?: number
}

interface Watch {
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

/** Watch a design with the standard rules. Nodes that originate traffic (clients) are told apart by `registry`. */
export const monitor = (
  design: Design.Doc,
  registry: { readonly get: (type: string) => { readonly inputs: boolean; readonly container?: unknown } | undefined },
  options: MonitorOptions = {}
): Monitor => {
  const clearAfter = options.clearAfter ?? 3
  const history = options.history ?? 100
  let periodMs = options.periodMs ?? 10_000
  let periodEnd: number | undefined
  let buffer: Array<Frame> = []
  const resolved: Array<Alert> = []

  const watches: Array<Watch> = []
  for (const [id, node] of Object.entries(design.nodes)) {
    const component = registry.get(node.type)
    if (component?.container !== undefined) continue
    const source = component !== undefined && !component.inputs
    for (const rule of rules) {
      const checks = forNode(rule, id)
      watches.push({
        key: `${rule.id}:${id}`,
        rule,
        checks,
        title: rule.title(source),
        severity: rule.severity(source),
        unit: unitOf(checks[0]!.metric),
        target: { kind: "node", id },
        breaching: 0,
        calm: 0,
        fired: 0,
        alert: undefined
      })
    }
  }

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
