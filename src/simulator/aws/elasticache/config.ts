import { Schema } from "effect"
import * as Component from "../../Component.ts"
import * as Setting from "../../Setting.ts"
import { NODE_TYPE_LABELS, NODE_TYPE_NAMES, PARAMETERS_URL, TYPES_URL } from "./nodeTypes.ts"

/** Where AWS documents ElastiCache. Every limit below links to a page under here. */
export const DOCS = "https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/"
export const QUOTAS_URL = `${DOCS}quota-limits.html`
export const SHARDS_URL = `${DOCS}Shards.html`
export const FAILOVER_URL = `${DOCS}AutoFailover.html`
export const SERVERLESS_SCALING_URL = `${DOCS}Scaling-serverless.html`
export const ECPU_URL = `${DOCS}WhatIs.corecomponents.html`
export const CLUSTER_SPEC_URL = "https://valkey.io/topics/cluster-spec/"
export { PARAMETERS_URL, TYPES_URL }

/** Valkey and Redis OSS cluster mode cut the key space into this many hash slots, spread evenly over the shards. */
export const HASH_SLOTS = 16_384
/** A shard is a primary and at most this many replicas (1 to 6 nodes). */
export const MAX_REPLICAS = 5
/** The most nodes one cluster can have once the quota is raised (Valkey 7.2+, Redis OSS 5.0.6 to 7.1). */
export const MAX_NODES_PER_CLUSTER = 500
/** Valkey and Redis OSS refuse a value larger than `proto-max-bulk-len` (512 MB, its maximum). */
export const MAX_VALUE_KB = 512 * 1024
/** Memcached's `max_item_size` default: 1 MB. A larger value is refused (`SERVER_ERROR object too large for cache`). */
export const MEMCACHED_MAX_ITEM_KB = 1_024
/** What an empty serverless cache serves: 30,000 ECPUs a second, 90,000 when reads go to replicas (`READONLY`). */
export const SERVERLESS_START_ECPU = 30_000
export const SERVERLESS_START_ECPU_REPLICAS = 90_000
/** The most one hash slot of a serverless cache serves: 30,000 ECPUs a second (90,000 reading from replicas). */
export const SERVERLESS_SLOT_ECPU = 30_000
export const SERVERLESS_SLOT_ECPU_REPLICAS = 90_000
/** A simple read or write costs 1 ECPU per KB transferred, and at least 1. */
export const ECPU_BYTES = 1_024

const DAY = 24 * 3600 * 1000

/** Settings of one cluster (a replication group, or a Memcached cluster, or a serverless cache). See `README.md`. */
export const Config = Schema.Struct({
  engine: Setting.choice(["valkey", "redis", "memcached"], {
    default: "valkey",
    labels: { valkey: "Valkey", redis: "Redis OSS", memcached: "Memcached" },
    help: "Valkey and Redis OSS execute commands on one main thread and replicate; Memcached is multi-threaded, has no replicas and no failover, and evicts least recently used items whatever their TTL."
  }),
  deployment: Setting.choice(["node-based", "serverless"], {
    default: "node-based",
    labels: { "node-based": "Node-based cluster", serverless: "Serverless" },
    help: "A node-based cluster has the node type, shards and replicas below. Serverless has none of them: it is billed and throttled in ECPUs, starts at 30,000 a second and doubles every few minutes under load (see Serverless)."
  }),
  nodeType: Setting.choice(NODE_TYPE_NAMES, {
    default: "cache.r7g.large",
    labels: NODE_TYPE_LABELS,
    help: "Memory, network bandwidth and vCPUs come from AWS's tables. How many commands a second a node executes is an assumption (see Performance)."
  }),
  clusterMode: Setting.bool({
    default: false,
    label: "Cluster mode",
    help: "Valkey and Redis OSS only. Off: one shard (a primary and its replicas), scaled up by node type. On: keys hash to 16,384 slots spread over the shards, so the data and the load are split, and a hot key loads one shard. Automatic failover is always on in cluster mode."
  }),
  shards: Setting.int({
    default: 1,
    min: 1,
    max: MAX_NODES_PER_CLUSTER,
    label: "Shards (nodes for Memcached)",
    help: "Node groups, each with its own slots, memory and primary. Used when cluster mode is on, or as the node count of a Memcached cluster. The account's nodes-per-cluster quota (90 by default) caps shards x (1 + replicas).",
    limit: Setting.hard(SHARDS_URL, "At most 500 nodes per cluster, after raising the 90-node default quota.")
  }),
  replicasPerShard: Setting.int({
    default: 1,
    min: 0,
    max: MAX_REPLICAS,
    label: "Replicas per shard",
    help: "Read-only copies of each shard's primary, each in another Availability Zone (Multi-AZ). They serve reads when reads go to replicas, apply every write the primary takes, and one is promoted when the primary, or its zone, fails. Memcached has none.",
    limit: Setting.hard(SHARDS_URL, "A shard is 1 to 6 nodes: a primary and up to 5 replicas.")
  }),
  readFrom: Setting.choice(["primary", "replicas", "any"], {
    default: "primary",
    labels: { primary: "Primary only", replicas: "Replicas (primary if none is up)", any: "Any node of the shard" },
    help: "Where the client sends reads: the reader endpoint or READONLY connections send them to replicas. Writes and fills always go to the primary."
  }),
  automaticFailover: Setting.bool({
    default: true,
    label: "Multi-AZ automatic failover",
    help: "When a primary fails, promote a replica within the detection and promotion time. Off (cluster mode off only): the primary is replaced, which takes the replacement time, and with no replica its data is lost."
  }),
  keyspace: Setting.group(
    {
      keys: Setting.int({
        default: 100_000,
        min: 1,
        max: 100_000_000,
        label: "Distinct keys",
        help: "How many different keys the application reads and writes. Requests pick one by their key, so few keys means a high hit ratio and many a low one. A property of your application."
      }),
      popularitySkew: Setting.number({
        default: 1,
        min: 1,
        max: 10,
        step: 0.1,
        label: "Popularity skew",
        help: "1 spreads requests evenly over the keys. Higher values concentrate them on a few (a long tail): key i of N is chosen with probability rising as (i / N)^(1 / skew)."
      }),
      itemSize: Setting.number({
        default: 1,
        min: 0.01,
        max: MAX_VALUE_KB,
        step: 0.1,
        unit: "KB",
        label: "Value size",
        help: "The average value. It decides how many keys fit in memory, the bytes a node sends (its network bandwidth is a limit) and, on serverless, the ECPUs a command costs.",
        limit: Setting.hard(PARAMETERS_URL, "Valkey and Redis OSS refuse a value over proto-max-bulk-len, 512 MB at most.")
      })
    },
    { label: "Keys" }
  ),
  caching: Setting.group(
    {
      ttl: Setting.duration({
        default: "1 hour",
        min: 0,
        max: 365 * DAY,
        label: "TTL",
        help: "How long a filled key lives. 0: keys never expire (and volatile-lru then has nothing it may evict)."
      }),
      ttlJitter: Setting.ratio({
        default: 0,
        label: "TTL jitter",
        help: "Shorten each key's TTL by a random share of up to this much, so keys filled together (after a cold start) do not all expire together. AWS's caching best practices suggest it against the thundering herd."
      }),
      writes: Setting.choice(["invalidate", "write-through"], {
        default: "invalidate",
        labels: { invalidate: "Invalidate (DEL after the database write)", "write-through": "Write-through (SET after the database write)" },
        help: "What the application does to the cache after a write to the database. Write-through keeps written keys hot, and fills memory with keys that may never be read."
      }),
      stampede: Setting.choice(["none", "lock"], {
        default: "none",
        labels: { none: "None: every miss reads the database", lock: "Lock: one reader per key fills it, the others wait" },
        help: "What the application does when many requests miss the same key at once. Plain cache-aside sends every one of them to the database (the thundering herd). A lock (SET NX) lets one fetch while the rest wait for its fill."
      }),
      failOpen: Setting.bool({
        default: true,
        label: "Fail open",
        help: "When the cache cannot answer (a shard failing over, a node refusing connections), read from the database instead, and treat a failed cache update after a write as harmless. Off: those requests fail."
      })
    },
    { label: "Caching (the application's cache-aside code)" }
  ),
  memory: Setting.group(
    {
      reservedMemoryPercent: Setting.int({
        default: 25,
        min: 0,
        max: 100,
        unit: "%",
        label: "reserved-memory-percent",
        help: "Share of maxmemory set aside for replication buffers, fragmentation and forks. AWS's default is 25% and advises not to lower it. Valkey and Redis OSS only."
      }),
      evictionPolicy: Setting.choice(["volatile-lru", "allkeys-lru", "noeviction"], {
        default: "volatile-lru",
        help: "maxmemory-policy when memory is full. volatile-lru (AWS's default) evicts only keys with a TTL; allkeys-lru any key; noeviction none. When nothing may be evicted a SET fails with OOM. Memcached always evicts the least recently used."
      }),
      keyOverhead: Setting.int({
        default: 80,
        min: 0,
        max: 10_000,
        unit: "bytes",
        label: "Overhead per key",
        help: "Memory a key costs besides its value: the key name, the dictionary entry and the expiry. An assumption; it depends on your key names."
      }),
      memcachedMaxItemSize: Setting.int({
        default: MEMCACHED_MAX_ITEM_KB,
        min: 1,
        max: 128 * 1024,
        unit: "KB",
        label: "Memcached max_item_size",
        help: "Memcached refuses to store a larger value, so every read of it misses. AWS's default is 1 MB; the upper bound here is an assumption."
      })
    },
    { label: "Memory" }
  ),
  performance: Setting.group(
    {
      opsPerNode: Setting.int({
        default: 0,
        min: 0,
        max: 10_000_000,
        unit: "ops/s",
        label: "Commands per second per node",
        help: "How many simple GET/SET commands one node executes a second. 0 uses the node type's figure (100,000 to 1,000,000, Memcached 100,000 per vCPU). AWS publishes none except 'over 1 million requests per second per node' on r7g.4xlarge and larger, so these are assumptions."
      })
    },
    { label: "Performance" }
  ),
  failover: Setting.group(
    {
      detection: Setting.duration({
        default: "5 seconds",
        min: 0,
        max: "10 minutes",
        label: "Failure detection",
        help: "How long before ElastiCache notices a failed primary. AWS publishes no figure: an assumption."
      }),
      promotion: Setting.duration({
        default: "3 seconds",
        min: 0,
        max: "10 minutes",
        label: "Replica promotion",
        help: "From detection until the promoted replica takes writes. AWS says 'typically just a few seconds'; the figure is an assumption."
      }),
      replacement: Setting.duration({
        default: "5 minutes",
        min: 0,
        max: "2 hours",
        label: "Node replacement",
        help: "How long provisioning a replacement node takes: a failed primary without automatic failover, a Memcached node, or the replica that replaces a promoted one. AWS publishes no figure: an assumption."
      }),
      replicaResync: Setting.duration({
        default: "10 seconds",
        min: 0,
        max: "1 hour",
        label: "Replica resync",
        help: "After a promotion the other replicas drop their data and sync from the new primary, and cannot be read meanwhile. AWS says it is a brief interruption; the length is an assumption."
      })
    },
    { label: "Failover" }
  ),
  serverless: Setting.group(
    {
      maxEcpuPerSecond: Setting.int({
        default: 0,
        min: 0,
        max: 1_000_000_000,
        unit: "ECPU/s",
        label: "Maximum ECPU per second",
        help: "A cost cap: over it ElastiCache throttles requests. 0 for none."
      }),
      minEcpuPerSecond: Setting.int({
        default: 0,
        min: 0,
        max: 1_000_000_000,
        unit: "ECPU/s",
        label: "Minimum ECPU per second (pre-scaling)",
        help: "Throughput the cache is ready for from the start, instead of 30,000 a second. AWS takes up to an hour to apply it; here it applies at once."
      }),
      maxStorageGb: Setting.int({
        default: 0,
        min: 0,
        max: 100_000,
        unit: "GB",
        label: "Maximum data storage",
        help: "A cost cap: at it ElastiCache evicts keys with a TTL (least recently used first) and, with none to evict, fails writes with OOM. 0 for none. The upper bound here is a UI bound, not AWS's."
      }),
      scaleInterval: Setting.duration({
        default: "150 seconds",
        min: "1 second",
        max: "1 hour",
        label: "Doubling time",
        help: "How often the throughput the cache supports may double while traffic presses on it. AWS says every 2 to 3 minutes (Valkey 8); 150 s is the middle."
      }),
      latency: Setting.latency({
        mean: "0.5 millis",
        cv: 0.5,
        label: "Command latency",
        help: "What a command takes through the serverless proxy layer. AWS says sub-millisecond at the median; the distribution is an assumption."
      })
    },
    { label: "Serverless" }
  ),
  actions: Setting.group(
    {
      failShard: Setting.int({
        default: 0,
        min: 0,
        max: MAX_NODES_PER_CLUSTER - 1,
        label: "Shard to fail",
        help: "Which shard's primary (Memcached: which node) fails when you press Fail primary."
      }),
      failPrimary: Setting.int({
        default: 0,
        min: 0,
        max: 1_000_000_000,
        label: "Fail primary now",
        help: "Change this number while running (or in a scenario's timeline) to fail the primary of the shard above, as an instance failure or the TestFailover API would. To lose every node in an Availability Zone, inject an Outage on the zone instead."
      }),
      flush: Setting.int({
        default: 0,
        min: 0,
        max: 1_000_000_000,
        label: "Flush now",
        help: "Change this number while running to empty every node (FLUSHALL, a reboot, or a cluster that came back empty): the next requests all miss."
      })
    },
    { label: "Break it" }
  )
})
export type Config = typeof Config.Type

/** What a probe reports. */
export const State = Schema.Struct({
  engine: Schema.String,
  deployment: Schema.String,
  /** Shards (Memcached: nodes) and nodes actually running, after the account's nodes-per-cluster quota. */
  shards: Schema.Number,
  nodes: Schema.Number,
  /** Nodes not serving right now: failed, being replaced or resynced, or in an Availability Zone that is down. */
  nodesDown: Schema.Number,
  /** Keys one shard holds before it must evict: its data memory over the memory a key takes. */
  capacityPerShard: Schema.Number,
  /** Keys held across the shards right now, and the fullest shard's share of its memory. */
  items: Schema.Number,
  memoryUsed: Schema.Number,
  /** Reads answered from the cache over reads: since the start, and the last ten seconds. */
  hitRatio: Schema.Number,
  recentHitRatio: Schema.Number,
  reads: Schema.Number,
  writes: Schema.Number,
  hits: Schema.Number,
  misses: Schema.Number,
  /** Requests that waited on another request's fill (the lock). */
  collapsed: Schema.Number,
  databaseReads: Schema.Number,
  databaseWrites: Schema.Number,
  /** Reads sent to the database because the cache could not answer (fail open). */
  bypassed: Schema.Number,
  evictions: Schema.Number,
  /** Keys removed because their TTL passed. */
  expired: Schema.Number,
  /** SETs refused for lack of memory (noeviction, or volatile-lru with no key that has a TTL). */
  oom: Schema.Number,
  /** Commands refused because a node had maxclients waiting. */
  refused: Schema.Number,
  failovers: Schema.Number,
  /** Shards whose primary cannot take writes right now. */
  shardsWriteBlocked: Schema.Number,
  /** The busiest node over the last second: its shard, and the share of its engine thread (or network) in use. */
  hottestShard: Schema.Number,
  hottestUtilization: Schema.Number,
  /** Serverless: the ECPUs a second the cache supports right now. */
  ecpuCeiling: Schema.Number,
  throttled: Schema.Number
})
export type State = typeof State.Type

/**
 * What a call on one of the cache's ports does. Whatever sits on the edge (a plain link, or the target's own client
 * connector, such as RDS's connection pooling) stamps every call with the edge's operation, and the edge default is a
 * write; so each port declares its own default, and a miss reaches the database as a read and a write as a write.
 */
const request = (operation: "read" | "write", help: string) =>
  Setting.group(
    {
      operation: Setting.choice(["write", "read", "caller"], { default: operation, labels: { write: "Write", read: "Read", caller: "What the caller asked (read or write)" }, help }),
      payload: Setting.int({
        default: 0,
        min: 0,
        max: 1_000_000,
        unit: "KB",
        label: "Payload size",
        help: "Size of what the call carries. 0 sends the value size."
      })
    },
    { label: "Request" }
  )

/** The edge a miss (and a fail-open read) takes to the database. */
export const Misses = Schema.Struct({
  request: request("read", "What the database is asked on a miss: a read. Leave it, unless the backend only takes writes.")
})

/** The edge a write takes to the database before the cache is updated. */
export const Writes = Schema.Struct({
  request: request("write", "What the database is asked on a write: a write.")
})

/**
 * The database (or any service) behind the cache, as two edges, usually to the same node: the reads the application's
 * cache-aside code makes on a miss, and the writes it makes before deleting or rewriting the key. With `misses` unwired
 * the cache is the store and a miss is an empty answer; with `writes` unwired a write is a SET in the cache.
 */
export const ports = {
  misses: Component.port.one("Misses (database reads)", Misses),
  writes: Component.port.one("Writes (database writes)", Writes)
}
