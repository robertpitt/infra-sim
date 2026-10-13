import * as Setting from "../../Setting.ts"
import { QUOTAS } from "./internal/limits.ts"

/**
 * The account-level quotas S3 contributes. S3 has few: it limits requests by prefix (a property of the bucket, see
 * `config.ts`), not by account. These three are the ones the model uses; the rest of the S3 quotas page (access points,
 * lifecycle rules, replication rules) limits what a bucket can be configured with, which the simulator does not model.
 * None of them differs by region.
 */
export const quotas = (_region: string) => ({
  s3GeneralPurposeBuckets: Setting.int({
    default: 10_000,
    min: 1,
    max: 10_000_000,
    unit: "buckets",
    label: "S3 general purpose buckets",
    help: "General purpose buckets an account can own. It is an account-wide quota; the check here only counts the buckets of this design in one region.",
    limit: Setting.quota(QUOTAS, "Adjustable through Service Quotas.")
  }),
  s3DirectoryBuckets: Setting.int({
    default: 100,
    min: 1,
    max: 10_000_000,
    unit: "buckets",
    label: "S3 directory buckets",
    help: "S3 Express One Zone directory buckets an account can own.",
    limit: Setting.quota(QUOTAS, "Adjustable through Service Quotas.")
  }),
  s3ReplicationTransferRate: Setting.number({
    default: 1,
    min: 0.001,
    max: 10_000,
    step: 0.1,
    unit: "Gb/s",
    label: "S3 Replication Time Control transfer rate",
    help: "The most data a region's buckets can replicate with S3 RTC, together. Beyond it the 15-minute SLA stops applying and replicas queue.",
    limit: Setting.quota(QUOTAS, "Adjustable through Service Quotas; \"Replication transfer rate\" is 1 Gbps by default.")
  })
})
