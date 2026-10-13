import type { Diagnostic } from "../../Diagnostic.ts"
import type { Account } from "../internal/account.ts"
import { type Audit, fmt } from "../internal/service.ts"

/** Schedules in a region (a Scheduler node stands for `schedules` of them) against the account's schedule quota. */
export const audit: Audit = (region, members, quotas) => {
  const account = quotas as Account
  const schedules = members
    .filter((m) => m.type === "aws.scheduler")
    .reduce((sum, m) => sum + ((m.config as { schedules?: number }).schedules ?? 1), 0)
  const out: Array<Diagnostic> = []
  if (schedules > account.schedulerSchedules) {
    out.push({ level: "warning", code: "scheduler-schedules", message: `${region} has ${fmt(schedules)} EventBridge Scheduler schedules, but the account allows ${fmt(account.schedulerSchedules)}.` })
  }
  return out
}
