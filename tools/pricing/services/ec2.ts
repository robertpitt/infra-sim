import { isInstanceType } from "../../../src/simulator/aws/ec2/instanceTypes.ts"
import { attr, type ServiceMap } from "../map.ts"

/**
 * EC2 (an Auto Scaling group's instances, and the container instances and nodes of ECS on EC2 and EKS node groups):
 * instance hours by type, On-Demand, Linux, shared tenancy, no pre-installed software. Only the types the simulator's
 * catalog offers (`src/simulator/aws/ec2/instanceTypes.ts`), so a type added there is priced on the next run.
 * https://aws.amazon.com/ec2/pricing/on-demand/
 *
 * Usage types (after the region prefix): `BoxUsage:<type>`. Each type has one such row per operating system and
 * licence; the Linux one is `operation` `RunInstances` with `Operating System` Linux, `Tenancy` Shared, `Pre Installed
 * S/W` NA and `CapacityStatus` Used (the others are reservations' unused or allocated capacity).
 * Left out:
 *  - Spot: AWS's price list has no Spot prices (they move with supply and demand, published by the Spot price history
 *    API, not the bulk files), though the simulator models a group's Spot share.
 *  - EBS volumes (gp3 storage, IOPS, throughput): the simulator models no volumes. A warm pool's Stopped and Hibernated
 *    instances pay only for theirs, so they cost nothing here.
 *  - T3 surplus CPU credits in unlimited mode: the simulator doesn't model CPU credits.
 *  - Other operating systems, dedicated tenancy, Capacity Blocks, data transfer, Elastic IPs: not modelled.
 */
export const ec2: ServiceMap = {
  id: "ec2",
  title: "Amazon EC2",
  offers: ["AmazonEC2"],
  dimensions: {
    "instance/*": {
      unit: "hour",
      description: "An On-Demand Linux instance of this type running, shared tenancy (`instance/m7i.large`)"
    }
  },
  classify: (row) => {
    // us-east-1's usage types have no region prefix; other files' prefixes are stripped already, unless too few rows had one.
    const usage = row.usage.replace(/^[A-Z0-9]+-(?=BoxUsage:)/, "")
    if (!usage.startsWith("BoxUsage:")) return undefined
    const type = attr(row, "Instance Type")
    if (
      !isInstanceType(type) ||
      row.operation !== "RunInstances" ||
      attr(row, "Operating System") !== "Linux" ||
      attr(row, "Tenancy") !== "Shared" ||
      attr(row, "Pre Installed S/W") !== "NA" ||
      attr(row, "CapacityStatus") !== "Used" ||
      attr(row, "MarketOption") !== "OnDemand"
    )
      return undefined
    return { dimension: `instance/${type}` }
  }
}
