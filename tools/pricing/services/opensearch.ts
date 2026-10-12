import { INSTANCE_TYPES } from "../../../src/simulator/aws/opensearch/config.ts"
import type { ServiceMap } from "../map.ts"
import { attr } from "../map.ts"

/**
 * OpenSearch Service (managed domains): instance hours by instance type, for data nodes and dedicated masters alike;
 * gp3 EBS storage attached to the nodes (GB-months).
 * https://aws.amazon.com/opensearch-service/pricing/
 *
 * Usage types (after the region prefix): `ESInstance:<type>`, read by the `Instance Type` column (`r7g.large.search`);
 * `ES:GP3-Storage`. Only the instance types the simulator offers (`src/simulator/aws/opensearch/config.ts`).
 * Left out: OpenSearch Serverless OCUs and its storage (the simulator models managed domains only), gp3 IOPS and
 * throughput above the baseline, gp2, io1 and magnetic volumes, UltraWarm and cold storage (managed storage),
 * OpenSearch Ingestion, direct query, vector storage, Extended Support, reserved instances.
 */

const TYPES = new Set<string>(Object.keys(INSTANCE_TYPES))

export const opensearch: ServiceMap = {
  id: "opensearch",
  title: "Amazon OpenSearch Service",
  offers: ["AmazonES"],
  dimensions: {
    "instance/*": { unit: "hour", description: "Instance hours of a domain's nodes: instance/<type>, e.g. instance/r7g.large.search" },
    "storage/gp3": { unit: "GB-month", description: "gp3 EBS storage provisioned per node" }
  },
  classify: (row) => {
    if (row.usage.startsWith("ESInstance:")) {
      const type = attr(row, "Instance Type")
      return TYPES.has(type) && attr(row, "Location Type") === "AWS Region" ? { dimension: `instance/${type}` } : undefined
    }
    if (row.usage === "ES:GP3-Storage") return { dimension: "storage/gp3" }
    return undefined
  }
}
