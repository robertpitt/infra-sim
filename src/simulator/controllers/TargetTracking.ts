import { Duration, Effect, Schema } from "effect"
import * as Controller from "../Controller.ts"
import * as Describe from "../Describe.ts"
import * as Setting from "../Setting.ts"
import type { Stats } from "../Telemetry.ts"

export const Config = Schema.Struct({
  metric: Setting.text({
    default: "inflight",
    placeholder: "inflight",
    label: "Metric",
    help: "What it watches on the target, as the target's metrics name it: a gauge (inflight, depth, concurrent), a rate per second (in, ok, fail), or a percentile such as latency.p95."
  }),
  source: Setting.text({
    default: "",
    placeholder: "the target",
    label: "Metric of",
    help: "Another node to read the metric from, by id: the queue whose backlog the target's workers drain (depth per instance, as Application Auto Scaling's backlog-per-instance policy does). Empty: the target's own."
  }),
  per: Setting.choice(["unit", "total"], {
    default: "unit",
    labels: { unit: "Per unit", total: "In total" },
    label: "Target is",
    help: "Per unit: the target is per unit of the setting it changes (requests in flight per unit of concurrency, messages waiting per consumer), the way Kubernetes and Application Auto Scaling track. In total: the metric itself, and the setting moves in proportion."
  }),
  targetValue: Setting.number({ default: 0.7, min: 0, max: 1_000_000_000, step: 0.05, label: "Target value", help: "The value it keeps the metric near." }),
  setting: Setting.text({
    default: "",
    placeholder: "provisioned",
    label: "Setting it changes",
    help: "The number it scales on the target, as a path into the target's settings: provisioned, maxConcurrency, capacity.write."
  }),
  min: Setting.int({ default: 1, min: 0, max: 10_000_000, label: "Minimum" }),
  max: Setting.int({ default: 100, min: 0, max: 10_000_000, label: "Maximum" }),
  window: Setting.duration({ default: "1 minute", min: "1 second", max: "1 hour", label: "Averaged over", help: "The metric is averaged over this long before deciding." }),
  period: Setting.duration({ default: "15 seconds", min: "1 second", max: "10 minutes", label: "Decides every", help: "Kubernetes' horizontal autoscaler looks every 15 seconds; Application Auto Scaling about once a minute." }),
  tolerance: Setting.ratio({ default: 0.1, label: "Tolerance", help: "No change while the metric is within this fraction of the target. Kubernetes uses 10%." }),
  scaleOutCooldown: Setting.duration({ default: "30 seconds", min: 0, max: "1 hour", label: "Scale-out cooldown", help: "After a change, how long before it adds more." }),
  scaleInCooldown: Setting.duration({ default: "5 minutes", min: 0, max: "1 hour", label: "Scale-in cooldown", help: "After a change, how long before it takes any away. Longer than scale-out, so a dip doesn't shed capacity a spike needs." })
})
type Settings = typeof Config.Type

const Decision = Schema.Struct({ t: Schema.Number, from: Schema.Number, to: Schema.Number, value: Schema.Number, reason: Schema.String })
type Decision = typeof Decision.Type

/** How many decisions the probe keeps. */
const KEEP = 20

/** The metric's value in one frame: a gauge, a rate, or `name.p95` of a distribution. `undefined` if the frame doesn't report it. */
export const read = (stats: Stats | undefined, metric: string): number | undefined => {
  if (stats === undefined) return undefined
  const gauge = stats.gauges[metric]
  if (gauge !== undefined) return gauge
  const rate = stats.rates[metric]
  if (rate !== undefined) return rate
  const dot = metric.lastIndexOf(".")
  if (dot > 0) {
    const d = stats.dist[metric.slice(0, dot)]
    const q = metric.slice(dot + 1) as "p50" | "p95" | "p99" | "mean" | "max"
    if (d !== undefined && q in d) return d[q]
  }
  return undefined
}

/**
 * What target tracking wants, given the averaged metric and the setting's current value: proportional, as Kubernetes'
 * horizontal autoscaler computes it (`ceil(current × value / target)`), or for a per-unit target `ceil(value / target)`
 * where `value` is the total. Within `tolerance` of the target it wants no change.
 */
export const desired = (c: Pick<Settings, "per" | "targetValue" | "tolerance" | "min" | "max">, current: number, value: number): number => {
  const lo = Math.min(c.min, c.max)
  const hi = Math.max(c.min, c.max)
  const clamp = (n: number) => Math.min(hi, Math.max(lo, n))
  if (c.targetValue <= 0) return clamp(current)
  const perUnit = c.per === "unit" ? value / Math.max(1, current) : value
  const ratio = c.per === "unit" ? perUnit / c.targetValue : value / c.targetValue
  if (Math.abs(ratio - 1) <= c.tolerance && current >= lo && current <= hi) return current
  const next = c.per === "unit" ? Math.ceil(value / c.targetValue) : Math.ceil(Math.max(1, current) * ratio)
  return clamp(next)
}

/**
 * Target tracking: keep one metric of the target near a value by changing one of its settings. The algorithm of
 * Kubernetes' horizontal pod autoscaler and of Application Auto Scaling's target-tracking policies: average the metric
 * over a window, compare it with the target, move the setting in proportion, within a minimum and a maximum, with a
 * tolerance band and separate cooldowns for adding and removing.
 *
 * It changes the setting through the same door an edit does, so whatever the target does with a new value is what
 * happens: Lambda allocates provisioned concurrency over time, a DynamoDB table's capacity is the new number at once.
 */
export const TargetTracking = Controller.make({
  type: "core.target-tracking",
  title: "Target tracking",
  description: "Keeps a metric of its target near a value by scaling one of its settings: an autoscaler, as Kubernetes and Application Auto Scaling do it.",
  icon: "charts",
  config: Config,
  state: Schema.Struct({
    /** The setting's value now. */
    current: Schema.Number,
    /** The metric, averaged over the window, at the last decision. */
    value: Schema.Number,
    /** What it last wanted. */
    desired: Schema.Number,
    /** Changes it made, newest last. */
    decisions: Schema.Array(Decision)
  }),
  check: (target, c) => {
    const problems: Array<Controller.Issue> = []
    const path = Controller.pathOf(c.setting)
    // Not chosen yet is not a mistake: it just does nothing until it is.
    if (path.length === 0) problems.push(Controller.warning(`names no setting of ${target.title} to change yet, so it does nothing`))
    else {
      const field = Controller.fieldAt(Describe.fields(target.config), path)
      if (field === undefined) problems.push(Controller.error(`${target.title} has no setting "${c.setting}"`))
      else if (field.kind !== "int" && field.kind !== "number") problems.push(Controller.error(`"${c.setting}" on ${target.title} isn't a number`))
    }
    if (c.metric.trim() === "") problems.push(Controller.warning("names no metric to watch yet, so it does nothing"))
    if (c.min > c.max) problems.push(Controller.error(`its minimum (${c.min}) is above its maximum (${c.max})`))
    return problems
  },
  make: (ctx) =>
    Effect.gen(function*() {
      const { fast, meter } = ctx
      /** The metric's value per frame, oldest first: (time, value) pairs. */
      const times: Array<number> = []
      const values: Array<number> = []
      let seen = false
      let warned = false
      /** The last setting path found not to be a number, so it is said once rather than every period. */
      let missing: string | undefined
      let lastChange = -Infinity
      let last = { value: 0, desired: 0 }
      const decisions: Array<Decision> = []

      const rawCurrent = (): unknown => Controller.valueAt(ctx.settings(), Controller.pathOf(fast.settings().setting))
      const currentOf = (): number => {
        const v = rawCurrent()
        return typeof v === "number" ? v : 0
      }
      meter.gaugeUnsafe("value", () => last.value)
      meter.gaugeUnsafe("current", currentOf)
      meter.gaugeUnsafe("desired", () => last.desired)

      const source = (): string | undefined => fast.settings().source.trim() || undefined
      yield* ctx.watch((stats, t) =>
        Effect.sync(() => {
          const v = read(stats, fast.settings().metric)
          // A rate that saw nothing this frame isn't reported, and means zero; a metric never seen at all is a mistake.
          if (v !== undefined) seen = true
          times.push(t)
          values.push(v ?? 0)
          const from = t - Duration.toMillis(fast.settings().window)
          while (times.length > 0 && times[0]! < from) {
            times.shift()
            values.shift()
          }
        }), source
      )

      const decide = (): Effect.Effect<void> =>
        Effect.suspend(() => {
          const c = fast.settings()
          const now = fast.now()
          // Nothing chosen to change or to watch yet (see `check`).
          if (Controller.pathOf(c.setting).length === 0 || c.metric.trim() === "") return Effect.void
          // Edited live to a setting the target doesn't have as a number: the design checks say so; here, leave it be.
          if (typeof rawCurrent() !== "number") {
            if (missing !== c.setting) {
              missing = c.setting
              ctx.log(`${ctx.target} has no number called "${c.setting}" to change`)
            }
            return Effect.void
          }
          if (!seen) {
            if (!warned && values.length > 0) {
              warned = true
              ctx.log(`${source() ?? ctx.target} reports no metric called "${c.metric}"; nothing will change until it does`)
            }
            return Effect.void
          }
          if (values.length === 0) return Effect.void
          let sum = 0
          for (const v of values) sum += v
          const value = sum / values.length
          const current = currentOf()
          const next = desired(c, current, value)
          last = { value, desired: next }
          if (next === current) return Effect.void
          const cooldown = Duration.toMillis(next > current ? c.scaleOutCooldown : c.scaleInCooldown)
          if (now - lastChange < cooldown) return Effect.void
          const reason = `${c.metric} ${value.toFixed(2)}${c.per === "unit" ? ` (${(value / Math.max(1, current)).toFixed(2)} per unit)` : ""} against a target of ${c.targetValue}`
          return ctx.set(Controller.pathOf(c.setting), next).pipe(
            Effect.map(() => {
              lastChange = now
              decisions.push({ t: now, from: current, to: next, value, reason })
              if (decisions.length > KEEP) decisions.shift()
            }),
            Effect.catch((problems) => Effect.sync(() => ctx.log(`couldn't set ${c.setting} to ${next}: ${problems.join("; ")}`)))
          )
        })

      // Decide on a timer of its own, so a change to how often applies from the next decision.
      const loop: Effect.Effect<void> = Effect.suspend(() => Effect.sleep(Duration.toMillis(fast.settings().period))).pipe(
        Effect.andThen(decide()),
        Effect.forever
      )
      yield* ctx.spawn(loop)

      return {
        probe: Effect.sync(() => ({ current: currentOf(), value: last.value, desired: last.desired, decisions: [...decisions] }))
      }
    })
})
