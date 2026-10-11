import * as Setting from "../../Setting.ts"
import { docs } from "../docs.ts"

/**
 * The Regions where the standard-topic publish quota is 1,500 messages per second. The same Regions are the ones whose
 * FIFO quota is 3,000 (as is every Region not listed in `snsFifoRate`'s first two tiers).
 */
const MID_TIER = new Set(["us-east-2", "us-west-1", "ap-south-1", "ap-northeast-2", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1", "eu-central-1"])

/** Messages per second an account may publish to standard topics in a Region (Publish and PublishBatch together). */
export const snsStandardRate = (region: string): number =>
  region === "us-east-1" ? 30_000 : region === "us-west-2" || region === "eu-west-1" ? 9_000 : MID_TIER.has(region) ? 1_500 : 300

/** The same for FIFO topics: the large Regions match the standard figure, every other Region gets 3,000. */
export const snsFifoRate = (region: string): number =>
  region === "us-east-1" ? 30_000 : region === "us-west-2" || region === "eu-west-1" ? 9_000 : 3_000

/** Topics an account may have, whatever the Region: 100,000 standard and 1,000 FIFO. */
export const STANDARD_TOPICS = 100_000
export const FIFO_TOPICS = 1_000

/**
 * The account-level quotas this service contributes: limits that belong to an AWS account in a region rather than to
 * one resource, and that every resource of the service in that region shares. Each is an editable setting whose default
 * is AWS's published number for that region. They are merged into the provider's account form (`../account.ts`).
 */
export const quotas = (region: string) => ({
  snsPublishRate: Setting.int({
    default: snsStandardRate(region),
    min: 1,
    max: 10_000_000,
    unit: "msg/s",
    label: "SNS publish rate (standard)",
    help: "Messages published per second across every standard topic in this region (Publish and PublishBatch together, counting each message of a batch).",
    limit: Setting.quota(docs.snsQuotas)
  }),
  snsFifoPublishRate: Setting.int({
    default: snsFifoRate(region),
    min: 1,
    max: 10_000_000,
    unit: "msg/s",
    label: "SNS publish rate (FIFO)",
    help: "Messages published per second across every FIFO topic in this region. A topic in Topic throughput scope is further limited to 3,000 a second, and every message group to 300.",
    limit: Setting.quota(docs.snsQuotas)
  }),
  snsStandardTopics: Setting.int({
    default: STANDARD_TOPICS,
    min: 1,
    max: 10_000_000,
    unit: "topics",
    label: "SNS standard topics",
    help: "Standard topics one account may have in a region.",
    limit: Setting.quota(docs.snsQuotas)
  }),
  snsFifoTopics: Setting.int({
    default: FIFO_TOPICS,
    min: 1,
    max: 10_000_000,
    unit: "topics",
    label: "SNS FIFO topics",
    help: "FIFO topics one account may have in a region.",
    limit: Setting.quota(docs.snsQuotas)
  })
})
