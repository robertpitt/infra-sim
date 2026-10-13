import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { gauge, rate, sim } from "../../../../testing.ts"
import { account } from "../../../internal/account.ts"
import { audit } from "../../Audit.ts"
import { Cluster } from "../cluster.ts"
import type { Derived } from "../derived.ts"
import { ElastiCache } from "../../index.ts"
import { keyOf, shardOfSlot, slotOf, Tally } from "../store.ts"
import { design, run, stateOf } from "../../testing.ts"

/** The key the client's hot-key share always sends. */
const HOT = 0.1234
/** Values small enough that the network never matters. */
const TINY = { itemSize: 0.01 }

describe("aws.elasticache: what a node can do", () => {
  it("an engine thread runs the node type's commands a second: r7g.large is taken to do 125,000", async () => {
    const { all } = await run(design({ settings: { keyspace: { keys: 1, ...TINY }, caching: { stampede: "lock" } }, load: { rps: 10_000 } }), 10_000)
    expect(gauge(all, "cache", "engineUtilization", 2_000)).toBeCloseTo(10_000 / 125_000, 2)
  })

  it("the network sends at the node type's baseline bandwidth: 1,000 reads of 100 KB fill 87% of r7g.large's 0.937 Gbps", async () => {
    const read = (nodeType: string) =>
      run(design({ settings: { nodeType, keyspace: { keys: 1, itemSize: 100 }, caching: { stampede: "lock" } }, load: { rps: 1_000 } }), 10_000)
    const r7g = await read("cache.r7g.large")
    expect(gauge(r7g.all, "cache", "engineUtilization", 2_000)).toBeCloseTo((1_000 * 102_400 * 8) / 0.937e9, 2)
    // The network-optimised type has 6.25 Gbps.
    const c7gn = await read("cache.c7gn.large")
    expect(gauge(c7gn.all, "cache", "engineUtilization", 2_000)).toBeCloseTo((1_000 * 102_400 * 8) / 6.25e9, 2)
  })

  it("offered more than its bandwidth, a node queues and its callers time out", async () => {
    const { all } = await run(
      design({ settings: { keyspace: { keys: 1, itemSize: 100 }, caching: { stampede: "lock" } }, load: { rps: 2_000 }, edge: { timeout: "500 millis" } }),
      20_000
    )
    expect(gauge(all, "cache", "engineUtilization", 5_000)).toBeCloseTo(1, 2)
    // It sends 1,144 replies a second; the rest wait longer and longer and are given up on.
    expect(rate(all, "app", "ok", 10_000)).toBeLessThan(1_250)
    expect(rate(all, "app", "fail.Timeout", 10_000)).toBeGreaterThan(700)
  })

  it("past maxclients waiting commands, a node refuses more (t4g.micro: 20,000)", async () => {
    const { all, state } = await run(
      design({ settings: { nodeType: "cache.t4g.micro", performance: { opsPerNode: 1_000 }, keyspace: { keys: 1, ...TINY } }, load: { rps: 3_000 }, db: false }),
      20_000
    )
    // 2,000 more a second than it runs: 20,000 waiting after ten seconds, and from then on the excess is refused.
    expect(rate(all, "app", "fail.Throttled", 0, 9_000)).toBe(0)
    expect(rate(all, "app", "fail.Throttled", 12_000)).toBeCloseTo(2_000, -2)
    expect(state.refused).toBeGreaterThan(10_000)
  })
})

describe("aws.elasticache: shards and hot keys", () => {
  const sharded = { clusterMode: true, shards: 4, replicasPerShard: 0, performance: { opsPerNode: 2_000 }, keyspace: { keys: 100_000, ...TINY } }

  it("keys hash to slots spread evenly over the shards", async () => {
    const { state, all } = await run(design({ settings: sharded, load: { rps: 1_000 } }), 20_000)
    expect(state.shards).toBe(4)
    expect(gauge(all, "cache", "engineUtilization", 5_000) / gauge(all, "cache", "meanUtilization", 5_000)).toBeLessThan(1.3)
  })

  it("a hot key loads the one shard that owns its slot", async () => {
    const { state, all } = await run(design({ settings: sharded, load: { rps: 1_000, hotKeys: 0.8 } }), 20_000)
    expect(gauge(all, "cache", "engineUtilization", 5_000) / gauge(all, "cache", "meanUtilization", 5_000)).toBeGreaterThan(2.5)
    expect(state.hottestShard).toBe(shardOfSlot(slotOf(keyOf(HOT, 100_000, 1)), 4))
  })

  it("more shards do not help a hot key; replicas serving reads do", async () => {
    const hot = (settings: Record<string, unknown>) =>
      run(design({ settings: { performance: { opsPerNode: 1_000 }, keyspace: { keys: 1, ...TINY }, caching: { stampede: "lock" }, ...settings }, load: { rps: 1_500 }, edge: { timeout: "500 millis" } }), 20_000)
    const moreShards = await hot({ clusterMode: true, shards: 8, replicasPerShard: 0 })
    expect(rate(moreShards.all, "app", "fail.Timeout", 10_000)).toBeGreaterThan(300)
    const replicas = await hot({ replicasPerShard: 2, readFrom: "replicas" })
    expect(rate(replicas.all, "app", "fail", 2_000)).toBe(0)
    expect(gauge(replicas.all, "cache", "engineUtilization", 5_000)).toBeCloseTo(0.75, 1)
  })

  it("replicas apply every write the primary takes", async () => {
    // Only writes, written through: each is a SET on the primary, and the same SET on each replica.
    const at = (replicasPerShard: number) =>
      run(design({ settings: { replicasPerShard, performance: { opsPerNode: 10_000 }, keyspace: { keys: 1_000, ...TINY }, caching: { writes: "write-through" } }, load: { rps: 0 }, writes: 2_000, db: { latency: { mean: 1, cv: 0 } } }), 10_000)
    const two = await at(2)
    // Three nodes, each 2,000 commands a second of 10,000.
    expect(gauge(two.all, "cache", "engineUtilization", 2_000)).toBeCloseTo(0.2, 2)
    expect(gauge(two.all, "cache", "meanUtilization", 2_000)).toBeCloseTo(0.2, 2)
  })

  it("cluster mode off is one shard whatever the shard count", async () => {
    const { state } = await run(design({ settings: { shards: 10 }, load: { rps: 1 } }), 1_000)
    expect(state.shards).toBe(1)
  })
})

describe("aws.elasticache: nodes per cluster", () => {
  it("shards x (1 + replicas) is capped by the account's 90 nodes per cluster, and follows the quota when raised", async () => {
    const big = { clusterMode: true, shards: 40, replicasPerShard: 2 }
    const capped = await run(design({ settings: big, load: { rps: 1 } }), 1_000)
    expect(capped.state.shards).toBe(30)
    expect(capped.state.nodes).toBe(90)
    const raised = await run(design({ settings: big, load: { rps: 1 }, account: { elasticacheNodesPerCluster: 150 } }), 1_000)
    expect(raised.state.shards).toBe(40)
    expect(raised.state.nodes).toBe(120)
  })

  it("a Memcached cluster has at most 60 nodes, and no replicas", async () => {
    const { state } = await run(design({ settings: { engine: "memcached", shards: 80, replicasPerShard: 2 }, load: { rps: 1 } }), 1_000)
    expect(state.shards).toBe(60)
    expect(state.nodes).toBe(60)
  })

  it("resharding live moves the keys to the shards that now own them", () =>
    sim(design({ settings: { keyspace: { keys: 1_000 }, caching: { stampede: "lock" } }, load: { rps: 2_000 } }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(20_000)
        expect((yield* stateOf(s)).items).toBe(1_000)
        yield* s.configureNode("cache", { keyspace: { keys: 1_000 }, caching: { stampede: "lock" }, clusterMode: true, shards: 3 })
        yield* s.advanceTo(30_000)
        const after = yield* stateOf(s)
        expect(after.shards).toBe(3)
        expect(after.items).toBe(1_000)
        expect(after.databaseReads).toBe(1_000)
      })))
})

describe("aws.elasticache: failover", () => {
  /** Readers and writers on a cache that is its own store, so every failure is the cache's. Fails shard 0 at 20 s. */
  const failAt20 = (settings: Record<string, unknown>, db = false) =>
    sim(design({ settings: { keyspace: { keys: 100 }, caching: { stampede: "lock" }, ...settings }, writes: 100, ...(db ? {} : { db: false }) }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(20_000)
        const before = yield* stateOf(s)
        yield* s.configureNode("cache", { keyspace: { keys: 100 }, caching: { stampede: "lock" }, ...settings, actions: { failPrimary: 1 } })
        yield* s.advanceTo(21_000)
        const during = yield* stateOf(s)
        const all = yield* s.advanceTo(60_000)
        return { before, during, after: yield* stateOf(s), all }
      }))

  it("a replica is promoted after detection and promotion (5 s + 3 s); writes fail until then, and no data is lost", async () => {
    const { before, during, after, all } = await failAt20({ replicasPerShard: 1 })
    expect(before.items).toBe(100)
    expect(during.shardsWriteBlocked).toBe(1)
    expect(during.items).toBe(100)
    expect(rate(all, "writer", "fail.Unavailable", 21_000, 27_500)).toBeCloseTo(100, -1)
    expect(rate(all, "writer", "fail", 28_500)).toBe(0)
    // Reads go to the primary, so they fail too until the replica takes over.
    expect(rate(all, "app", "fail.Unavailable", 21_000, 27_500)).toBeCloseTo(1_000, -2)
    expect(rate(all, "app", "fail", 28_500)).toBe(0)
    expect(after.failovers).toBe(1)
    expect(after.shardsWriteBlocked).toBe(0)
  })

  it("reads from replicas carry on through a failover", async () => {
    const { all } = await failAt20({ replicasPerShard: 1, readFrom: "replicas" })
    expect(rate(all, "app", "fail", 2_000)).toBe(0)
    expect(rate(all, "writer", "fail.Unavailable", 21_000, 27_500)).toBeCloseTo(100, -1)
  })

  it("with no replica the primary is replaced: the shard is down for detection and replacement, and comes back empty", async () => {
    const { during, after, all } = await failAt20({ replicasPerShard: 0, failover: { replacement: "20 seconds" } })
    expect(during.items).toBe(0)
    expect(rate(all, "writer", "fail.Unavailable", 21_000, 44_500)).toBeCloseTo(100, -1)
    expect(rate(all, "writer", "fail", 45_500)).toBe(0)
    expect(after.items).toBe(100)
  })

  it("without automatic failover a replica keeps the data, but writes wait for the replacement", async () => {
    const { during, all } = await failAt20({ replicasPerShard: 1, automaticFailover: false, failover: { replacement: "20 seconds" } })
    expect(during.items).toBe(100)
    expect(rate(all, "writer", "fail.Unavailable", 30_000, 44_500)).toBeCloseTo(100, -1)
    expect(rate(all, "writer", "fail", 45_500)).toBe(0)
  })

  it("failing open, reads the cache cannot answer go to the database instead", async () => {
    const { after, all } = await failAt20({ replicasPerShard: 1 }, true)
    expect(rate(all, "app", "fail", 2_000)).toBe(0)
    expect(after.bypassed).toBeGreaterThan(7_000)
    expect(rate(all, "cache", "bypassed", 21_000, 27_500)).toBeCloseTo(1_000, -2)
  })

  it("after a promotion the other replicas resync from the new primary and cannot be read meanwhile", () => {
    const d = { automaticFailover: true, detectionMs: 5_000, promotionMs: 3_000, replacementMs: 60_000, resyncMs: 10_000 } as Derived
    const cluster = new Cluster(1, 3, new Tally())
    cluster.fail(0, 0, d)
    // Node 0 was the primary; node 1 is promoted at 8 s; node 2 resyncs from 8 s to 18 s.
    expect(cluster.isUp(0, 1_000)).toBe(false)
    expect(cluster.writable(0, 7_999)).toBe(false)
    expect(cluster.writable(0, 8_000)).toBe(true)
    expect(cluster.primaryOf(0, 8_000)).toBe(1)
    expect(cluster.isUp(2, 7_999)).toBe(true)
    expect(cluster.isUp(2, 8_000)).toBe(false)
    expect(cluster.isUp(2, 18_000)).toBe(true)
    // The failed node comes back, as a replica, once replaced.
    expect(cluster.isUp(0, 68_000)).toBe(true)
    expect(cluster.primaryOf(0, 68_000)).toBe(1)
  })

  it("a failed primary takes down writes to its own shard only", () =>
    sim(design({ settings: { clusterMode: true, shards: 3, replicasPerShard: 1, keyspace: { keys: 3_000 } }, writes: 300, db: false }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(10_000)
        yield* s.configureNode("cache", { clusterMode: true, shards: 3, replicasPerShard: 1, keyspace: { keys: 3_000 }, actions: { failShard: 1, failPrimary: 1 } })
        const all = yield* s.advanceTo(20_000)
        expect((yield* stateOf(s)).failovers).toBe(1)
        // A third of the keys live on shard 1.
        expect(rate(all, "writer", "fail.Unavailable", 11_000, 17_500)).toBeCloseTo(100, -1)
        expect(rate(all, "writer", "ok", 11_000, 17_500)).toBeCloseTo(200, -1)
      })))

  it("Memcached has no replicas: a failed node comes back empty", async () => {
    const { during } = await failAt20({ engine: "memcached", failover: { replacement: "20 seconds" } })
    expect(during.items).toBe(0)
  })
})

describe("aws.elasticache: audit", () => {
  const quotas = Schema.decodeUnknownSync(account("us-east-1"))({})
  const decode = (settings: Record<string, unknown>) => Schema.decodeUnknownSync(ElastiCache.config as never)(settings)
  const codes = (settings: Record<string, unknown>, count = 1) =>
    audit("us-east-1", Array.from({ length: count }, (_, i) => ({ id: `c${i}`, name: `Cache ${i}`, type: "aws.elasticache", config: decode(settings) })), quotas).map((d) => d.code)

  it("is quiet for a sensible cluster", () => {
    expect(codes({})).toEqual([])
  })

  it("flags shards without cluster mode, clusters over their node quota and regions over theirs", () => {
    expect(codes({ shards: 4 })).toContain("elasticache-shards-without-cluster-mode")
    expect(codes({ clusterMode: true, shards: 40, replicasPerShard: 2 })).toContain("elasticache-nodes-per-cluster")
    // Four clusters of 90 nodes: 360 in a region that allows 300.
    expect(codes({ clusterMode: true, shards: 45, replicasPerShard: 1 }, 4)).toContain("elasticache-nodes-per-region")
  })

  it("flags a full cache that may evict nothing, and a primary with no replica", () => {
    const full = { keyspace: { keys: 100_000_000, itemSize: 1 } }
    expect(codes({ ...full, caching: { ttl: 0 } })).toContain("elasticache-nothing-to-evict")
    expect(codes({ ...full, memory: { evictionPolicy: "noeviction" } })).toContain("elasticache-nothing-to-evict")
    expect(codes({ ...full, memory: { evictionPolicy: "allkeys-lru" }, caching: { ttl: 0 } })).not.toContain("elasticache-nothing-to-evict")
    expect(codes({ replicasPerShard: 0 })).toContain("elasticache-no-replica")
  })
})

describe("aws.elasticache: determinism", () => {
  it("the same design and seed give the same run", async () => {
    const doc = design({ settings: { clusterMode: true, shards: 3, replicasPerShard: 2, readFrom: "any", keyspace: { keys: 50_000, popularitySkew: 2 } }, load: { arrival: "poisson" }, writes: 50 })
    const a = await run(doc, 15_000)
    const b = await run(doc, 15_000)
    expect(a.state).toEqual(b.state)
  })
})
