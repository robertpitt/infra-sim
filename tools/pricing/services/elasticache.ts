import { NODE_TYPE_NAMES } from "../../../src/simulator/aws/elasticache/nodeTypes.ts"
import type { ServiceMap } from "../map.ts"
import { attr } from "../map.ts"

/**
 * ElastiCache: node hours of a node-based cluster, by engine and node type; a serverless cache's ElastiCache Processing
 * Units (ECPUs) and data stored (GB-hours), by engine. Valkey is priced below Redis OSS; Memcached is priced as Redis
 * OSS for nodes and serverless.
 * https://aws.amazon.com/elasticache/pricing/
 *
 * Usage types (after the region prefix): `NodeUsage:<type>`, with the engine in the `Cache Engine` column;
 * `ElastiCacheProcessingUnits:<engine>`; `CachedData:<engine>`. Only the node types the simulator offers
 * (`src/simulator/aws/elasticache/nodeTypes.ts`).
 * Left out: backup storage, Global Datastore data transfer (the datatransfer group's, and not modelled), synchronous
 * durability, Extended Support for old Redis OSS versions, data tiering node types, reserved nodes. A serverless cache
 * bills at least 100 MB of data on Valkey and 1 GB on Redis OSS and Memcached: a minimum the meter applies, not a price.
 */

const ENGINES: Record<string, string> = { Valkey: "valkey", Redis: "redis", Memcached: "memcached" }
const NODE_TYPES = new Set<string>(NODE_TYPE_NAMES)

export const elasticache: ServiceMap = {
  id: "elasticache",
  title: "Amazon ElastiCache",
  offers: ["AmazonElastiCache"],
  dimensions: {
    "node/*": { unit: "hour", description: "Node hours of a node-based cluster: node/<valkey|redis|memcached>/<node type>, per node (primaries and replicas)" },
    "serverless/ecpu/valkey": { unit: "ECPU", description: "Serverless ElastiCache Processing Units, Valkey" },
    "serverless/ecpu/redis": { unit: "ECPU", description: "Serverless ElastiCache Processing Units, Redis OSS" },
    "serverless/ecpu/memcached": { unit: "ECPU", description: "Serverless ElastiCache Processing Units, Memcached" },
    "serverless/storage/valkey": { unit: "GB-hour", description: "Serverless data stored, Valkey (at least 100 MB)" },
    "serverless/storage/redis": { unit: "GB-hour", description: "Serverless data stored, Redis OSS (at least 1 GB)" },
    "serverless/storage/memcached": { unit: "GB-hour", description: "Serverless data stored, Memcached (at least 1 GB)" }
  },
  classify: (row) => {
    let m: RegExpExecArray | null
    if ((m = /^NodeUsage:(cache\..+)$/.exec(row.usage))) {
      const engine = ENGINES[attr(row, "Cache Engine")]
      return engine !== undefined && NODE_TYPES.has(m[1]!) && attr(row, "Location Type") === "AWS Region" ? { dimension: `node/${engine}/${m[1]}` } : undefined
    }
    if ((m = /^ElastiCacheProcessingUnits:(Valkey|Redis|Memcached)$/.exec(row.usage))) return { dimension: `serverless/ecpu/${ENGINES[m[1]!]}` }
    if ((m = /^CachedData:(Valkey|Redis|Memcached)$/.exec(row.usage))) return { dimension: `serverless/storage/${ENGINES[m[1]!]}` }
    return undefined
  }
}
