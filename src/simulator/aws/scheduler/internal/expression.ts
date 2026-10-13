import { DAY_MS, MINUTE_MS } from "../../internal/units.ts"

/**
 * Schedule expressions as EventBridge Scheduler writes them (schedule-types.html): `rate(5 minutes)`,
 * `cron(0 0 * * ? *)` and `at(2026-01-06T00:00:00)`, and the moments they name.
 *
 * Times here are wall-clock milliseconds on the schedule's own clock (its time zone), computed with the UTC calendar
 * so that nothing depends on where the simulator runs. Daylight saving changes are not modelled.
 */

export type Expression =
  | { readonly kind: "rate"; readonly periodMs: number }
  | { readonly kind: "cron"; readonly cron: Cron }
  | { readonly kind: "at"; readonly atMs: number }

/** A parsed cron expression: which minutes, hours, months and years, and which days. */
export interface Cron {
  readonly minutes: ReadonlyArray<boolean>
  readonly hours: ReadonlyArray<boolean>
  readonly months: ReadonlyArray<boolean>
  readonly years: ReadonlyArray<boolean>
  /** Whether a calendar day matches the day-of-month or day-of-week field (exactly one of them is `?`). */
  readonly day: (year: number, month: number, date: number, weekday: number) => boolean
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]
const FIRST_YEAR = 1970
const LAST_YEAR = 2199
/** How far ahead to look for a cron's next day: eight years covers every leap-day and weekday combination. */
const SEARCH_DAYS = 366 * 8

/** Parse an expression, or say what is wrong with it. */
export const parse = (text: string): Expression | string => {
  const t = text.trim()
  const rate = /^rate\(\s*(\d+)\s+(minute|minutes|hour|hours|day|days)\s*\)$/i.exec(t)
  if (rate !== null) {
    const value = Number(rate[1])
    if (value < 1) return "A rate must be a positive whole number"
    const unit = rate[2]!.toLowerCase()
    const ms = unit.startsWith("minute") ? MINUTE_MS : unit.startsWith("hour") ? 60 * MINUTE_MS : DAY_MS
    return { kind: "rate", periodMs: value * ms }
  }
  const at = /^at\((.+)\)$/i.exec(t)
  if (at !== null) {
    const atMs = parseDateTime(at[1]!.trim(), false)
    return atMs === undefined ? "Expected at(yyyy-mm-ddThh:mm:ss)" : { kind: "at", atMs }
  }
  const cron = /^cron\((.*)\)$/i.exec(t)
  if (cron !== null) return parseCron(cron[1]!)
  return "Expected rate(value unit), cron(minutes hours day-of-month month day-of-week year) or at(yyyy-mm-ddThh:mm:ss)"
}

/** A date and time as `yyyy-mm-ddThh:mm[:ss]`, optionally ending in `Z`, as wall-clock milliseconds. */
export const parseDateTime = (text: string, allowZ = true): number | undefined => {
  const m = (allowZ ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?Z?$/ : /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/).exec(text.trim())
  if (m === null) return undefined
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number) as [number, number, number, number, number, number]
  if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo) || h > 23 || mi > 59 || s > 59) return undefined
  return Date.UTC(y, mo - 1, d, h, mi, s)
}

const daysIn = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate()

/**
 * One cron field as a set of allowed values: `*`, `5`, `1,15`, `9-17`, `*\/5`, `0/15`, `10-30/5`, and names where the
 * field has them (JAN-DEC, SUN-SAT).
 */
const field = (text: string, min: number, max: number, names?: ReadonlyArray<string>): Array<boolean> | string => {
  const allowed = new Array<boolean>(max + 1).fill(false)
  const value = (v: string): number | undefined => {
    const named = names?.indexOf(v.toUpperCase()) ?? -1
    if (named >= 0) return named + min
    if (!/^\d+$/.test(v)) return undefined
    const n = Number(v)
    return n >= min && n <= max ? n : undefined
  }
  for (const part of text.split(",")) {
    const m = /^(\*|[A-Za-z0-9]+)(?:-([A-Za-z0-9]+))?(?:\/(\d+))?$/.exec(part)
    if (m === null) return `"${part}" is not a valid value`
    const step = m[3] === undefined ? 1 : Number(m[3])
    if (step < 1) return `"${part}" has a step of 0`
    let from: number | undefined
    let to: number | undefined
    if (m[1] === "*") {
      if (m[2] !== undefined) return `"${part}" is not a valid range`
      from = min
      to = max
    } else {
      from = value(m[1]!)
      to = m[2] !== undefined ? value(m[2]) : m[3] !== undefined ? max : from
    }
    if (from === undefined || to === undefined || to < from) return `"${part}" is outside ${min}-${max}`
    for (let v = from; v <= to; v += step) allowed[v] = true
  }
  return allowed
}

const parseCron = (body: string): Expression | string => {
  const parts = body.trim().split(/\s+/)
  if (parts.length !== 6) return "A cron expression has six fields: minutes hours day-of-month month day-of-week year"
  const [min, hour, dom, month, dow, year] = parts as [string, string, string, string, string, string]
  if ((dom === "?") === (dow === "?")) return "Use ? in exactly one of day-of-month and day-of-week"
  const minutes = field(min, 0, 59)
  if (typeof minutes === "string") return `Minutes: ${minutes}`
  const hours = field(hour, 0, 23)
  if (typeof hours === "string") return `Hours: ${hours}`
  const months = field(month, 1, 12, MONTHS)
  if (typeof months === "string") return `Month: ${months}`
  const years = field(year, FIRST_YEAR, LAST_YEAR)
  if (typeof years === "string") return `Year: ${years}`
  const day = dom === "?" ? weekdayMatcher(dow) : monthDayMatcher(dom)
  if (typeof day === "string") return day
  return { kind: "cron", cron: { minutes, hours, months, years, day } }
}

type DayMatcher = Cron["day"]

/** Day-of-month: values, `L` (the last day), `LW` (the last weekday), `15W` (the weekday nearest the 15th). */
const monthDayMatcher = (text: string): DayMatcher | string => {
  if (text === "L") return (y, m, d) => d === daysIn(y, m)
  if (text === "LW") return (y, m, d) => d === lastWeekday(y, m)
  const nearest = /^(\d+)W$/.exec(text)
  if (nearest !== null) {
    const target = Number(nearest[1])
    if (target < 1 || target > 31) return `Day-of-month: "${text}" is outside 1-31`
    return (y, m, d) => d === nearestWeekday(y, m, target)
  }
  const allowed = field(text, 1, 31)
  if (typeof allowed === "string") return `Day-of-month: ${allowed}`
  return (_y, _m, d) => allowed[d] === true
}

/** Day-of-week (1 is Sunday): values, `L` (Saturday), `6L` (the last Friday of the month), `3#2` (the second Tuesday). */
const weekdayMatcher = (text: string): DayMatcher | string => {
  if (text === "L") return (_y, _m, _d, w) => w === 7
  const last = /^([1-7]|[A-Za-z]{3})L$/.exec(text)
  if (last !== null) {
    const w = weekdayOf(last[1]!)
    if (w === undefined) return `Day-of-week: "${text}" is not a day`
    return (y, m, d, weekday) => weekday === w && d + 7 > daysIn(y, m)
  }
  const nth = /^([1-7]|[A-Za-z]{3})#([1-5])$/.exec(text)
  if (nth !== null) {
    const w = weekdayOf(nth[1]!)
    if (w === undefined) return `Day-of-week: "${text}" is not a day`
    const k = Number(nth[2])
    return (_y, _m, d, weekday) => weekday === w && Math.ceil(d / 7) === k
  }
  const allowed = field(text, 1, 7, WEEKDAYS)
  if (typeof allowed === "string") return `Day-of-week: ${allowed}`
  return (_y, _m, _d, w) => allowed[w] === true
}

const weekdayOf = (v: string): number | undefined => {
  const named = WEEKDAYS.indexOf(v.toUpperCase())
  if (named >= 0) return named + 1
  const n = Number(v)
  return n >= 1 && n <= 7 ? n : undefined
}

/** Day of the week of a date, 1 (Sunday) to 7 (Saturday). */
const weekdayAt = (y: number, m: number, d: number): number => new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 1

const lastWeekday = (y: number, m: number): number => {
  let d = daysIn(y, m)
  while (weekdayAt(y, m, d) === 1 || weekdayAt(y, m, d) === 7) d--
  return d
}

/** The weekday nearest the `target`th, without leaving the month (AWS's and Quartz's `W`). */
const nearestWeekday = (y: number, m: number, target: number): number => {
  const days = daysIn(y, m)
  const d = Math.min(target, days)
  const w = weekdayAt(y, m, d)
  if (w === 7) return d === 1 ? 3 : d - 1
  if (w === 1) return d === days ? d - 2 : d + 1
  return d
}

/** The first moment at or after `fromMs` (wall clock) that a cron expression names, or `undefined` if none comes. */
export const nextCron = (cron: Cron, fromMs: number): number | undefined => {
  let t = Math.ceil(fromMs / MINUTE_MS) * MINUTE_MS
  for (let i = 0; i < SEARCH_DAYS; i++) {
    const dayStart = Math.floor(t / DAY_MS) * DAY_MS
    const date = new Date(dayStart)
    const y = date.getUTCFullYear()
    if (y > LAST_YEAR) return undefined
    const m = date.getUTCMonth() + 1
    const d = date.getUTCDate()
    if (cron.years[y] === true && cron.months[m] === true && cron.day(y, m, d, date.getUTCDay() + 1)) {
      const first = (t - dayStart) / MINUTE_MS
      for (let minuteOfDay = first; minuteOfDay < 1440; minuteOfDay++) {
        if (cron.hours[Math.floor(minuteOfDay / 60)] === true && cron.minutes[minuteOfDay % 60] === true) return dayStart + minuteOfDay * MINUTE_MS
      }
    }
    t = dayStart + DAY_MS
  }
  return undefined
}
