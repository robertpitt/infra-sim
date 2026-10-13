import * as Setting from "../../Setting.ts"
import { SOURCES } from "./internal/config.ts"

/** Shards an account may hold in a region (General Reference, "Shards per Region"). */
const SHARDS: ReadonlyArray<readonly [shards: number, regions: ReadonlyArray<string>]> = [
  [20_000, ["us-east-1", "us-west-2", "eu-west-1"]],
  [6_000, ["us-east-2", "ap-northeast-1", "ap-south-1", "ap-southeast-1", "ap-southeast-2", "eu-central-1", "eu-west-3"]]
]
const SHARDS_ELSEWHERE = 1_000

/** On-demand streams scale to 10 GB/s of writes in these three regions, 200 MB/s elsewhere (limits page). */
const ON_DEMAND_BIG = ["us-east-1", "us-west-2", "eu-west-1"]

export const kinesisShardQuota = (region: string): number => SHARDS.find(([, regions]) => regions.includes(region))?.[0] ?? SHARDS_ELSEWHERE

/**
 * The account-level quotas Kinesis Data Streams contributes. Defaults are AWS's published numbers for the region; the
 * stream's own limits (per shard, per request) are on the component.
 */
export const quotas = (region: string) => ({
  kinesisShards: Setting.int({
    default: kinesisShardQuota(region),
    min: 1,
    max: 1_000_000,
    unit: "shards",
    label: "Kinesis shards per region",
    help: "Shards every stream in this region may hold together, on-demand streams included. Resharding creates short-lived shards that count too.",
    limit: Setting.quota(SOURCES.quotas)
  }),
  kinesisOnDemandStreams: Setting.int({
    default: 50,
    min: 1,
    max: 10_000,
    unit: "streams",
    label: "Kinesis on-demand streams",
    help: "Streams in on-demand mode an account may have. Provisioned streams have no such limit.",
    limit: Setting.quota(SOURCES.limits)
  }),
  kinesisOnDemandWriteMBps: Setting.int({
    default: ON_DEMAND_BIG.includes(region) ? 10_000 : 200,
    min: 4,
    max: 10_000,
    unit: "MB/s",
    label: "Kinesis on-demand write ceiling",
    help: "The most one on-demand stream scales to (reads get twice this). 10 GB/s in N. Virginia, Oregon and Ireland; 200 MB/s elsewhere, raisable to 10 GB/s on request.",
    limit: Setting.quota(SOURCES.limits)
  })
})
