# ElastiCache (`aws.elasticache`)

Amazon ElastiCache runs Valkey, Redis OSS or Memcached as a managed in-memory cache, most often in front of a database
so that repeated reads are answered from memory. The component is one cluster (a Valkey or Redis OSS replication group,
a Memcached cluster, or a serverless cache) **together with the application's cache-aside code**: a read that hits is
answered by the cache, a miss reads the database on the `misses` port and fills the key, a write updates the database (`writes`) and
then deletes or rewrites the key. What it lets you learn: the hit ratio is not a number you type, it **emerges** from the
key space, the memory and the TTL; a cold or flushed cache sends a thundering herd to the database; keys hash to shards,
so a hot key loads one node however many there are; a node is limited by its engine thread and its network; and a
failed primary, or the Availability Zone it is in, costs a few seconds of refused writes with a replica in another zone,
and its data without one.

## Coverage

| Feature | Status | Notes |
| --- | --- | --- |
| **Caching in front of a database** | | |
| Read-through (cache-aside as a chain) | ✅ | A hit answers; a miss reads the database through `misses`, then SETs the key on the shard's primary. See *Cache-aside, as a chain* below. |
| Writes invalidate or write through | ✅ | `caching.writes`: after the database write, DEL the key or SET it. |
| Hit ratio from keys, popularity, memory and TTL | ✅ | Nothing sets it. `keyspace.keys` and `popularitySkew` are the key space, memory and the eviction policy decide what stays, the TTL how long. |
| TTL, lazy and active expiry | ✅ | An expired key is deleted when read, and a sampled sweep deletes old expired keys every second. |
| TTL jitter | ✅ | `caching.ttlJitter` shortens each TTL by a random share, so keys filled together don't expire together. |
| Thundering herd | ✅ | By default every concurrent miss of a key reads the database (plain cache-aside). |
| Lock against the herd (SET NX, single flight) | 🟡 | `caching.stampede: lock`: one reader per key fetches, the others wait for its fill, and a reader re-checks the cache once it has the lock. Waiting is free here; real code polls. |
| Fail open | ✅ | `caching.failOpen`: a read the cache cannot answer goes to the database; a failed cache update after a write is ignored. |
| Cache as the only store | ✅ | With nothing on `misses` a miss is an empty answer; with nothing on `writes` a write is a SET. |
| Probabilistic early refresh, stale-while-revalidate, staleness | ❌ | No values, so no stale reads. |
| **Memory** | | |
| maxmemory per node type, reserved-memory-percent | ✅ | Data memory is the type's `maxmemory` less the reserve (25%); Memcached's `max_cache_memory` less 100 MB of connection overhead. |
| Eviction (volatile-lru, allkeys-lru, noeviction) | ✅ | CLOCK, an approximate LRU (Redis samples). With nothing evictable a SET fails with OOM, which a fill shrugs off. |
| Other policies (allkeys-lfu, volatile-ttl, random) | ❌ | |
| Value size limits | ✅ | 512 MB (`proto-max-bulk-len`); Memcached's `max_item_size` (1 MB) refuses larger values, so they are never cached. |
| **Nodes, shards, replicas** | | |
| Node type catalog | ✅ | Eleven current-generation types; memory, bandwidth, vCPUs, maxclients from AWS. |
| Engine thread ceiling | 🟡 | Every node is a one-server queue; commands per second per node is an **assumption** (AWS publishes none). Simple GET/SET only, no pipelining. |
| Network bandwidth ceiling | 🟡 | Replies (and replication) queue on the node's network at its **baseline** bandwidth. Burst credits are not modelled. |
| maxclients | 🟡 | Commands waiting at a node past `maxclients` are refused (each waiting command taken to hold a connection). |
| Cluster mode: 16,384 slots over the shards | ✅ | A key's slot decides its shard; slots are spread evenly. A hot key loads one shard. |
| Replicas serving reads | ✅ | `readFrom`: primary, replicas (primary when none is up) or any node. Every write also costs each replica a command and the primary's network. |
| Memcached: multi-threaded, no replicas | ✅ | Ceiling scales with `num_threads` (vCPUs); a node is a shard of a client-side hash. |
| Online resharding and scaling | 🟡 | A live change of shards, replicas or node type applies at once; keys move to their new shard. AWS takes minutes. |
| Burstable CPU credits (t4g) | ❌ | |
| **Failover** | | |
| Primary failure with automatic failover | ✅ | `actions.failPrimary`: a replica is promoted after detection + promotion; writes to the shard fail until then, reads from replicas carry on. |
| Replacement replica, other replicas resyncing | ✅ | The failed node returns as a replica after the replacement time; the other replicas are unreadable for the resync time after the promotion. |
| Primary failure without failover or replicas | ✅ | Replaced after detection + replacement: synced from a replica if any, empty if none. |
| Memcached node failure | ✅ | Replaced, comes back empty. |
| An Outage fault on the node | 🟡 | The framework refuses every call: the whole cluster unreachable (its endpoint). It neither fails over nor loses data. |
| Nodes in Availability Zones | ✅ | A shard's nodes in different zones (as Multi-AZ places them), the shards' primaries spread over the zones, from the node's `zone` (or the region's first). |
| A zone outage | ✅ | Shards whose primary is in it fail over (automatic failover: a replica in another zone is promoted after detection + promotion), or wait for the zone and a replacement (without); their replicas there stop serving reads. With no replica elsewhere the shard's data is lost. |
| Nodes lost with a zone, replaced when it returns | ✅ | AWS provisions them only once the zone is back: down for `replacement` after it returns, then back as replicas. |
| A zone's Slow and Errors faults | ❌ | Only a zone's Outage reaches the nodes in it. |
| Serverless in a zone outage | ✅ | Unaffected: it replicates across zones behind its endpoint. |
| Replication lag, writes lost at failover | ❌ | |
| FLUSHALL / reboot | ✅ | `actions.flush` empties every node. |
| **Serverless** | | |
| ECPUs | ✅ | 1 per KB transferred, at least 1, per command. |
| Throughput that doubles under load | 🟡 | Starts at 30,000 ECPU/s (90,000 reading from replicas), doubles every `scaleInterval` (2-3 min) while the busiest second passed half of it; never scales in. |
| Per-slot ceiling | ✅ | 30,000 ECPU/s per slot (90,000 for reads from replicas): a hot key is throttled where it lives. |
| Maximum ECPU and storage, pre-scaling | ✅ | Over the maximum ECPU/s: throttled. At the maximum storage: keys with a TTL are evicted, else OOM. The minimum applies at once (AWS: within an hour). |
| **Account** | | |
| Nodes per region, per cluster, Memcached nodes, serverless caches | ✅ | Account quotas; clusters over their per-cluster quota run with as many shards as fit; the rest are audited. |
| **Metrics** | | |
| CacheHits, CacheMisses, Evictions, CurrItems, EngineCPUUtilization, DatabaseMemoryUsagePercentage, ElastiCacheProcessingUnits | ✅ | See *Metrics and state*. |
| Global Datastore, data tiering, durability (Valkey 9), backups, TLS, auth, pub/sub, streams | ❌ | |

## Cache-aside, as a chain

A design is a chain of calls: a component can't make its caller do two things. In real cache-aside the *application*
asks the cache, and on a miss asks the database and then writes the key back. Here the application calls the cache once,
and the cache does the rest on its behalf, so:

- The latency the caller sees on a miss is the GET, the database's answer and the SET, which is what cache-aside costs
  ("three trips", AWS's Strategies page). The trips between the application and the database are on the cache's
  `misses` and `writes` edges rather than the application's.
- The database sees the reads and writes the application would send, one per miss and per write, with the request's key
  (so a hot key reaches the same database partition). It does not see who sent them: anything that limits per caller
  (a database's connections per client) counts the cache's edge as the caller.
- What the application decides is a setting of the cache: invalidate or write through, a lock, fail open, the TTL and its
  jitter.
- A write goes to the database first and then to the cache, as AWS's examples do. A write to the cache alone (the cache
  as a session store) is the case with nothing on `writes` (and `misses`).

## Settings

`A` an assumption; `H` a hard AWS limit; `Q` an adjustable quota; `D` AWS's default for a choice AWS offers.

| Path | Default | Range | Kind | Models |
| --- | --- | --- | --- | --- |
| `engine` | valkey | valkey, redis, memcached | | The engine. Memcached: multi-threaded, no replicas, LRU always. |
| `deployment` | node-based | node-based, serverless | | Nodes and shards, or ECPUs. |
| `nodeType` | cache.r7g.large | 11 types | H (their specs) | Memory, bandwidth, vCPUs, maxclients. |
| `clusterMode` | off | | D | Off: one shard. On: 16,384 slots over the shards. |
| `shards` | 1 | 1 to 500 | H (max), Q (90 nodes) | Shards (Memcached: nodes). |
| `replicasPerShard` | 1 | 0 to 5 | H | Replicas of each primary. |
| `readFrom` | primary | primary, replicas, any | | Where reads go. |
| `automaticFailover` | on | | D | Multi-AZ automatic failover (always on in cluster mode). |
| `keyspace.keys` | 100,000 | 1 to 100 million | A | Distinct keys the application uses. |
| `keyspace.popularitySkew` | 1 | 1 to 10 | A | 1 uniform; higher, a long tail. |
| `keyspace.itemSize` | 1 KB | 0.01 KB to 512 MB | H (max) | Average value size. |
| `caching.ttl` | 1 hour | 0 to 365 days | A | TTL of a filled key; 0 none. |
| `caching.ttlJitter` | 0 | 0 to 1 | A | Random shortening of each TTL. |
| `caching.writes` | invalidate | invalidate, write-through | A | DEL or SET after a database write. |
| `caching.stampede` | none | none, lock | A | Plain cache-aside, or a lock per key. |
| `caching.failOpen` | on | | A | Read the database when the cache can't answer. |
| `memory.reservedMemoryPercent` | 25% | 0 to 100% | D | `reserved-memory-percent`. |
| `memory.evictionPolicy` | volatile-lru | volatile-lru, allkeys-lru, noeviction | D | `maxmemory-policy`. |
| `memory.keyOverhead` | 80 bytes | 0 to 10,000 | A | Memory per key besides its value. |
| `memory.memcachedMaxItemSize` | 1,024 KB | 1 KB to 128 MB | D (default), A (max) | Memcached `max_item_size`. |
| `performance.opsPerNode` | 0 (node type's) | 0 to 10 million | A | Commands per second per node. |
| `failover.detection` | 5 s | 0 to 10 min | A | Until the failure is noticed. |
| `failover.promotion` | 3 s | 0 to 10 min | A | Until the replica takes writes ("a few seconds"). |
| `failover.replacement` | 5 min | 0 to 2 h | A | Provisioning a node. |
| `failover.replicaResync` | 10 s | 0 to 1 h | A | Replicas unreadable after a promotion. |
| `serverless.maxEcpuPerSecond` | 0 (none) | 0 to 10^9 | D | Throttle above it. |
| `serverless.minEcpuPerSecond` | 0 | 0 to 10^9 | D | Pre-scaling. |
| `serverless.maxStorageGb` | 0 (none) | 0 to 100,000 GB | D, A (bound) | Evict or OOM at it. |
| `serverless.scaleInterval` | 150 s | 1 s to 1 h | A | AWS: doubles every 2 to 3 minutes. |
| `serverless.latency` | 0.5 ms, cv 0.5 | | A | A command through the proxy. |
| `actions.failShard` | 0 | 0 to 499 | | Which shard Fail primary hits. |
| `actions.failPrimary` | 0 | | | Change it to fail that shard's primary now. |
| `actions.flush` | 0 | | | Change it to empty every node now. |

Account quotas (Region box): `elasticacheNodesPerRegion` (300), `elasticacheNodesPerCluster` (90),
`elasticacheMemcachedNodesPerCluster` (60), `elasticacheServerlessCachesPerRegion` (40).

### Node types

| Type | vCPU | Memory (GiB) | maxmemory (bytes) | Memcached memory (MB) | Baseline / burst (Gbps) | I/O multiplexing | maxclients | Commands/s (A) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cache.t4g.micro | 2 | 0.5 | 536,870,912 | 512 | 0.064 / 5 | no | 20,000 | 100,000 |
| cache.t4g.small | 2 | 1.37 | 1,471,026,299 | 1,402 | 0.128 / 5 | no | 65,000 | 100,000 |
| cache.t4g.medium | 2 | 3.09 | 3,317,862,236 | 3,164 | 0.256 / 5 | no | 65,000 | 100,000 |
| cache.m7g.large | 2 | 6.38 | 6,854,542,746 | 6,537 | 0.937 / 12.5 | yes | 65,000 | 125,000 |
| cache.m7g.xlarge | 4 | 12.93 | 13,891,921,715 | 13,248 | 1.876 / 12.5 | yes | 65,000 | 200,000 |
| cache.r6g.large | 2 | 13.07 | 14,037,181,030 | 13,387 | 0.75 / 10 | no | 65,000 | 100,000 |
| cache.r7g.large | 2 | 13.07 | 14,037,181,030 | 13,387 | 0.937 / 12.5 | yes | 65,000 | 125,000 |
| cache.r7g.xlarge | 4 | 26.32 | 28,261,849,702 | 26,953 | 1.876 / 12.5 | yes | 65,000 | 200,000 |
| cache.r7g.2xlarge | 8 | 52.82 | 56,711,183,565 | 54,084 | 3.75 / 15 | yes | 65,000 | 500,000 |
| cache.r7g.4xlarge | 16 | 105.81 | 113,609,865,216 | 108,347 | 7.5 / 15 | yes | 65,000 | 1,000,000 |
| cache.c7gn.large | 2 | 3.09 | 3,317,862,236 | 3,164 | 6.25 / 30 | no | 65,000 | 100,000 |

Everything but the last column is from AWS (Supported node types; Engine specific parameters, where Memcached's
`num_threads` gives the vCPUs). The last column is an assumption anchored on AWS's one figure: "over 1 million requests
per second per node" on r7g.4xlarge or larger (ElastiCache 7.1 for Redis OSS). Memcached is taken to run 100,000 a
second per thread.

## Limits

| Limit | Value | Kind | Source |
| --- | --- | --- | --- |
| Nodes per region | 300 | quota | https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/quota-limits.html |
| Nodes per cluster (Valkey/Redis OSS cluster mode) | 90; up to 500 on request (Valkey 7.2+, Redis OSS 5.0.6 to 7.1; 250 below 5.0.6) | quota | same, and https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Shards.html |
| Nodes per cluster (Memcached) | 60 | quota | quota-limits.html |
| Serverless caches per region | 40 | quota | quota-limits.html |
| Nodes per shard | 1 to 6 (primary and up to 5 replicas) | hard | Shards.html |
| Shards with cluster mode off | 1 | hard | Shards.html |
| Hash slots | 16,384 | hard | https://valkey.io/topics/cluster-spec/ (and the slot ranges in Shards.html) |
| Memory, baseline and burst bandwidth per node type | see *Node types* | hard | https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/CacheNodes.SupportedTypes.html |
| maxmemory per node type; Memcached max_cache_memory and num_threads | see *Node types* | hard | https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/ParameterGroups.Engine.html |
| reserved-memory-percent | 25% default; AWS advises 30% on small, 50% on micro nodes | default | https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/redis-memory-management.html |
| maxmemory-policy | volatile-lru default | default | ParameterGroups.Engine.html |
| maxmemory-samples | 3 | default (not modelled: CLOCK instead) | ParameterGroups.Engine.html |
| maxclients | 65,000; t4g.micro and t3.micro 20,000; t3.small and t3.medium 46,000 | hard | ParameterGroups.Engine.html |
| Largest value | 512 MB (`proto-max-bulk-len` maximum) | hard | ParameterGroups.Engine.html |
| Memcached max_item_size | 1 MB default | default | ParameterGroups.Engine.html |
| Memcached connections overhead | 100 MB default | default | ParameterGroups.Engine.html |
| Failover | the least-lagged replica is promoted; writes resume "typically just a few seconds" later; a replacement replica is provisioned; without Multi-AZ a new primary is provisioned, synced from a replica or empty | behaviour | https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/AutoFailover.html |
| Automatic failover in cluster mode | always on | hard | AutoFailover.html |
| Multi-AZ placement | "distributes your replicas across different Availability Zones"; requires at least one replica in a zone other than the primary's | behaviour | AutoFailover.html |
| An Availability Zone failing | the replica replacing a failed primary there "is created only when the Availability Zone is back up" | behaviour | AutoFailover.html ("Limitations on Multi-AZ") |
| Serverless | "automatically replicates your data across multiple Availability Zones" | behaviour | WhatIs.corecomponents.html |
| Throughput per node | not published; "over 1 million requests per second per node" on r7g.4xlarge+ (7.1); up to 72% more with enhanced I/O multiplexing (7.0, r6g.xlarge, 5,200 clients) | assumed | https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/engine-versions.html |
| ECPU | 1 per KB transferred by a simple read or write | hard | https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/WhatIs.corecomponents.html |
| Serverless throughput | 30,000 ECPU/s empty, 90,000 reading from replicas; doubles every 2 to 3 minutes (Valkey 8); 30,000 ECPU/s per slot (90,000 READONLY) | hard | https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Scaling-serverless.html |
| Serverless limits | over max ECPU/s: throttled; at max storage: TTL keys evicted (LRU), else OOM; minimum applied within 60 minutes | behaviour | Scaling-serverless.html |

Where pages disagree: the memory management page says `maxmemory` is the advertised memory *minus* the reserve, while the
parameter page lists `maxmemory` per node type as the advertised memory. The model takes the parameter page's value and
sets the reserve aside from it, which reproduces the memory page's own example (13.5 GB advertised, 25% reserved, about
10.1 GB for data).

## Behaviour

**Keys, slots and shards.** A request's `key` (a hash in [0, 1)) picks one of `keyspace.keys` keys, `floor(key^skew x
keys)`, so a skew above 1 piles requests onto a few keys (P(key < k) = (k / N)^(1 / skew)). The key's slot is a
multiplicative hash standing in for CRC16 mod 16,384, and slots are spread over the shards in even ranges, as ElastiCache
does. A client's hot-key share sends one fixed key, which is one slot, one shard.

**A read.** The read goes to a node of its shard (`readFrom`) and runs one command there. If the key is there and fresh
it is a hit: the reply waits for the node's engine and network and is answered. If not it is a miss: after the GET the
database is read through `misses`; when it answers, the key is SET on the shard's primary with the TTL (the caller waits for
that too), and the caller has its value. A database failure fails the read (and every read waiting on it). A fill that
fails (OOM, the primary failing over, a value too large) doesn't fail the read: the value just isn't cached.

**The thundering herd.** Every read that misses while a key is being fetched reads the database too: with `n` reads a
second of a key and a fetch taking `t`, a cold or expired key costs about `1 + n t` database reads. A flush, a cold
start or keys filled together and expiring together multiply that over many keys. `stampede: lock` makes it one per key
(the others wait for the fill); it helps a hot key, not a cold cache of many keys, whose misses are mostly distinct keys.
TTL jitter spreads synchronised expiries.

**Hit ratio.** With uniform reads over `N` keys and room for `C` of them, an LRU settles at about `C / N`. With a TTL of
`T` and a key read `r` times a second, that key misses about `r / (1 + r T)` times a second once warm. `cacheMisses`
counts every GET that found nothing, including the ones that then waited on a lock (as CloudWatch's CacheMisses would);
`hitRate` is hits over hits plus misses over the last ten seconds.

**Memory.** A shard holds `capacity = floor(maxmemory x (1 - reserved) / (itemSize + keyOverhead))` keys (Memcached:
`(max_cache_memory - 100 MB) / ...`; serverless: the storage maximum, or no limit). A new key past it evicts by CLOCK
(second chance on recently used keys, Redis's LRU is itself approximate); an expired key is reclaimed first. volatile-lru
evicts only keys with a TTL, so with `ttl: 0` a full cache refuses every new key with OOM (an audit warns about it);
noeviction refuses always. Write-through fills memory with written keys whether anyone reads them or not.

**A node's limits.** Every node is a queue with one server. A command holds its engine for `1 / opsPerNode` seconds; its
reply then holds the node's network for `bytes x 8 / baseline bandwidth`. Offered more than either, the queue grows, the
latency of every command on the node (hits included) grows with it, and callers time out (their edge timeout is the
client's command timeout). The cache carries on with the commands of callers that gave up, as a server does. Past
`maxclients` waiting commands a node refuses more (Throttled, "ERR max number of clients reached"). Replicas take the
reads sent to them, and apply every write (a command each, and the bytes over the primary's network). `engineUtilization`
is the busiest node's busier resource over the last second; `meanUtilization` the average over the nodes.

**Failover.** `actions.failPrimary` fails the primary of shard `failShard`. With automatic failover and a replica up, the
first replica up is promoted at `detection + promotion`; until then writes and fills to the shard fail (Unavailable),
reads from the primary fail (or fail open to the database) and reads from replicas carry on. The other replicas resync
from the new primary for `replicaResync` (unreadable), and the failed node comes back as a replica `replacement` after
the promotion. No data is lost (replication lag is not modelled). Without automatic failover the primary is replaced
after `detection + replacement`, synced from a replica if there is one; with no replica (or Memcached) it comes back
empty. With `failOpen`, a write whose cache update fails still succeeds (the database has it).

**Availability zones.** Node `r` of shard `s` (the primary is node 0 until a failover) is in the `(s + r)`-th zone after
the node's `zone` (the region's first if it has none), round robin over the region's zones: a shard's nodes are in
different zones (as Multi-AZ puts them, up to as many as the region has) and the shards' primaries are spread over the
zones. The component handles its zones' faults (`handlesZoneFaults`), so an Outage on a zone is a node failure for every
node in it: each shard whose primary is there fails it as `failPrimary` does (with automatic failover, a replica in
another zone takes over after `detection + promotion`; with no replica up elsewhere the shard's data is gone), and the
shards' other nodes there stop serving (a read from replicas goes to another node, or the primary). ElastiCache creates
the lost nodes again only once their zone is back, so when it returns each of them is down for `replacement` more, and
rejoins as a replica (or, for a shard that couldn't fail over, as its primary, empty if it had no replica). A serverless
cache replicates across zones behind its endpoint and doesn't notice. A zone's Slow and Errors faults don't reach the
nodes.

**Serverless.** Each command costs `max(1, KB)` ECPUs, taken from a bucket for its slot (30,000 a second, 90,000 for
reads from replicas) and one for the cache (what it supports now). Either empty: Throttled. The cache starts at 30,000
(90,000 reading from replicas, or the pre-scaled minimum) and, at the end of each `scaleInterval`, doubles if its busiest
second used more than half of it, never past the maximum. Commands take the proxy latency. Storage evicts keys with a TTL.

**Differences from AWS.** There are no values, so no staleness. One message is one command on one key: its `count` is
ignored and its size is `itemSize`. One node failing is a button (`actions.failPrimary`); a fault fails a zone's nodes,
or the whole endpoint. Resharding is instant.
Node network bursts and CPU credits are not modelled. Reshaping the cluster live resets the queues and any failover.

## Connections

- **In:** any component. The edge's `request.operation` decides what the call is: `read` is a GET (cached), `write` a
  database write followed by a DEL or SET. Edges default to `write`, so set the edge to `read` for reads; an application
  that both reads and writes needs two edges (a client splits its traffic between them by weight). The edge's timeout is
  the client's command timeout, and its retries the client's.
- **Out, `misses` and `writes`, one edge each, usually to the same database:** the calls the application's cache-aside
  code makes. `misses` carries a read per miss (and per fail-open read); `writes` a write per write, before the cache is
  updated. Each carries the request's key and `itemSize` bytes. Each port declares its own default operation (`misses`
  read, `writes` write), because whatever sits on an edge stamps every call with the edge's operation, and the edge
  default is a write. So any connector the target brings keeps working: an edge into `aws.rds` gets RDS's own
  `aws.rds.client` (connection pooling, max_connections) and an edge into anything else the plain link, with their
  timeouts and retries. Leave `misses` unwired for a cache that is the store (a miss is an empty answer), and `writes`
  unwired for one that keeps the writes itself (a write is a SET). An audit can't check that both go to the same place:
  audits see nodes, not edges.
- **CloudFormation:** `AWS::ElastiCache::*` is not imported yet.

## Metrics and state

Counters (per second in frames): `reads`, `writes`, `cacheHits`, `cacheMisses`, `collapsed` (reads that waited on another's
fill), `databaseReads`, `databaseWrites`, `bypassed` (fail-open reads), `fillFailures`, `cacheErrors` (commands the cache
couldn't run), `refused` (maxclients), `throttled` (serverless), `evictions`, `expired`, `oom`, `failovers`, `flushes`,
`ecpu`, `setTypeCmds` (SETs and DELs the cache ran: fills, write-throughs, invalidations), `networkBytesIn` and
`networkBytesOut` (values clients wrote and read: client traffic), `replicationBytes` (what primaries sent their
replicas). Samplers: `readLatency` and `writeLatency` (a successful cache command's own time, queueing at its node
included and the database's time apart: SuccessfulReadRequestLatency, SuccessfulWriteRequestLatency), `replicationLag`
(how much later than the primary the last replica has a write: once the primary's network has sent it and the replica's
engine has reached it). Gauges: `hitRate` (last ten seconds), `items`, `memoryUsed` (fullest shard's share of its memory),
`engineUtilization` (busiest node's busier resource, engine or network), `meanUtilization`, `engineCpu` and
`engineCpuMean` (the busiest and the mean engine thread: EngineCPUUtilization), `networkUtilization` (the busiest node's
network, of its baseline bandwidth), `shardsWriteBlocked`, `ecpuCeiling`, `nodesDown` (failed, being replaced or
resynced, or in a zone that is down). The framework adds `in`, `ok`, `fail`, `fail.<Kind>`, `latency`, `inflight`.

The dashboard (`internal/dashboard.ts`) charts these under CloudWatch's names: CacheHitRate, CacheHits and CacheMisses with
SetTypeCmds, EngineCPUUtilization (and serverless's ElastiCacheProcessingUnits as a share of its current ceiling),
SuccessfulRead/WriteRequestLatency, the cache-aside code's database calls, DatabaseMemoryUsagePercentage, CurrItems,
Evictions and Reclaimed, NetworkBytesIn/Out and ReplicationBytes, ErrorCount and ThrottledCmds, and ReplicationLag.
Connections aren't modelled (CurrConnections, NewConnections), nor a host's CPU beside its engine thread
(CPUUtilization), nor FreeableMemory.

The probe reports the engine and deployment, `shards` and `nodes` running, `nodesDown`, `capacityPerShard` (-1 for no limit), `items`,
`memoryUsed`, `hitRatio` (since the start), `recentHitRatio`, the read, write, hit, miss, collapsed, database, bypass,
eviction, expiry, OOM, refusal, failover and throttle totals, `shardsWriteBlocked`, the `hottestShard` and its
`hottestUtilization`, and serverless's `ecpuCeiling`.

## Not yet simulated

1. **Faults on parts of the cluster.** A zone's Outage fails the nodes in it; failing one node is a button
   (`actions.failPrimary`), and an Outage on the node is the whole endpoint unreachable. A zone's Slow and Errors faults
   don't reach the nodes in it yet (a per-node extra delay and error rate in the command path would do), and the replica
   with the least lag isn't chosen (no lag is modelled). Which zones a shard's nodes are in is fixed; AWS lets you choose.
2. **Replication lag**: reads from replicas that miss recent writes, and writes lost when a lagging replica is promoted.
3. **Client behaviour**: topology refresh and MOVED/ASK redirects during resharding, DNS caching after a failover,
   connection pools. Retries are the edge's.
4. **Scaling takes time**: online resharding and node type changes take minutes in AWS; a controller (`core.target-tracking`
   on `shards`) can already drive the setting.
5. **Network burst credits and t4g CPU credits**, so a small node is fast until its credits run out.
6. **Command costs**: only simple GET/SET/DEL. Hashes, sorted sets, Lua, MGET and pipelines (messages with `count` > 1),
   and O(N) commands on big keys that stall the engine thread.
7. **More eviction policies** (allkeys-lfu, volatile-lfu, volatile-ttl, random) and mixed TTLs and value sizes.
8. **Staleness**: no values, so no stale reads after a write that didn't invalidate, or the fill race that writes an old
   value back.
9. **Memcached client-side remapping** when a node leaves (consistent hashing moves 1/N of the keys).
10. **Global Datastore** (cross-region replication), data tiering (r6gd), durability (Valkey 9's transactional log),
    snapshots (fork memory and latency), serverless scale-in and its hour-long pre-scaling.
11. **CloudFormation import** of `AWS::ElastiCache::ReplicationGroup`, `CacheCluster` and `ServerlessCache`.

## Assumptions

- Commands per second per node (the node type table's last column) and 100,000 per Memcached thread: AWS publishes only
  "over 1 million requests per second per node" on r7g.4xlarge and larger.
- 80 bytes of memory per key besides its value.
- Failure detection 5 s, promotion 3 s ("typically just a few seconds"), node replacement 5 minutes, replica resync 10 s.
- Nodes round robin over the region's zones from the node's zone, a shard's nodes in successive zones and each shard
  starting one zone after the last: AWS places them in different zones with Multi-AZ but lets you choose which.
- A zone's lost nodes are replaced in `replacement` once it is back, as a node failure's are.
- One connection per waiting command, for `maxclients`.
- A node's network is its baseline bandwidth, and carries replies and replication only.
- Serverless: 0.5 ms per command through the proxy; it doubles when its busiest second in the interval passed half of
  what it supports; it doesn't scale in during a run; its buckets hold one second; pre-scaling applies at once.
- The application writes the database first and the cache second, fails open by default, and finishes its database call
  and fill even after its caller gave up.
- The slot hash scatters keys as CRC16 does; CLOCK stands in for Redis's sampled LRU; active expiry looks at the 200
  oldest keys of each shard a second.
- `keyspace` (keys, skew, value size) and `caching` (TTL, jitter, writes, lock, fail open) are properties of your
  application.

## References

- https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/CacheNodes.SupportedTypes.html
- https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/ParameterGroups.Engine.html
- https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/redis-memory-management.html
- https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/quota-limits.html
- https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Shards.html
- https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/AutoFailover.html
- https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/engine-versions.html
- https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/WhatIs.corecomponents.html
- https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Scaling-serverless.html
- https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Strategies.html
- https://docs.aws.amazon.com/whitepapers/latest/database-caching-strategies-using-redis/caching-patterns.html
- https://aws.amazon.com/caching/best-practices/
- https://valkey.io/topics/cluster-spec/
