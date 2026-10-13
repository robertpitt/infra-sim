/**
 * How often an EventBridge or SAM schedule fires. A template says "every 5 minutes" or "9 to 5 on weekdays" in a
 * `rate()` or `cron()` expression; the simulator wants events per second. A schedule becomes a client that fires at
 * that rate.
 */
import type { Draft, Origin, Run } from "./model.ts"

/** How often a schedule expression fires, in events per second. `undefined` if it can't be read. */
export const scheduleRate = (expression: string): { readonly rps: number; readonly exact: boolean } | undefined => {
  const rate = /^rate\(\s*(\d+(?:\.\d+)?)\s+(minute|minutes|hour|hours|day|days)\s*\)$/.exec(expression.trim())
  if (rate !== null) {
    const unit = rate[2]!.startsWith("minute") ? 60 : rate[2]!.startsWith("hour") ? 3600 : 86_400
    return { rps: 1 / (Number(rate[1]) * unit), exact: true }
  }
  const cron = /^cron\(\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(\S+))?\s*\)$/.exec(expression.trim())
  if (cron === null) return undefined
  // How many values a cron field matches out of `total`: `*`, `*/5`, `0/15`, `1,15`, `9-17`, `7`.
  const count = (field: string, total: number): number => {
    if (field === "*" || field === "?") return total
    return field.split(",").reduce((n, part) => {
      const step = /^(\*|\d+)\/(\d+)$/.exec(part)
      if (step !== null) return n + Math.ceil((total - (step[1] === "*" ? 0 : Number(step[1]))) / Number(step[2]))
      const range = /^(\d+)-(\d+)$/.exec(part)
      return n + (range !== null ? Number(range[2]) - Number(range[1]) + 1 : 1)
    }, 0)
  }
  // Day names count like numbers: SUN-SAT is 1-7.
  const dayNumber = (field: string): string => field.replace(/SUN|MON|TUE|WED|THU|FRI|SAT/gi, (d) => String(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].indexOf(d.toUpperCase()) + 1))
  cron[5] = dayNumber(cron[5]!)
  const perDay = count(cron[1]!, 60) * count(cron[2]!, 24)
  const days = cron[3] !== "*" && cron[3] !== "?" ? count(cron[3]!, 30) / 30 : cron[5] !== "*" && cron[5] !== "?" ? count(cron[5]!, 7) / 7 : 1
  // Exact unless particular days of the month are named, which depends on how long a month is.
  return { rps: (perDay * days) / 86_400, exact: cron[3] === "*" || cron[3] === "?" }
}

/**
 * A schedule as a source of traffic: a client firing asynchronous calls at the schedule's rate, evenly spaced. `field`
 * is the template property the rate came from. Says so when the rate is an approximation.
 */
export const scheduleClient = (
  run: Run,
  key: string,
  name: string,
  origin: Origin,
  field: string,
  expression: string,
  rate: { readonly rps: number; readonly exact: boolean },
  wire: (client: Draft) => void = () => {}
): Draft => {
  const d = run.draft(key, name, "common.client", origin)
  run.set(d, ["rps"], rate.rps, field)
  run.set(d, ["arrival"], "constant", field)
  run.set(d, ["invocation"], "async", field)
  wire(d)
  if (!rate.exact) run.warn(`${d.name}: "${expression}" is approximated as about ${(rate.rps * 3600).toFixed(2)} runs an hour.`)
  return d
}
