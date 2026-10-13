import { Duration } from "effect"
import type { Diagnostic } from "../../Diagnostic.ts"
import type { Account } from "../internal/account.ts"
import { type Audit, fmt } from "../internal/service.ts"
import { type Config, FAILOVER_URL, QUOTAS_URL } from "./internal/config.ts"
import { derive } from "./internal/derived.ts"

/**
 * What a design asks of ElastiCache in one region: nodes over the account's quotas, clusters that will run smaller than
 * asked, and settings that combine badly (a full cache that may evict nothing, a primary with no replica to fail over
 * to). Pure and cheap: it reads each cluster's settings only.
 */
export const audit: Audit = (region, members, quotas) => {
  const account = quotas as Account
  const out: Array<Diagnostic> = []
  const caches = members.filter((m) => m.type === "aws.elasticache")
  let nodes = 0
  let serverless = 0

  for (const m of caches) {
    const c = m.config as Config
    const d = derive(c, account)
    const node = { node: m.id }
    if (d.serverless) {
      serverless++
      continue
    }
    nodes += d.shards * d.group

    const asked = c.engine === "memcached" ? c.shards : c.clusterMode ? c.shards * d.group : d.group
    if (c.engine !== "memcached" && !c.clusterMode && c.shards > 1) {
      out.push({
        ...node,
        level: "warning",
        code: "elasticache-shards-without-cluster-mode",
        message: `${m.name} asks for ${fmt(c.shards)} shards with cluster mode off, which always has one shard. Turn cluster mode on to split the keys.`
      })
    } else if (d.shards * d.group < asked) {
      const quota = c.engine === "memcached" ? account.elasticacheMemcachedNodesPerCluster : account.elasticacheNodesPerCluster
      out.push({
        ...node,
        level: "warning",
        code: "elasticache-nodes-per-cluster",
        message: `${m.name} asks for ${fmt(asked)} nodes but a cluster may have ${fmt(quota)} (${QUOTAS_URL}); it runs with ${fmt(d.shards)} shards.`
      })
    }
    if (c.engine === "memcached" && c.replicasPerShard > 0) {
      out.push({ ...node, level: "info", code: "elasticache-memcached-replicas", message: `${m.name} runs Memcached, which has no replicas: the replica setting is ignored.` })
    }
    if (c.engine !== "memcached" && c.replicasPerShard === 0) {
      out.push({
        ...node,
        level: "info",
        code: "elasticache-no-replica",
        message: `${m.name} has no replicas: if a primary fails, its shard is down until the node is replaced and comes back empty (${FAILOVER_URL}).`
      })
    }
    if (c.engine !== "memcached" && c.clusterMode && !c.automaticFailover) {
      out.push({ ...node, level: "info", code: "elasticache-cluster-mode-failover", message: `${m.name} has cluster mode on, where automatic failover is always on; the setting is ignored.` })
    }
    // A dataset bigger than memory under a policy that may evict nothing fills up and then refuses every new key.
    const dataset = c.keyspace.keys * d.entryBytes
    const memory = d.dataBytes * d.shards
    if (dataset > memory && c.engine !== "memcached") {
      const noTtl = Duration.toMillis(c.caching.ttl) === 0
      if (c.memory.evictionPolicy === "noeviction" || (c.memory.evictionPolicy === "volatile-lru" && noTtl)) {
        out.push({
          ...node,
          level: "warning",
          code: "elasticache-nothing-to-evict",
          message: `${m.name} has more keys (${fmt(c.keyspace.keys)}) than fit in memory, and ${c.memory.evictionPolicy}${noTtl ? " with no TTL" : ""} may evict none of them: once full, new keys fail with OOM. Set a TTL or use allkeys-lru.`
        })
      }
    }
  }

  if (nodes > account.elasticacheNodesPerRegion) {
    out.push({
      level: "warning",
      code: "elasticache-nodes-per-region",
      message: `ElastiCache in ${region} has ${fmt(nodes)} nodes, over the account's ${fmt(account.elasticacheNodesPerRegion)} per region (${QUOTAS_URL}).`
    })
  }
  if (serverless > account.elasticacheServerlessCachesPerRegion) {
    out.push({
      level: "warning",
      code: "elasticache-serverless-per-region",
      message: `ElastiCache in ${region} has ${fmt(serverless)} serverless caches, over the account's ${fmt(account.elasticacheServerlessCachesPerRegion)} per region (${QUOTAS_URL}).`
    })
  }
  return out
}
