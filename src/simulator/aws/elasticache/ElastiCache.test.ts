import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { dist, sim } from "../../components/testing.ts"
import { ElastiCache } from "./index.ts"
import { design, gauge, peak, rate, run, stateOf } from "./testkit.ts"

/** r7g.large: maxmemory 14,037,181,030 bytes (ParameterGroups.Engine.html). */
const R7G_LARGE_MAXMEMORY = 14_037_181_030
/** With 99% reserved, 10 KB values and 80 bytes of overhead, a shard holds this many keys. */
const SMALL = { memory: { reservedMemoryPercent: 99 }, keyspace: { itemSize: 10 } }
const SMALL_CAPACITY = Math.floor((R7G_LARGE_MAXMEMORY * 0.01) / (10 * 1024 + 80))

describe("aws.elasticache: the hit ratio emerges", () => {
  it("is near 1 with few keys and near 0 with many", async () => {
    // With a lock each key is read from the database exactly once.
    const few = await run(design({ settings: { keyspace: { keys: 20 }, caching: { stampede: "lock" } } }), 20_000)
    expect(few.state.hitRatio).toBeGreaterThan(0.99)
    expect(few.state.databaseReads).toBe(20)
    // 20,000 reads over ten million keys: nearly every one is the first for its key.
    const many = await run(design({ settings: { keyspace: { keys: 10_000_000 } } }), 20_000)
    expect(many.state.hitRatio).toBeLessThan(0.01)
    expect(many.state.databaseReads).toBeGreaterThan(19_500)
  })

  it("a skewed popularity makes the same key space far easier to cache", async () => {
    const at = (popularitySkew: number) => run(design({ settings: { keyspace: { keys: 200_000, popularitySkew } } }), 30_000)
    const even = await at(1)
    const skewed = await at(4)
    expect(even.state.hitRatio).toBeLessThan(0.1)
    expect(skewed.state.hitRatio).toBeGreaterThan(0.25)
    expect(skewed.state.hitRatio).toBeGreaterThan(even.state.hitRatio * 4)
  })

  it("one hot key is read from the database once and then served from memory", async () => {
    const { state } = await run(design({ settings: { caching: { stampede: "lock" } }, load: { hotKeys: 1 } }), 10_000)
    expect(state.databaseReads).toBe(1)
    expect(state.items).toBe(1)
    // The GETs that found nothing while the first fill was under way are misses, as CloudWatch counts them.
    expect(state.misses).toBe(state.collapsed + 1)
    expect(state.hitRatio).toBeGreaterThan(0.995)
  })

  it("rises as the cache warms", async () => {
    const { all } = await run(design({ settings: { keyspace: { keys: 5_000 } }, load: { rps: 2_000 } }), 40_000)
    expect(gauge(all, "cache", "hitRate", 1_000, 3_000)).toBeLessThan(0.6)
    expect(gauge(all, "cache", "hitRate", 30_000)).toBeGreaterThan(0.98)
  })
})

describe("aws.elasticache: TTL", () => {
  it("a key is read from the database again once its TTL has passed", async () => {
    const { state } = await run(design({ settings: { keyspace: { keys: 1 }, caching: { ttl: "10 seconds", stampede: "lock" } }, load: { rps: 50 } }), 60_000)
    // At about 0, 10, 20, 30, 40 and 50 seconds.
    expect(state.databaseReads).toBeGreaterThanOrEqual(5)
    expect(state.databaseReads).toBeLessThanOrEqual(7)
    expect(state.expired).toBeGreaterThanOrEqual(4)
  })

  it("keys filled together expire together, and jitter spreads them out", async () => {
    // 200 keys at 4,000 reads a second are all filled within a fraction of a second, and so all expire in it.
    const at = (ttlJitter: number) =>
      run(design({ settings: { keyspace: { keys: 200 }, caching: { ttl: "20 seconds", ttlJitter } }, load: { rps: 4_000 } }), 40_000)
    const together = await at(0)
    const spread = await at(0.5)
    const herd = peak(together.all, "cache", "databaseReads", 15_000, 25_000)
    const smooth = peak(spread.all, "cache", "databaseReads", 15_000, 25_000)
    expect(herd).toBeGreaterThan(600)
    expect(smooth).toBeLessThan(herd / 3)
  })

  it("a TTL of 0 never expires", async () => {
    const { state } = await run(design({ settings: { keyspace: { keys: 1 }, caching: { ttl: 0, stampede: "lock" } }, load: { rps: 50 } }), 60_000)
    expect(state.databaseReads).toBe(1)
    expect(state.expired).toBe(0)
  })
})

describe("aws.elasticache: memory and eviction", () => {
  it("a shard holds maxmemory less the 25% reserve, over value plus overhead", async () => {
    const { state } = await run(design({ load: { rps: 1 } }), 1_000)
    expect(state.capacityPerShard).toBe(Math.floor((R7G_LARGE_MAXMEMORY * 0.75) / (1024 + 80)))
    const small = await run(design({ settings: SMALL, load: { rps: 1 } }), 1_000)
    expect(small.state.capacityPerShard).toBe(SMALL_CAPACITY)
  })

  it("past its memory the cache evicts, and with uniform reads the hit ratio settles at memory over key space", async () => {
    const keys = SMALL_CAPACITY * 4
    const { state, all } = await run(design({ settings: { ...SMALL, keyspace: { ...SMALL.keyspace, keys } }, load: { rps: 2_000 } }), 90_000)
    expect(state.items).toBe(SMALL_CAPACITY)
    expect(state.evictions).toBeGreaterThan(10_000)
    expect(state.oom).toBe(0)
    expect(gauge(all, "cache", "memoryUsed", 60_000)).toBeCloseTo(1, 2)
    const settled = gauge(all, "cache", "hitRate", 60_000)
    expect(settled).toBeGreaterThan(0.2)
    expect(settled).toBeLessThan(0.3)
  })

  it("volatile-lru with no TTL may evict nothing: once full, every new key fails with OOM", async () => {
    const keys = SMALL_CAPACITY * 4
    const { state } = await run(design({ settings: { ...SMALL, keyspace: { ...SMALL.keyspace, keys }, caching: { ttl: 0 } }, load: { rps: 2_000 } }), 40_000)
    expect(state.items).toBe(SMALL_CAPACITY)
    expect(state.evictions).toBe(0)
    expect(state.oom).toBeGreaterThan(10_000)
  })

  it("allkeys-lru evicts keys with no TTL; noeviction refuses", async () => {
    const keys = SMALL_CAPACITY * 4
    const lru = await run(design({ settings: { ...SMALL, keyspace: { ...SMALL.keyspace, keys }, caching: { ttl: 0 }, memory: { ...SMALL.memory, evictionPolicy: "allkeys-lru" } }, load: { rps: 2_000 } }), 40_000)
    expect(lru.state.evictions).toBeGreaterThan(10_000)
    expect(lru.state.oom).toBe(0)
    const none = await run(design({ settings: { ...SMALL, keyspace: { ...SMALL.keyspace, keys }, memory: { ...SMALL.memory, evictionPolicy: "noeviction" } }, load: { rps: 2_000 } }), 40_000)
    expect(none.state.evictions).toBe(0)
    expect(none.state.oom).toBeGreaterThan(10_000)
    expect(none.state.items).toBe(SMALL_CAPACITY)
  })

  it("an LRU keeps the popular keys: skewed reads hit far more often than memory over key space", async () => {
    const keys = SMALL_CAPACITY * 4
    const { all } = await run(design({ settings: { ...SMALL, keyspace: { ...SMALL.keyspace, keys, popularitySkew: 3 } }, load: { rps: 2_000 } }), 60_000)
    // A quarter of the keys take 63% of the reads; an LRU holds most of them, and uniform reads would hit 25%.
    expect(gauge(all, "cache", "hitRate", 40_000)).toBeGreaterThan(0.45)
  })

  it("Memcached refuses values over max_item_size, so they are never cached", async () => {
    const big = { engine: "memcached", keyspace: { keys: 1, itemSize: 2_048 } }
    const refused = await run(design({ settings: big, load: { rps: 20 } }), 10_000)
    expect(refused.state.hits).toBe(0)
    expect(refused.state.items).toBe(0)
    const raised = await run(design({ settings: { ...big, memory: { memcachedMaxItemSize: 4_096 } }, load: { rps: 20 } }), 10_000)
    expect(raised.state.hitRatio).toBeGreaterThan(0.99)
  })
})

describe("aws.elasticache: read-through and writes", () => {
  it("a hit costs the trip to the cache; a miss adds the database and the fill", async () => {
    // Client to cache 1 ms each way; cache to database 1 ms each way plus 20 ms.
    const hit = await run(design({ settings: { keyspace: { keys: 1 } } }), 10_000)
    expect(dist(hit.all, "app", "latency", 2_000).mean).toBeCloseTo(2, 0)
    const miss = await run(design({ settings: { keyspace: { keys: 100_000_000 } }, load: { rps: 50 } }), 10_000)
    expect(dist(miss.all, "app", "latency", 2_000).mean).toBeCloseTo(24, 0)
  })

  it("misses reach the database as reads and writes as writes, over plain links", async () => {
    const result = await sim(design({ settings: { keyspace: { keys: 1_000_000 } }, load: { rps: 200 }, writes: 50, table: { mode: "on-demand" } }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(20_000)
        const table = (yield* s.probe("db")).state as { served: { reads: number; writes: number } }
        return { table, misses: yield* s.probeEdge("misses"), writes: yield* s.probeEdge("writes"), cache: yield* stateOf(s) }
      }))
    expect(result.misses.connector).toBe("core.link")
    expect(result.writes.connector).toBe("core.link")
    expect(result.table.served.reads).toBe(result.cache.databaseReads)
    expect(result.table.served.writes).toBe(result.cache.databaseWrites)
    expect(result.cache.databaseWrites).toBeGreaterThan(900)
  })

  it("leaves an edge into a database with a client of its own to that client", async () => {
    const doc = design({ settings: { keyspace: { keys: 1_000_000 } }, load: { rps: 50 }, writes: 10, db: false })
    const withRds = {
      ...doc,
      nodes: { ...doc.nodes, db: { type: "aws.rds", settings: {} } },
      edges: {
        ...doc.edges,
        misses: { from: { node: "cache", port: "misses" }, to: "db" },
        writes: { from: { node: "cache", port: "writes" }, to: "db" }
      }
    }
    const edges = await sim(withRds as typeof doc, (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(5_000)
        return { misses: yield* s.probeEdge("misses"), writes: yield* s.probeEdge("writes"), cache: yield* stateOf(s) }
      }))
    expect(edges.misses.connector).toBe("aws.rds.client")
    expect(edges.writes.connector).toBe("aws.rds.client")
    expect(edges.cache.databaseReads).toBeGreaterThan(200)
  })

  it("each port's own default makes the call what it is, whatever the connector stamps", () => {
    const fields = ElastiCache.ports
    const misses = Schema.decodeUnknownSync(fields.misses.config)({})
    const writes = Schema.decodeUnknownSync(fields.writes.config)({})
    expect(misses.request.operation).toBe("read")
    expect(writes.request.operation).toBe("write")
  })

  it("a write invalidates the key, so the next read misses; write-through keeps it", async () => {
    const at = (writes: string) => run(design({ settings: { keyspace: { keys: 1 }, caching: { writes, stampede: "lock" } }, load: { rps: 100 }, writes: 10 }), 30_000)
    const invalidated = await at("invalidate")
    const kept = await at("write-through")
    expect(rate(invalidated.all, "cache", "databaseWrites", 5_000)).toBeCloseTo(10, 0)
    // Every write is followed by one miss and one database read.
    expect(rate(invalidated.all, "cache", "databaseReads", 5_000)).toBeCloseTo(10, 0)
    expect(kept.state.databaseReads).toBe(1)
    expect(kept.state.hitRatio).toBeGreaterThan(0.995)
  })

  it("write-through fills memory with written keys nobody reads", async () => {
    const keys = SMALL_CAPACITY * 4
    const settings = (writes: string) => ({ ...SMALL, keyspace: { ...SMALL.keyspace, keys }, caching: { writes } })
    // Reads go to a small hot set; writes are spread over every key.
    const at = (writes: string) => run(design({ settings: settings(writes), load: { rps: 2_000, hotKeys: 0.9 }, writes: 2_000 }), 30_000)
    const invalidated = await at("invalidate")
    const through = await at("write-through")
    expect(through.state.items).toBe(SMALL_CAPACITY)
    expect(through.state.evictions).toBeGreaterThan(invalidated.state.evictions + 10_000)
  })

  it("with nothing behind it the cache is the store: a write is a SET a later read finds", async () => {
    const { state } = await run(design({ settings: { keyspace: { keys: 10 } }, load: { rps: 100 }, writes: 50, db: false }), 20_000)
    expect(state.databaseReads).toBe(0)
    expect(state.items).toBe(10)
    expect(state.hitRatio).toBeGreaterThan(0.9)
  })

  it("a failing database fails the misses and not the hits", async () => {
    const down = await run(design({ settings: { keyspace: { keys: 1 } }, db: { errorRate: 1 } }), 5_000)
    expect(down.state.hits).toBe(0)
    const { all } = await run(design({ settings: { keyspace: { keys: 100_000_000 } }, load: { rps: 100 }, db: { errorRate: 1 } }), 5_000)
    expect(rate(all, "app", "fail.Failed", 1_000)).toBeCloseTo(100, -1)
  })
})

describe("aws.elasticache: the thundering herd", () => {
  it("a cold hot key sends every reader to the database until the first fill lands; a lock sends one", async () => {
    const at = (stampede: string) => run(design({ settings: { caching: { stampede } }, load: { rps: 1_000, hotKeys: 1 }, db: { latency: { mean: 100, cv: 0 } } }), 5_000)
    const herd = await at("none")
    const locked = await at("lock")
    // 1,000 a second for the ~104 ms the first fill takes.
    expect(herd.state.databaseReads).toBeGreaterThan(90)
    expect(locked.state.databaseReads).toBe(1)
    expect(locked.state.collapsed).toBeGreaterThan(90)
  })

  it("a flush empties every node, and the database takes the cold cache's misses", async () => {
    const settings = { keyspace: { keys: 2_000 } }
    const result = await sim(design({ settings, load: { rps: 2_000 } }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(20_000)
        const before = yield* stateOf(s)
        yield* s.configureNode("cache", { ...settings, actions: { flush: 1 } })
        const all = yield* s.advanceTo(30_000)
        return { before, after: yield* stateOf(s), all }
      }))
    expect(result.before.items).toBe(2_000)
    expect(peak(result.all, "cache", "databaseReads", 20_000, 21_000)).toBeGreaterThan(1_000)
    expect(result.after.items).toBe(2_000)
  })
})

describe("aws.elasticache: hardening", () => {
  it("settings at their bounds run without throwing", async () => {
    // No memory left for data: every fill fails with OOM, and reads still get their value from the database.
    const full = await run(design({ settings: { memory: { reservedMemoryPercent: 100 } }, load: { rps: 100 } }), 5_000)
    expect(full.state.capacityPerShard).toBe(0)
    expect(full.state.items).toBe(0)
    expect(full.state.oom).toBeGreaterThan(0)
    expect(rate(full.all, "app", "fail")).toBe(0)
    // A 512 MB value is bigger than a t4g.micro's memory.
    const huge = await run(design({ settings: { nodeType: "cache.t4g.micro", keyspace: { keys: 1, itemSize: 512 * 1024 } }, load: { rps: 1 } }), 5_000)
    expect(huge.state.capacityPerShard).toBe(0)
    // The largest cluster: 500 nodes once the quota allows, of a primary and five replicas each.
    const largest = await run(
      design({ settings: { clusterMode: true, shards: 500, replicasPerShard: 5, keyspace: { keys: 1 } }, load: { rps: 10, payload: 0.001 }, account: { elasticacheNodesPerCluster: 500 } }),
      2_000
    )
    expect(largest.state.shards).toBe(83)
    expect(largest.state.nodes).toBe(498)
  })

  it("an Outage on the node is the whole cluster unreachable: every call fails at once, and it keeps its data", () =>
    sim(design({ settings: { keyspace: { keys: 100 }, caching: { stampede: "lock" } } }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(10_000)
        yield* s.faults.inject({ kind: "node", id: "cache" }, { _tag: "Outage" }, "5 seconds")
        const all = yield* s.advanceTo(20_000)
        expect(rate(all, "app", "fail.Unavailable", 10_500, 14_500)).toBeCloseTo(1_000, -2)
        expect(rate(all, "app", "fail", 15_500)).toBe(0)
        expect((yield* stateOf(s)).databaseReads).toBe(100)
      })))

  it("a caller that gives up leaves nothing behind: the fill still lands and later reads hit", async () => {
    const { state, all } = await run(
      design({ settings: { keyspace: { keys: 10 } }, load: { rps: 100 }, edge: { timeout: "5 millis" }, db: { latency: { mean: 50, cv: 0 } } }),
      10_000
    )
    expect(rate(all, "app", "fail.Timeout", 0, 500)).toBeGreaterThan(0)
    expect(state.items).toBe(10)
    expect(rate(all, "app", "fail", 2_000)).toBe(0)
  })
})
