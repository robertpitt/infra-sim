import { type Dashboard, dist, gauge, latencyPanel, rate, ratio, sum } from "../../../Dashboard.ts"

/**
 * A cache's dashboard, as CloudWatch shows a Valkey or Redis OSS cluster (and a serverless cache): hits and misses and
 * the hit rate, how busy the busiest node's engine thread is, command latency, memory, items, evictions, network bytes,
 * replication lag, errors and throttled commands; and, because the component is the application's cache-aside code too,
 * the database calls it makes. Names follow CloudWatch's
 * (https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/CacheMetrics.Redis.html and
 * https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/serverless-metrics-events-redis.html).
 *
 * Connections aren't modelled (a command is refused at maxclients when too many wait at a node), so CurrConnections and
 * NewConnections have no counterpart; nor do host CPUUtilization (the engine thread is all a node's CPU here) and
 * FreeableMemory.
 */
export const dashboard: Dashboard = {
  figures: [
    { label: "Hit rate", metric: gauge("hitRate"), unit: "ratio", cloudwatch: "CacheHitRate" },
    { label: "Requests", metric: rate("in"), unit: "perSecond" },
    // The busier of a node's engine thread and its network, on the busiest node: a hot key's values can fill the network
    // long before the engine is busy, which EngineCPUUtilization alone would hide.
    { label: "Busiest node", metric: gauge("engineUtilization"), unit: "ratio" },
    { label: "Memory (max)", metric: gauge("memoryUsed"), unit: "ratio", cloudwatch: "DatabaseMemoryUsagePercentage" },
    { label: "Evictions", metric: rate("evictions"), unit: "perSecond", tone: "warn", cloudwatch: "Evictions" },
    { label: "Errors", metric: sum(rate("cacheErrors"), rate("fillFailures")), unit: "perSecond", tone: "bad", cloudwatch: "ErrorCount" }
  ],
  panels: [
    {
      id: "hit-rate",
      title: "Cache hit rate",
      unit: "ratio",
      cloudwatch: ["CacheHitRate"],
      help: "Hits over lookups. It isn't a setting: it comes from the key space, the memory, the TTL and how popular the keys are.",
      lines: [{ label: "hit rate", metric: ratio(rate("cacheHits"), sum(rate("cacheHits"), rate("cacheMisses"))), tone: "ok" }]
    },
    {
      id: "commands",
      title: "Commands",
      unit: "perSecond",
      cloudwatch: ["CacheHits", "CacheMisses", "GetTypeCmds", "SetTypeCmds"],
      help: "GETs that found the key and those that didn't, and SET-type commands: fills after a miss, write-throughs and invalidations.",
      lines: [
        { label: "hits", metric: rate("cacheHits"), tone: "ok" },
        { label: "misses", metric: rate("cacheMisses"), tone: "warn" },
        { label: "SET/DEL", metric: rate("setTypeCmds"), tone: "accent" }
      ]
    },
    {
      id: "utilization",
      title: "Engine CPU",
      unit: "ratio",
      cloudwatch: ["EngineCPUUtilization", "ElastiCacheProcessingUnits"],
      help: "Valkey and Redis OSS run commands on one thread: the busiest node is where a hot key lives. Network is the busiest node's share of its baseline bandwidth. A serverless cache has no nodes: its line is ECPUs used of what it has scaled to.",
      lines: [
        { label: "busiest node", metric: gauge("engineCpu"), tone: "warn" },
        { label: "mean", metric: gauge("engineCpuMean"), tone: "primary" },
        { label: "busiest network", metric: gauge("networkUtilization"), tone: "teal" },
        { label: "ECPU (serverless)", metric: ratio(rate("ecpu"), gauge("ecpuCeiling")), tone: "accent" }
      ]
    },
    {
      id: "latency",
      title: "Successful request latency",
      unit: "ms",
      cloudwatch: ["SuccessfulReadRequestLatency", "SuccessfulWriteRequestLatency"],
      help: "The cache's own time for a command, queueing at a busy node included; a miss's database read comes after it.",
      lines: [
        { label: "read p50", metric: dist("readLatency", "p50"), tone: "primary" },
        { label: "read p99", metric: dist("readLatency", "p99"), tone: "bad" },
        { label: "write p50", metric: dist("writeLatency", "p50"), tone: "accent" },
        { label: "write p99", metric: dist("writeLatency", "p99"), tone: "warn" }
      ]
    },
    {
      id: "database",
      title: "Database calls",
      unit: "perSecond",
      help: "What the application's cache-aside code sends the database: a read per miss (one per key while a fill is in flight, with the lock), every write, and reads that skip a failing cache (fail open).",
      lines: [
        { label: "reads", metric: rate("databaseReads"), tone: "primary" },
        { label: "writes", metric: rate("databaseWrites"), tone: "accent" },
        { label: "waited on a fill", metric: rate("collapsed"), tone: "teal" },
        { label: "bypassed the cache", metric: rate("bypassed"), tone: "warn" }
      ]
    },
    {
      id: "memory",
      title: "Memory used",
      unit: "ratio",
      cloudwatch: ["DatabaseMemoryUsagePercentage"],
      help: "The fullest shard's share of its maxmemory. At 100% it evicts (or, with noeviction, refuses writes).",
      lines: [{ label: "fullest shard", metric: gauge("memoryUsed"), tone: "accent" }]
    },
    {
      id: "items",
      title: "Items",
      unit: "count",
      cloudwatch: ["CurrItems"],
      lines: [{ label: "items", metric: gauge("items"), tone: "primary" }]
    },
    {
      id: "evictions",
      title: "Evictions and expirations",
      unit: "perSecond",
      cloudwatch: ["Evictions", "Reclaimed"],
      help: "Keys evicted for memory, keys reaching their TTL, and writes refused as out of memory (noeviction).",
      lines: [
        { label: "evicted", metric: rate("evictions"), tone: "bad" },
        { label: "expired", metric: rate("expired"), tone: "muted" },
        { label: "out of memory", metric: rate("oom"), tone: "warn" }
      ]
    },
    {
      id: "network",
      title: "Network bytes",
      unit: "bytesPerSecond",
      cloudwatch: ["NetworkBytesIn", "NetworkBytesOut", "ReplicationBytes"],
      help: "Values clients write and read, and what primaries send their replicas. A node's network has a baseline bandwidth, which a hot key's values can fill.",
      lines: [
        { label: "in", metric: rate("networkBytesIn"), tone: "accent" },
        { label: "out", metric: rate("networkBytesOut"), tone: "primary" },
        { label: "replication", metric: rate("replicationBytes"), tone: "teal" }
      ]
    },
    {
      id: "errors",
      title: "Errors and throttled commands",
      unit: "perSecond",
      cloudwatch: ["ErrorCount", "ThrottledCmds"],
      help: "Commands the cache couldn't run (a node failing over, maxclients reached, out of memory); fills that failed; and, serverless, commands throttled while it scales.",
      lines: [
        { label: "errors", metric: rate("cacheErrors"), tone: "bad" },
        { label: "maxclients", metric: rate("refused"), tone: "warn" },
        { label: "throttled", metric: rate("throttled"), tone: "accent" },
        { label: "failed fills", metric: rate("fillFailures"), tone: "muted" }
      ]
    },
    latencyPanel("replication-lag", "Replication lag", "replicationLag", ["ReplicationLag"])
  ]
}
