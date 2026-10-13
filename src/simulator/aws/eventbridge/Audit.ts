import type { Diagnostic } from "../../Diagnostic.ts"
import type { Account } from "../internal/account.ts"
import { type Audit, fmt } from "../internal/service.ts"

/** Event buses in a region against the account's bus quota. */
export const audit: Audit = (region, members, quotas) => {
  const account = quotas as Account
  const buses = members.filter((m) => m.type === "aws.eventbridge").length
  const out: Array<Diagnostic> = []
  if (buses > account.eventBridgeBuses) {
    out.push({ level: "warning", code: "eventbridge-buses", message: `${region} has ${fmt(buses)} EventBridge event buses, but the account allows ${fmt(account.eventBridgeBuses)}.` })
  }
  return out
}
