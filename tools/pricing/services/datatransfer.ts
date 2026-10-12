import { catalog as regions } from "../../../src/simulator/aws/region/catalog.ts"
import { attr, type ServiceMap } from "../map.ts"

/**
 * Data transfer, which AWS bills apart from the services that send it: out to the internet from a Region (tiered by
 * the month's GB, after 100 GB a month free across all Regions), to another Region (by the pair: priced in the Region
 * it leaves, by the Region it goes to), and between Availability Zones in a Region (each GB is billed out of one zone
 * and again into the other). Data coming in, from the internet or another Region, is free.
 * https://aws.amazon.com/ec2/pricing/on-demand/#Data_Transfer
 *
 * Rows of the `AWSDataTransfer` offer, told apart by their `Transfer Type`, `From Region Code` and `To Region Code`
 * columns rather than their usage types, which in each Region's file start with either Region's code (`USE1-EUW1-AWS-Out-Bytes`
 * leaves us-east-1, `EUW1-USE1-AWS-Out-Bytes` arrives there): `<region>-DataTransfer-Out-Bytes` (AWS Outbound, four
 * tiers from 10 TB) with its free tier `Global-DataTransfer-Out-Bytes`; `<from>-<to>-AWS-Out-Bytes` (InterRegion Outbound),
 * taken from the file of the Region it leaves; `<region>-DataTransfer-Regional-Bytes` (IntraRegion) with
 * `Global-DataTransfer-Regional-Bytes`, a free GB.
 * Left out: Regions the simulator doesn't have (GovCloud, the European Sovereign Cloud), Local and Wavelength Zones, S3
 * Transfer Acceleration (`ABytes`), Inter-Region peering to "External", the `DataTransfer-xAZ-*` rows (listed at 0), and
 * data coming in (free). CloudFront's own data transfer out is priced with CloudFront.
 */
const simulated = new Set(regions.map((r) => r.id))

export const datatransfer: ServiceMap = {
  id: "datatransfer",
  title: "AWS Data Transfer",
  offers: ["AWSDataTransfer"],
  dimensions: {
    "internet-out": {
      unit: "GB",
      description: "Data transfer out from the Region to the internet, tiered by the month's GB (100 GB a month free, across all Regions)"
    },
    "cross-az": {
      unit: "GB",
      description: "Data transfer between Availability Zones in the Region, per GB in each direction (out of one zone and into the other)"
    },
    "inter-region/*": {
      unit: "GB",
      description: "Data transfer out from the Region to the Region named (`inter-region/eu-west-1`)"
    }
  },
  classify: (row) => {
    const type = attr(row, "Transfer Type")
    const free = row.usage.startsWith("Global-")
    if (type === "AWS Outbound" && /(^|-)DataTransfer-Out-Bytes$/.test(row.usage))
      return free ? { dimension: "internet-out", free: true } : attr(row, "From Region Code") === row.region ? { dimension: "internet-out" } : undefined
    if (type === "IntraRegion" && /(^|-)DataTransfer-Regional-Bytes$/.test(row.usage))
      return free ? { dimension: "cross-az", free: true } : attr(row, "From Region Code") === row.region ? { dimension: "cross-az" } : undefined
    if (type === "InterRegion Outbound" && attr(row, "From Region Code") === row.region && attr(row, "To Location Type") === "AWS Region") {
      const to = attr(row, "To Region Code")
      return simulated.has(to) ? { dimension: `inter-region/${to}` } : undefined
    }
    return undefined
  }
}
