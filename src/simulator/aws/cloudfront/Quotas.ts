import * as Setting from "../../Setting.ts"
import { QUOTAS_URL } from "./internal/config.ts"

/**
 * The account-level quotas CloudFront contributes. CloudFront is a global service, so AWS publishes one number for
 * every region. Requests per second and data transfer rate are per distribution (each distribution gets its own
 * allowance, taken from this setting); Lambda@Edge's rate is per AWS Region and shared by every distribution.
 */
export const quotas = (_region: string) => ({
  cloudfrontRequestRate: Setting.int({
    default: 250_000,
    min: 1,
    max: 1_000_000_000,
    unit: "req/s",
    label: "CloudFront requests per distribution",
    help: "Requests per second one distribution accepts. AWS publishes no burst size or response for going over; the model gives a one second bucket and answers 503, which AWS documents as 'capacity exceeded' at an edge location.",
    limit: Setting.quota(QUOTAS_URL)
  }),
  cloudfrontDataTransferRate: Setting.int({
    default: 150,
    min: 1,
    max: 1_000_000,
    unit: "Gbps",
    label: "CloudFront data transfer per distribution",
    help: "Bytes per second one distribution may send, in gigabits a second.",
    limit: Setting.quota(QUOTAS_URL)
  }),
  cloudfrontLambdaEdgeRate: Setting.int({
    default: 10_000,
    min: 1,
    max: 100_000_000,
    unit: "req/s",
    label: "Lambda@Edge requests per region",
    help: "Lambda@Edge invocations per second in each AWS Region, shared by every distribution of the account. Over it, the viewer gets a 503.",
    limit: Setting.quota(QUOTAS_URL)
  })
})
