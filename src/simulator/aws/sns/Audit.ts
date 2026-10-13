import type { Diagnostic } from "../../Diagnostic.ts"
import type { Account } from "../internal/account.ts"
import { type Audit, fmt } from "../internal/service.ts"

/** Topics in a region against the account's topic quotas. A topic is FIFO when its `kind` setting says so. */
export const audit: Audit = (region, members, quotas) => {
  const account = quotas as Account
  const topics = members.filter((m) => m.type === "aws.sns")
  const fifo = topics.filter((m) => (m.config as { kind?: string }).kind === "fifo").length
  const standard = topics.length - fifo
  const out: Array<Diagnostic> = []
  if (standard > account.snsStandardTopics) {
    out.push({ level: "warning", code: "sns-standard-topics", message: `${region} has ${fmt(standard)} standard SNS topics, but the account allows ${fmt(account.snsStandardTopics)}.` })
  }
  if (fifo > account.snsFifoTopics) {
    out.push({ level: "warning", code: "sns-fifo-topics", message: `${region} has ${fmt(fifo)} FIFO SNS topics, but the account allows ${fmt(account.snsFifoTopics)}.` })
  }
  return out
}
