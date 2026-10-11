import type { Diagnostic } from "../../Diagnostic.ts"
import type { Account } from "../account.ts"
import type { Audit } from "../service.ts"

/** Topics in a region against the account's topic quotas. A topic is FIFO when its `kind` setting says so. */
export const audit: Audit = (region, members, quotas) => {
  const account = quotas as Account
  const topics = members.filter((m) => m.type === "aws.sns")
  const fifo = topics.filter((m) => (m.config as { kind?: string }).kind === "fifo").length
  const standard = topics.length - fifo
  const out: Array<Diagnostic> = []
  if (standard > account.snsStandardTopics) {
    out.push({ level: "warning", code: "sns-standard-topics", message: `${region} has ${standard.toLocaleString("en-US")} standard SNS topics, but the account allows ${account.snsStandardTopics.toLocaleString("en-US")}.` })
  }
  if (fifo > account.snsFifoTopics) {
    out.push({ level: "warning", code: "sns-fifo-topics", message: `${region} has ${fifo.toLocaleString("en-US")} FIFO SNS topics, but the account allows ${account.snsFifoTopics.toLocaleString("en-US")}.` })
  }
  return out
}
