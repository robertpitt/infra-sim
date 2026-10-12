import { Duration, Effect, Schema } from "effect"
import { type Tally, tallies, totals } from "../../kit/Tally.ts"
import * as Component from "../../Component.ts"
import * as Aws from "../provider.ts"
import { Dispatcher, limitsOf, Pacer, type Policy, Target } from "../eventbridge/delivery.ts"
import { MAX_INPUT_KB, PRECISION_MS, Schedule, type ScheduleConfig } from "./config.ts"
import { dashboard } from "./dashboard.ts"
import { type Expression, MINUTE_MS, nextCron, parse, parseDateTime } from "./expression.ts"
import { QUOTAS_PAGE } from "./quotas.ts"

const D = Aws.docs.scheduler

/** Longest the scheduler waits before reading its settings again, so an edit (a new expression, a pause) applies promptly. */
const MAX_NAP_MS = 1_000

/** The last expression text read and what it parsed to: settings change rarely, so one entry is enough. */
const parsedOnce = () => {
  let text: string | undefined
  let parsed: Expression | string = ""
  return (next: string): Expression | undefined => {
    if (next !== text) {
      text = next
      parsed = parse(next)
    }
    return typeof parsed === "string" ? undefined : parsed
  }
}

const policies = new WeakMap<ScheduleConfig, Policy>()
const policyOf = (c: ScheduleConfig, deadLetter: boolean): Policy => {
  let p = policies.get(c)
  if (p === undefined) {
    p = { maxRetries: c.retryPolicy.maxRetries, maxEventAgeMs: Duration.toMillis(c.retryPolicy.maxEventAge), deadLetter, targetRate: 0, attemptTimeoutMs: Infinity }
    policies.set(c, p)
  }
  return p
}

export const Scheduler = Aws.component({
  type: "aws.scheduler",
  service: "EventBridge Scheduler",
  title: "EventBridge Scheduler",
  description:
    "Invokes a target on a schedule (rate, cron or once), for one schedule or thousands that share it. A flexible time window spreads them out; the region's invocation quota delays the excess; failures are retried for up to a day and then dead-lettered.",
  docs: `${D}what-is-scheduler.html`,
  // A source of traffic, but what it is for is integration: it sits with EventBridge in the palette.
  category: "messaging",
  icon: "clock",
  accent: "#e7157b",
  inputs: false,
  limits: [
    { label: "Invocations", value: "per region, set in the account quotas (1,000/s in the larger regions, 500/s elsewhere)", adjustable: true, source: QUOTAS_PAGE, note: "Over it, invocations are delayed rather than refused." },
    { label: "Schedules", value: "10,000,000 per region", adjustable: true, source: QUOTAS_PAGE, note: "Checked against the account quotas." },
    { label: "Precision", value: "60 seconds: a schedule due at 1:00 invokes between 1:00:00 and 1:00:59", adjustable: false, source: `${D}schedule-types.html` },
    { label: "Flexible time window", value: "OFF, or 1 to 1,440 minutes", adjustable: false, source: "https://docs.aws.amazon.com/scheduler/latest/APIReference/API_FlexibleTimeWindow.html" },
    { label: "Retry policy", value: "0 to 185 retries, 60 s to 24 hours (185 and 24 hours by default)", adjustable: false, source: "https://docs.aws.amazon.com/scheduler/latest/APIReference/API_RetryPolicy.html" },
    { label: "Input", value: `${MAX_INPUT_KB} KB`, adjustable: false, source: QUOTAS_PAGE },
    { label: "Dead-letter queue", value: "a standard SQS queue", adjustable: false, source: `${D}configuring-schedule-dlq.html` },
    { label: "Lambda targets", value: "invoked asynchronously", adjustable: false, source: "https://docs.aws.amazon.com/lambda/latest/dg/with-eventbridge-scheduler.html" }
  ],
  dashboard,
  highlights: [
    { rate: "invocations", label: "invokes/s" },
    { gauge: "pending", label: "pending" },
    { rate: "dropped", label: "lost/s" }
  ],
  config: Schedule,
  ports: {
    out: Component.port.one("Target"),
    dlq: Component.port.one("Dead-letter queue")
  },
  state: Schema.Struct({
    /** Virtual time (ms) the expression next comes due, or -1 if it never will (disabled, past, unreadable). */
    next: Schema.Number,
    /** Times the expression came due. */
    occurrences: Schema.Number,
    /** Occurrences whose invocations are still being spread over their window. */
    windows: Schema.Number,
    noTarget: Schema.Number,
    pending: Schema.Number,
    invocations: Schema.Number,
    attempts: Schema.Number,
    delivered: Schema.Number,
    retries: Schema.Number,
    failed: Schema.Number,
    dropped: Schema.Number,
    deadLettered: Schema.Number,
    deadLetterFailed: Schema.Number,
    expired: Schema.Number,
    delayed: Schema.Number,
    overflow: Schema.Number,
    /** How long a new invocation would wait for the region's invocation quota, in ms. */
    quotaWait: Schema.Number
  }),
  make: (node) =>
    Effect.gen(function*() {
      const { fast } = node
      // One invocation quota for every schedule in the region, as AWS counts it per account and Region.
      const quota = yield* node.shared("scheduler/invocations", Effect.sync(() => new Pacer()))
      const target = node.out("out").map((link) => new Target(link))[0]
      const deadLetter = node.out("dlq").length > 0
      const dispatcher = new Dispatcher(
        fast,
        node.meter,
        node.out("dlq"),
        quota,
        () => (fast.account() as Aws.Account).schedulerInvocationRate,
        () => {
          const c = fast.settings()
          return limitsOf(c, c.maxPending)
        },
        // A schedule is a source of traffic: what it sends and how that ends is what the system's sources see.
        true
      )
      const counts: Record<"occurrences" | "noTarget", Tally> = tallies(node.meter, ["occurrences", "noTarget"])
      const expressionOf = parsedOnce()
      let clockText: string | undefined
      let clockMs = 0
      /** Virtual time of the last occurrence, or `undefined` before the first. */
      let last: number | undefined
      let next = -1
      let windows = 0
      node.meter.gaugeUnsafe("pending", () => dispatcher.pending)
      node.meter.gaugeUnsafe("quotaWait", () => dispatcher.quotaWait())
      // The region's invocation quota, shared by every schedule there: the line its invocations are read against.
      node.meter.gaugeUnsafe("invocationQuota", () => (fast.account() as Aws.Account).schedulerInvocationRate)

      /** Virtual time of the expression's next occurrence at or after `now`, or `undefined` if none. */
      const due = (c: ScheduleConfig, now: number): number | undefined => {
        if (!c.enabled) return undefined
        const expression = expressionOf(c.expression)
        if (expression === undefined) return undefined
        if (c.clock !== clockText) {
          clockText = c.clock
          clockMs = parseDateTime(c.clock) ?? 0
        }
        switch (expression.kind) {
          case "rate":
            // A rate schedule with no start date starts at once, then runs every period. One that fell behind (it
            // was disabled, or its rate shortened) goes now rather than catching up.
            return last === undefined ? now : Math.max(now, last + expression.periodMs)
          case "cron": {
            const from = Math.max(now, last === undefined ? now : last + MINUTE_MS)
            const wall = nextCron(expression.cron, clockMs + from)
            return wall === undefined ? undefined : wall - clockMs
          }
          case "at": {
            const at = expression.atMs - clockMs
            return last === undefined && at >= now ? at : undefined
          }
        }
      }

      /** One schedule's invocation, created now. */
      const invoke = (): void => {
        if (target === undefined) {
          counts.noTarget.add(1)
          return
        }
        const c = fast.settings()
        const message = fast.mint({ bytes: Math.round(c.payload * 1024), invocation: "async" })
        dispatcher.dispatch(target, message, policyOf(c, deadLetter), 0)
      }

      /**
       * The schedules of one occurrence, each invoked at its own uniformly random moment in the window. The moments are
       * drawn in order (order statistics: the next of `remaining` uniform points in [at, end) is
       * `at + (end - at)(1 - U^(1/remaining))`), so a burst of a million costs one timer at a time, not a million.
       */
      class Window {
        constructor(private at: number, private readonly end: number, private remaining: number) {}

        step(): void {
          const u = fast.random.nextDoubleUnsafe()
          this.at += (this.end - this.at) * (1 - u ** (1 / this.remaining))
          fast.after(Math.max(0, this.at - fast.now()), fire, this)
        }

        fire(): void {
          // Disabling a schedule stops what it has not yet invoked.
          if (!fast.settings().enabled) {
            windows--
            return
          }
          invoke()
          if (--this.remaining > 0) this.step()
          else windows--
        }
      }
      const fire = (w: Window): void => w.fire()

      const occur = (at: number, c: ScheduleConfig): void => {
        counts.occurrences.add(1)
        windows++
        const window = c.flexibleWindow > 0 ? c.flexibleWindow * MINUTE_MS : PRECISION_MS
        new Window(at, at + window, c.schedules).step()
      }

      /** Wake at the next occurrence or after a nap, whichever is first, and start what has come due. */
      const wake = (): void => {
        const now = fast.now()
        const c = fast.settings()
        const at = due(c, now)
        if (at !== undefined && at <= now) {
          last = at
          occur(at, c)
          return wake()
        }
        next = at ?? -1
        fast.after(at === undefined ? MAX_NAP_MS : Math.min(MAX_NAP_MS, at - now), wake, undefined)
      }
      fast.after(0, wake, undefined)

      return {
        probe: Effect.sync(() => ({
          next,
          windows,
          ...totals(counts),
          ...dispatcher.totals,
          pending: dispatcher.pending,
          quotaWait: dispatcher.quotaWait()
        }))
      }
    })
})
