import type { Diagnostic } from "../../Diagnostic.ts"
import type { Account } from "../account.ts"
import type { Audit } from "../service.ts"
import type { QueueConfig } from "./config.ts"

/** The in-flight limit AWS gives a queue by default; asking for more means a quota increase request. */
const DEFAULT_IN_FLIGHT = 120_000

/**
 * What each queue in a region asks of the account, and settings that do nothing for the queue they are on. A queue
 * is checked on its own: an audit sees the settings of the nodes in a placement, not how they are wired.
 */
export const audit: Audit = (region, members, quotas) => {
  const account = quotas as Account
  const out: Array<Diagnostic> = []
  for (const m of members) {
    if (m.type !== "aws.sqs") continue
    const c = m.config as QueueConfig
    const warn = (code: string, message: string, level: Diagnostic["level"] = "warning") => out.push({ level, code, message: `${m.name}: ${message}`, node: m.id })
    if (c.kind === "standard") {
      if (c.highThroughput) warn("sqs-high-throughput-standard", "high throughput is a FIFO mode; a standard queue is already effectively unlimited, so the setting does nothing.", "info")
      if (c.deduplication) warn("sqs-dedup-standard", "deduplication is a FIFO feature; a standard queue can deliver a message more than once and never drops duplicates.", "info")
    } else if (c.highThroughput && account.sqsFifoHighThroughput <= 300) {
      warn("sqs-high-throughput-quota", `high throughput gives no more than normal mode here: the ${region} quota is ${account.sqsFifoHighThroughput.toLocaleString("en-US")} requests a second and normal mode already allows 300.`, "info")
    }
    if (c.inFlightLimit > DEFAULT_IN_FLIGHT) {
      warn("sqs-in-flight-limit", `an in-flight limit of ${c.inFlightLimit.toLocaleString("en-US")} is above the ${DEFAULT_IN_FLIGHT.toLocaleString("en-US")} AWS gives a queue by default; it takes a quota increase request${c.kind === "fifo" ? " to AWS Support (FIFO)" : ""}.`)
    }
  }
  return out
}
