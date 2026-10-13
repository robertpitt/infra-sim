import { Duration } from "effect"
import type { Account } from "../../internal/account.ts"
import {
  type Config,
  SERVERLESS_SLOT_ECPU,
  SERVERLESS_SLOT_ECPU_REPLICAS,
  SERVERLESS_START_ECPU,
  SERVERLESS_START_ECPU_REPLICAS
} from "./config.ts"
import { MEMCACHED_CONNECTIONS_OVERHEAD_MB, MEMCACHED_OPS_PER_THREAD, NODE_TYPES, type NodeType } from "./nodeTypes.ts"
import { POLICIES } from "./store.ts"
import { GiB, MiB } from "../../internal/units.ts"

/** Where reads go. */
export const READ_PRIMARY = 0
export const READ_REPLICAS = 1
export const READ_ANY = 2

/**
 * Everything a request needs that depends only on the settings and the account's quotas: worked out once per edit of
 * either, not once per request. Both are replaced whole on every edit, so their identities are the cache key.
 */
export interface Derived {
  readonly serverless: boolean
  readonly memcached: boolean
  /** Shards running (Memcached: nodes), after the account's nodes-per-cluster quota, and nodes in each. */
  readonly shards: number
  readonly group: number
  readonly keys: number
  readonly skew: number
  readonly itemBytes: number
  /** Memory one key takes: its value and its overhead. */
  readonly entryBytes: number
  /** Data memory of one shard, bytes (`Infinity` for serverless with no storage cap). */
  readonly dataBytes: number
  /** Keys one shard holds before it must evict. */
  readonly capacity: number
  /** Memcached refuses values over max_item_size: such a key is never stored. */
  readonly storable: boolean
  readonly ttlMs: number
  readonly jitter: number
  readonly writeThrough: boolean
  readonly lock: boolean
  readonly failOpen: boolean
  readonly readFrom: number
  readonly policy: number
  /** Time one command holds a node's engine, and one byte its network, in milliseconds. */
  readonly commandMs: number
  readonly msPerByte: number
  readonly maxClients: number
  readonly automaticFailover: boolean
  readonly detectionMs: number
  readonly promotionMs: number
  readonly replacementMs: number
  readonly resyncMs: number
  /** Serverless: the configured ceiling and floor of ECPUs a second, what an empty cache starts at, and per slot. */
  readonly ecpuMax: number
  readonly ecpuStart: number
  readonly slotEcpuRead: number
  readonly slotEcpuWrite: number
  readonly scaleIntervalMs: number
}

/** How many shards actually run: cluster mode off is one; the nodes-per-cluster quota caps the rest. */
const shardsOf = (c: Config, account: Account, group: number): number => {
  if (c.deployment === "serverless") return 1
  if (c.engine === "memcached") return Math.max(1, Math.min(c.shards, account.elasticacheMemcachedNodesPerCluster))
  if (!c.clusterMode) return 1
  return Math.max(1, Math.min(c.shards, Math.floor(account.elasticacheNodesPerCluster / group)))
}

export const derive = (c: Config, account: Account): Derived => {
  const type: NodeType = NODE_TYPES[c.nodeType]
  const serverless = c.deployment === "serverless"
  const memcached = c.engine === "memcached"
  // Memcached has no replication; serverless replicates out of sight, behind its proxy.
  const replicas = memcached || serverless ? 0 : c.replicasPerShard
  const group = 1 + replicas
  const itemBytes = c.keyspace.itemSize * 1024
  const entryBytes = Math.max(1, itemBytes + c.memory.keyOverhead)
  const dataBytes = serverless
    ? c.serverless.maxStorageGb > 0 ? c.serverless.maxStorageGb * GiB : Infinity
    : memcached
    ? Math.max(0, type.memcachedMB - MEMCACHED_CONNECTIONS_OVERHEAD_MB) * MiB
    : type.maxmemory * (1 - c.memory.reservedMemoryPercent / 100)
  const ops = c.performance.opsPerNode > 0 ? c.performance.opsPerNode : memcached ? type.vcpus * MEMCACHED_OPS_PER_THREAD : type.assumedOps
  const ttl = Duration.toMillis(c.caching.ttl)
  const replicaReads = c.readFrom !== "primary"
  return {
    serverless,
    memcached,
    shards: shardsOf(c, account, group),
    group,
    keys: c.keyspace.keys,
    skew: c.keyspace.popularitySkew,
    itemBytes,
    entryBytes,
    dataBytes,
    capacity: dataBytes === Infinity ? Infinity : Math.floor(dataBytes / entryBytes),
    storable: !memcached || itemBytes <= c.memory.memcachedMaxItemSize * 1024,
    ttlMs: ttl > 0 ? ttl : Infinity,
    jitter: c.caching.ttlJitter,
    writeThrough: c.caching.writes === "write-through",
    lock: c.caching.stampede === "lock",
    failOpen: c.caching.failOpen,
    readFrom: c.readFrom === "primary" ? READ_PRIMARY : c.readFrom === "replicas" ? READ_REPLICAS : READ_ANY,
    // Memcached evicts the least recently used item whatever its TTL; serverless evicts keys with a TTL (its documented rule).
    policy: memcached ? POLICIES["allkeys-lru"] : serverless ? POLICIES["volatile-lru"] : POLICIES[c.memory.evictionPolicy],
    commandMs: 1000 / ops,
    msPerByte: (8 * 1000) / (type.baselineGbps * 1e9),
    maxClients: type.maxClients,
    // Cluster mode always fails over automatically.
    automaticFailover: c.automaticFailover || (c.clusterMode && !memcached),
    detectionMs: Duration.toMillis(c.failover.detection),
    promotionMs: Duration.toMillis(c.failover.promotion),
    replacementMs: Duration.toMillis(c.failover.replacement),
    resyncMs: Duration.toMillis(c.failover.replicaResync),
    ecpuMax: c.serverless.maxEcpuPerSecond > 0 ? c.serverless.maxEcpuPerSecond : Infinity,
    ecpuStart: Math.max(replicaReads ? SERVERLESS_START_ECPU_REPLICAS : SERVERLESS_START_ECPU, c.serverless.minEcpuPerSecond),
    slotEcpuRead: replicaReads ? SERVERLESS_SLOT_ECPU_REPLICAS : SERVERLESS_SLOT_ECPU,
    slotEcpuWrite: SERVERLESS_SLOT_ECPU,
    scaleIntervalMs: Duration.toMillis(c.serverless.scaleInterval)
  }
}
