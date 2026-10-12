import type { Diagnostic } from "../../Diagnostic.ts"
import type { Account } from "../account.ts"
import type { Audit } from "../service.ts"
import { ON_DEMAND_INITIAL_SHARDS, type StreamConfig } from "./config.ts"

const fmt = (n: number): string => n.toLocaleString("en-US")

/**
 * What the region's Kinesis streams ask of the account: shards against the region's shard quota (an on-demand stream
 * starts with four, and grows), and on-demand streams against the 50 an account may have.
 */
export const audit: Audit = (region, members, quotas) => {
  const account = quotas as Account
  const out: Array<Diagnostic> = []
  const streams = members.filter((m) => m.type === "aws.kinesis")
  if (streams.length === 0) return out
  const shards = streams.reduce((sum, m) => {
    const c = m.config as StreamConfig
    return sum + (c.mode === "on-demand" ? ON_DEMAND_INITIAL_SHARDS : c.shards)
  }, 0)
  if (shards > account.kinesisShards) {
    out.push({
      level: "warning",
      code: "kinesis-shards",
      message: `Kinesis streams in ${region} start with ${fmt(shards)} shards; the account allows ${fmt(account.kinesisShards)} in this region. Creating or resharding past it fails (LimitExceededException).`
    })
  }
  const onDemand = streams.filter((m) => (m.config as StreamConfig).mode === "on-demand").length
  if (onDemand > account.kinesisOnDemandStreams) {
    out.push({
      level: "warning",
      code: "kinesis-on-demand-streams",
      message: `${fmt(onDemand)} on-demand Kinesis streams in ${region}; the account allows ${fmt(account.kinesisOnDemandStreams)}.`
    })
  }
  return out
}
