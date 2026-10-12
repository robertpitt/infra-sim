import type { Diagnostic } from "../../Diagnostic.ts"
import type { Account } from "../account.ts"
import type { Audit } from "../service.ts"
import { type DeliveryConfig, HTTP_MAX_BUFFER_MIB } from "./config.ts"

const fmt = (n: number): string => n.toLocaleString("en-US")

/**
 * The region's Firehose streams against the account's quota, and settings that don't do what they say for the
 * destination they are on.
 */
export const audit: Audit = (region, members, quotas) => {
  const account = quotas as Account
  const out: Array<Diagnostic> = []
  const streams = members.filter((m) => m.type === "aws.firehose")
  if (streams.length > account.firehoseStreams) {
    out.push({
      level: "warning",
      code: "firehose-streams",
      message: `${fmt(streams.length)} Firehose streams in ${region}; the account allows ${fmt(account.firehoseStreams)}.`
    })
  }
  for (const m of streams) {
    const c = m.config as DeliveryConfig
    if (c.destination === "http" && c.bufferSize > HTTP_MAX_BUFFER_MIB) {
      out.push({
        level: "info",
        code: "firehose-http-buffer",
        node: m.id,
        message: `${m.name}: an HTTP endpoint takes buffers of at most ${HTTP_MAX_BUFFER_MIB} MiB; the ${c.bufferSize} MiB hint is used as ${HTTP_MAX_BUFFER_MIB}.`
      })
    }
  }
  return out
}
