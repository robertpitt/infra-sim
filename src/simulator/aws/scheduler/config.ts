import { Effect, Schema } from "effect"
import * as Setting from "../../Setting.ts"
import { docs } from "../docs.ts"
import { retryBackoff, retryPolicy } from "../eventbridge/config.ts"
import { parse, parseDateTime } from "./expression.ts"

/**
 * What EventBridge Scheduler publishes about a schedule, as constants with their sources. Anything that is not on a
 * documentation page is labelled an assumption.
 */

const D = docs.scheduler

/**
 * Every schedule type invokes its target "with 60 second precision": a schedule set for 1:00 invokes between 1:00:00
 * and 1:00:59 when it has no flexible time window (schedule-types.html). Where in the minute is not said; the
 * simulator spreads invocations evenly over it (an assumption).
 */
export const PRECISION_MS = 60_000
/** `FlexibleTimeWindow.MaximumWindowInMinutes`: 1 to 1,440 (API_FlexibleTimeWindow.html). */
export const MAX_WINDOW_MINUTES = 1_440
/** A target's `Input` is at most 256 KB, for every target type, and is not adjustable (scheduler-quotas.html). */
export const MAX_INPUT_KB = 256

/** A text setting checked when the design is read: a design with an unreadable value reports where and why. */
const checkedText = (o: { readonly default: string; readonly label: string; readonly help: string; readonly placeholder: string }, check: (value: string) => string | undefined) =>
  Schema.String.pipe(
    Schema.check(Schema.makeFilter(check)),
    Schema.withDecodingDefault(Effect.succeed(o.default)),
    Schema.annotate({ [Setting.FORM]: { kind: "text", label: o.label, help: o.help, placeholder: o.placeholder } satisfies Setting.Form })
  )

export const Schedule = Schema.Struct({
  enabled: Setting.bool({ default: true, label: "Enabled", help: "The schedule's state. A disabled schedule invokes nothing new; invocations already created carry on." }),
  expression: checkedText(
    {
      default: "rate(1 minute)",
      placeholder: "cron(0 0 * * ? *)",
      label: "Schedule expression",
      help: "rate(5 minutes), rate(1 hour); cron(minutes hours day-of-month month day-of-week year), e.g. cron(0 0 * * ? *) for midnight every day; or at(2026-01-06T00:00:00) for once. Cron and at are read on the clock below."
    },
    (text) => {
      const parsed = parse(text)
      return typeof parsed === "string" ? parsed : undefined
    }
  ),
  clock: checkedText(
    {
      default: "2026-01-05T23:55:00",
      placeholder: "2026-01-05T23:55:00",
      label: "Clock at the start",
      help: "The time on the schedule's clock (in its time zone) when the simulation starts, so a cron or at expression knows when it is. The default is five minutes before midnight on a Monday. Daylight saving changes are not modelled."
    },
    (text) => (parseDateTime(text) === undefined ? "Expected a date and time such as 2026-01-05T23:55:00" : undefined)
  ),
  schedules: Setting.int({
    default: 1,
    min: 1,
    max: 10_000_000,
    unit: "schedules",
    label: "Schedules",
    help: "How many schedules share this expression and target: one per tenant, say. They come due together and each is invoked at its own moment in the window, so many schedules make a burst."
  }),
  flexibleWindow: Setting.int({
    default: 0,
    min: 0,
    max: MAX_WINDOW_MINUTES,
    unit: "min",
    label: "Flexible time window",
    help: "0 is OFF: invocations land within the minute they are due. Otherwise each invocation lands at a random moment up to this many minutes after it is due, which spreads a crowd of schedules out.",
    limit: Setting.hard(`${D}managing-schedule-flexible-time-windows.html`)
  }),
  payload: Setting.number({
    default: 1,
    min: 0,
    max: MAX_INPUT_KB,
    unit: "KB",
    label: "Input size",
    help: "Size of the Input each invocation delivers to the target.",
    limit: Setting.hard(`${D}scheduler-quotas.html`)
  }),
  retryPolicy: retryPolicy("https://docs.aws.amazon.com/scheduler/latest/APIReference/API_RetryPolicy.html"),
  retryBackoff,
  maxPending: Setting.int({
    default: 100_000,
    min: 1,
    max: 10_000_000,
    unit: "invocations",
    label: "Pending invocations",
    help: "Scheduler keeps retrying for up to 24 hours; the simulator has to bound what it remembers. Invocations waiting on the target (delayed or retrying) beyond this are dropped and counted as overflow. An assumption: AWS publishes no such limit."
  })
})
export type ScheduleConfig = typeof Schedule.Type
