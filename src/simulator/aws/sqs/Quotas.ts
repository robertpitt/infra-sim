import * as Setting from "../../Setting.ts"
import { docs } from "../internal/docs.ts"

/**
 * FIFO high-throughput mode: non-batched API calls per second per queue, by region (batched is ten times this). From the
 * developer guide's message quotas page. The general reference lists 18,000 for Ohio and Frankfurt (180,000 batched) and
 * leaves Spain out of the 9,000 group; the developer guide is the more recent and is used.
 */
const HIGH_THROUGHPUT: ReadonlyArray<readonly [tps: number, regions: ReadonlyArray<string>]> = [
  [70_000, ["us-east-1", "us-west-2", "eu-west-1"]],
  [19_000, ["us-east-2", "eu-central-1"]],
  [9_000, ["ap-south-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1", "eu-south-2"]],
  [4_500, ["eu-west-2", "sa-east-1"]]
]
/** Every other region. */
const HIGH_THROUGHPUT_DEFAULT = 2_400

export const sqsFifoHighThroughputTps = (region: string): number =>
  HIGH_THROUGHPUT.find(([, regions]) => regions.includes(region))?.[0] ?? HIGH_THROUGHPUT_DEFAULT

/**
 * The account-level quotas this service contributes: limits that belong to an AWS account in a region rather than to
 * one resource, and that every resource of the service in that region shares. Each is an editable setting whose default
 * is AWS's published number for that region. They are merged into the provider's account form (`../account.ts`).
 *
 * SQS has one: the high-throughput rate. Everything else (message size, in-flight messages, retention) is a limit of a
 * queue, and lives on the queue's own settings.
 */
export const quotas = (region: string) => ({
  sqsFifoHighThroughput: Setting.int({
    default: sqsFifoHighThroughputTps(region),
    // 300 is what a FIFO queue gets without high-throughput mode, so a lower number would make the mode a downgrade.
    min: 300,
    max: 10_000_000,
    unit: "req/s",
    label: "SQS FIFO high-throughput limit",
    help: "Per queue, non-batched requests per second when high-throughput mode is on. Batched is ten times this.",
    limit: Setting.quota(`${docs.sqs}quotas-messages.html`, "Regions not listed by AWS get 2,400.")
  })
})
