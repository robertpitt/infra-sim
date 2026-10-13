/**
 * The node types the component offers: a handful of current-generation `cache.*` types, from the smallest burstable
 * node to a 16-vCPU memory-optimised one, with the numbers that decide how much a node holds and how fast it answers.
 *
 * Verified (2026-10) against AWS:
 *  - memory, baseline and burst network bandwidth, and which types have enhanced I/O multiplexing: "Supported node
 *    types" (`TYPES_URL`);
 *  - `maxmemory` (Valkey and Redis OSS, bytes), `max_cache_memory` and `num_threads` (Memcached) and `maxclients`:
 *    "Engine specific parameters" (`PARAMETERS_URL`). Memcached's `num_threads` equals the node's vCPUs.
 *
 * `assumedOps` is NOT published by AWS: it is how many simple GET/SET commands a second one node's engine executes
 * without pipelining. Valkey and Redis OSS run commands on one main thread, so it grows with the I/O threads a node
 * has, not with its cores; the one anchor AWS gives is "over 1 million requests per second per node" on r7g.4xlarge or
 * larger with ElastiCache 7.1 (engine-versions.html). The smaller figures are assumptions scaled down from it.
 */

export const TYPES_URL = "https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/CacheNodes.SupportedTypes.html"
export const PARAMETERS_URL = "https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/ParameterGroups.Engine.html"

export interface NodeType {
  readonly vcpus: number
  /** Advertised memory, GiB. */
  readonly memoryGiB: number
  /** Valkey and Redis OSS `maxmemory` for the type, bytes, before `reserved-memory-percent` is set aside. */
  readonly maxmemory: number
  /** Memcached `max_cache_memory`, MB. */
  readonly memcachedMB: number
  /** Sustained network bandwidth, Gbps. */
  readonly baselineGbps: number
  /** What a node may burst to on network I/O credits, Gbps (not modelled: the baseline is the ceiling). */
  readonly burstGbps: number
  /** Enhanced I/O multiplexing (Valkey 7.2+, Redis OSS 7.0.4+). */
  readonly ioMultiplexing: boolean
  /** Simple commands a second one Valkey/Redis OSS node executes. An assumption (see above). */
  readonly assumedOps: number
  /** Connections a node accepts (`maxclients`, not modifiable). */
  readonly maxClients: number
  /** Burstable types earn CPU credits; their baseline is this share of each vCPU (credits are not modelled). */
  readonly burstableBaseline?: number
}

/** `maxclients` on every type except the few small ones AWS lists separately. */
const MAX_CLIENTS = 65_000

/** What one Memcached worker thread executes a second. An assumption, like `assumedOps`. */
export const MEMCACHED_OPS_PER_THREAD = 100_000

/** Memory a Memcached node keeps for connections (`memcached_connections_overhead`, default 100 MB). */
export const MEMCACHED_CONNECTIONS_OVERHEAD_MB = 100

export const NODE_TYPES = {
  "cache.t4g.micro": { vcpus: 2, memoryGiB: 0.5, maxmemory: 536_870_912, memcachedMB: 512, baselineGbps: 0.064, burstGbps: 5, ioMultiplexing: false, assumedOps: 100_000, maxClients: 20_000, burstableBaseline: 0.1 },
  "cache.t4g.small": { vcpus: 2, memoryGiB: 1.37, maxmemory: 1_471_026_299, memcachedMB: 1_402, baselineGbps: 0.128, burstGbps: 5, ioMultiplexing: false, assumedOps: 100_000, maxClients: MAX_CLIENTS, burstableBaseline: 0.2 },
  "cache.t4g.medium": { vcpus: 2, memoryGiB: 3.09, maxmemory: 3_317_862_236, memcachedMB: 3_164, baselineGbps: 0.256, burstGbps: 5, ioMultiplexing: false, assumedOps: 100_000, maxClients: MAX_CLIENTS, burstableBaseline: 0.2 },
  "cache.m7g.large": { vcpus: 2, memoryGiB: 6.38, maxmemory: 6_854_542_746, memcachedMB: 6_537, baselineGbps: 0.937, burstGbps: 12.5, ioMultiplexing: true, assumedOps: 125_000, maxClients: MAX_CLIENTS },
  "cache.m7g.xlarge": { vcpus: 4, memoryGiB: 12.93, maxmemory: 13_891_921_715, memcachedMB: 13_248, baselineGbps: 1.876, burstGbps: 12.5, ioMultiplexing: true, assumedOps: 200_000, maxClients: MAX_CLIENTS },
  "cache.r6g.large": { vcpus: 2, memoryGiB: 13.07, maxmemory: 14_037_181_030, memcachedMB: 13_387, baselineGbps: 0.75, burstGbps: 10, ioMultiplexing: false, assumedOps: 100_000, maxClients: MAX_CLIENTS },
  "cache.r7g.large": { vcpus: 2, memoryGiB: 13.07, maxmemory: 14_037_181_030, memcachedMB: 13_387, baselineGbps: 0.937, burstGbps: 12.5, ioMultiplexing: true, assumedOps: 125_000, maxClients: MAX_CLIENTS },
  "cache.r7g.xlarge": { vcpus: 4, memoryGiB: 26.32, maxmemory: 28_261_849_702, memcachedMB: 26_953, baselineGbps: 1.876, burstGbps: 12.5, ioMultiplexing: true, assumedOps: 200_000, maxClients: MAX_CLIENTS },
  "cache.r7g.2xlarge": { vcpus: 8, memoryGiB: 52.82, maxmemory: 56_711_183_565, memcachedMB: 54_084, baselineGbps: 3.75, burstGbps: 15, ioMultiplexing: true, assumedOps: 500_000, maxClients: MAX_CLIENTS },
  "cache.r7g.4xlarge": { vcpus: 16, memoryGiB: 105.81, maxmemory: 113_609_865_216, memcachedMB: 108_347, baselineGbps: 7.5, burstGbps: 15, ioMultiplexing: true, assumedOps: 1_000_000, maxClients: MAX_CLIENTS },
  "cache.c7gn.large": { vcpus: 2, memoryGiB: 3.09, maxmemory: 3_317_862_236, memcachedMB: 3_164, baselineGbps: 6.25, burstGbps: 30, ioMultiplexing: false, assumedOps: 100_000, maxClients: MAX_CLIENTS }
} as const satisfies Record<string, NodeType>

export type NodeTypeName = keyof typeof NODE_TYPES
export const NODE_TYPE_NAMES = Object.keys(NODE_TYPES) as ReadonlyArray<NodeTypeName>

/** One line per type for the setting's labels: memory, network and vCPUs. */
export const NODE_TYPE_LABELS = Object.fromEntries(
  NODE_TYPE_NAMES.map((name) => {
    const t: NodeType = NODE_TYPES[name]
    return [name, `${name} (${t.memoryGiB} GiB, ${t.vcpus} vCPU, ${t.baselineGbps} Gbps)`]
  })
) as Record<NodeTypeName, string>
