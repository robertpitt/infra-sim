import * as Setting from "../../Setting.ts"
import { SOURCES } from "./config.ts"

/**
 * Direct PUT throughput of one Firehose stream, by region (General Reference: "Rate of data", "Rate of records", "Rate
 * of Put requests"). The three are raised together, in proportion: raising the MiB/s raises the others with it.
 */
const BIG = ["us-east-1", "us-west-2", "eu-west-1"]
export const directPutBase = (region: string) =>
  BIG.includes(region) ? { mibps: 5, records: 500_000, requests: 2_000 } : { mibps: 1, records: 100_000, requests: 1_000 }

/** Firehose streams an account may have in a region (General Reference, "Delivery streams"). */
const STREAMS: ReadonlyArray<readonly [streams: number, regions: ReadonlyArray<string>]> = [
  [5_000, ["us-east-1", "us-east-2", "us-west-2", "ap-northeast-1", "eu-west-1"]],
  [2_000, ["us-west-1", "ap-northeast-2", "ap-south-1", "ap-southeast-1", "ap-southeast-2", "ca-central-1", "eu-central-1", "eu-west-2"]],
  [500, ["ap-northeast-3", "eu-north-1", "eu-south-1", "eu-west-3", "sa-east-1"]]
]
const STREAMS_ELSEWHERE = 100

export const firehoseStreamQuota = (region: string): number => STREAMS.find(([, regions]) => regions.includes(region))?.[0] ?? STREAMS_ELSEWHERE

/**
 * The account-level quotas Firehose contributes. The Direct PUT rate is a quota of each stream, but its default is set by
 * region, so it lives here and every stream in the region gets it.
 */
export const quotas = (region: string) => ({
  firehoseDirectPutMiBps: Setting.number({
    default: directPutBase(region).mibps,
    min: 0.1,
    max: 1_000,
    step: 0.5,
    unit: "MiB/s",
    label: "Firehose Direct PUT throughput",
    help: `Per Firehose stream, with records/s and requests/s raised in proportion (here ${directPutBase(region).records.toLocaleString("en-US")} records/s and ${directPutBase(region).requests.toLocaleString("en-US")} requests/s at the default). Streams reading a Kinesis stream aren't limited by it.`,
    limit: Setting.quota(SOURCES.quotas, "5 MiB/s, 500,000 records/s and 2,000 requests/s in N. Virginia, Oregon and Ireland; 1 MiB/s, 100,000 and 1,000 elsewhere.")
  }),
  firehoseStreams: Setting.int({
    default: firehoseStreamQuota(region),
    min: 1,
    max: 100_000,
    unit: "streams",
    label: "Firehose streams per region",
    limit: Setting.quota(SOURCES.quotas)
  })
})
