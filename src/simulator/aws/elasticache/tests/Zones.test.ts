import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { gauge, rate, sim } from "../../../testing.ts"
import { Cluster, ZoneMap } from "../internal/cluster.ts"
import { Tally } from "../internal/store.ts"
import { design, stateOf } from "../testing.ts"

/**
 * Readers (1,000 a second) and writers (100 a second) on a cache that is its own store, so every failure is the cache's.
 * us-east-1a goes down at 20 s and comes back at 60 s; a node replacement takes 20 s.
 */
const loseZone = (settings: Record<string, unknown>, zone = "us-east-1a", options: { readonly db?: boolean; readonly zoneOf?: string } = {}) =>
  sim(
    design({
      settings: { keyspace: { keys: 100 }, caching: { stampede: "lock" }, failover: { replacement: "20 seconds" }, ...settings },
      writes: 100,
      ...(options.db ? {} : { db: false }),
      ...(options.zoneOf === undefined ? {} : { zone: options.zoneOf })
    }),
    (s) =>
      Effect.gen(function*() {
        const all = [...(yield* s.advanceTo(20_000))]
        const before = yield* stateOf(s)
        yield* s.faults.inject({ kind: "zone", id: `aws:us-east-1:${zone}` }, { _tag: "Outage" }, 40_000)
        all.push(...(yield* s.advanceTo(21_000)))
        const during = yield* stateOf(s)
        all.push(...(yield* s.advanceTo(59_000)))
        const late = yield* stateOf(s)
        all.push(...(yield* s.advanceTo(100_000)))
        return { before, during, late, after: yield* stateOf(s), all }
      })
  )

describe("aws.elasticache: availability zones", () => {
  it("spreads each shard's nodes over different zones, and the shards' primaries over the zones", () => {
    const cluster = new Cluster(3, 2, new Tally(), new ZoneMap(["us-east-1a", "us-east-1b", "us-east-1c"], 0))
    // Shard s, node r: zone (s + r) mod 3.
    expect([0, 1, 2, 3, 4, 5].map((n) => cluster.zoneOf(n))).toEqual([0, 1, 1, 2, 2, 0])
    // Placed from the node's own zone.
    expect(new Cluster(1, 3, new Tally(), new ZoneMap(["a", "b", "c"], 2)).zoneOf(0)).toBe(2)
  })

  it("losing the primary's zone fails the shard over to a replica in another zone (5 s + 3 s); no data is lost", async () => {
    const { before, during, late, after, all } = await loseZone({ replicasPerShard: 1 })
    expect(before.items).toBe(100)
    expect(during.shardsWriteBlocked).toBe(1)
    expect(during.items).toBe(100)
    expect(rate(all, "writer", "fail.Unavailable", 21_000, 27_500)).toBeCloseTo(100, -1)
    expect(rate(all, "app", "fail.Unavailable", 21_000, 27_500)).toBeCloseTo(1_000, -2)
    // Then it serves from the replica, now the primary, while the zone is still down.
    expect(rate(all, "writer", "fail", 28_500)).toBe(0)
    expect(rate(all, "app", "fail", 28_500)).toBe(0)
    expect(late.failovers).toBe(1)
    expect(late.nodesDown).toBe(1)
    // The lost node is replaced once its zone is back (60 s), in 20 s, and rejoins as a replica.
    expect(gauge(all, "cache", "nodesDown", 61_000, 79_000)).toBe(1)
    expect(after.nodesDown).toBe(0)
    expect(after.items).toBe(100)
  })

  it("losing a replica's zone takes it out of reads; reads from replicas fall back to the primary and nothing fails", async () => {
    const { during, all } = await loseZone({ replicasPerShard: 1, readFrom: "replicas" }, "us-east-1b")
    expect(during.nodesDown).toBe(1)
    expect(during.failovers).toBe(0)
    expect(rate(all, "app", "fail", 2_000)).toBe(0)
    expect(rate(all, "writer", "fail", 2_000)).toBe(0)
  })

  it("with no replica, the data in the lost zone is lost, and the shard is down until the zone returns and its node is replaced", async () => {
    const { before, during, after, all } = await loseZone({ replicasPerShard: 0 })
    expect(before.items).toBe(100)
    expect(during.items).toBe(0)
    // Down from 20 s until the zone returns at 60 s and the node is replaced, at 80 s; then it comes back empty and refills.
    expect(rate(all, "writer", "fail.Unavailable", 21_000, 79_000)).toBeCloseTo(100, -1)
    expect(rate(all, "writer", "fail", 81_000)).toBe(0)
    expect(after.items).toBe(100)
  })

  it("in cluster mode only the shards whose primary was in the zone fail over", async () => {
    // Three shards of two nodes over us-east-1's six zones: a and b, b and c, c and d. Losing b loses shard 1's primary
    // and shard 0's replica.
    const { during, all } = await loseZone({ clusterMode: true, shards: 3, replicasPerShard: 1, keyspace: { keys: 3_000 } }, "us-east-1b")
    expect(during.failovers).toBe(1)
    expect(during.nodesDown).toBe(2)
    expect(rate(all, "writer", "fail.Unavailable", 21_000, 27_500)).toBeCloseTo(100 / 3, -1)
    expect(rate(all, "writer", "ok", 21_000, 27_500)).toBeCloseTo(200 / 3, -1)
    expect(rate(all, "writer", "fail", 28_500)).toBe(0)
  })

  it("without automatic failover, writes wait for the zone and a replacement primary; the replica keeps the data", async () => {
    const { during, all } = await loseZone({ replicasPerShard: 1, automaticFailover: false })
    expect(during.items).toBe(100)
    expect(rate(all, "writer", "fail.Unavailable", 21_000, 79_000)).toBeCloseTo(100, -1)
    expect(rate(all, "writer", "fail", 81_000)).toBe(0)
  })

  it("a cache placed in another zone is lost with that one", async () => {
    const { during, all } = await loseZone({ replicasPerShard: 1 }, "us-east-1c", { zoneOf: "us-east-1c" })
    expect(during.failovers).toBe(1)
    expect(rate(all, "writer", "fail.Unavailable", 21_000, 27_500)).toBeCloseTo(100, -1)
  })

  it("Memcached loses the keys of the nodes in the zone; the others keep theirs", async () => {
    const { before, during } = await loseZone({ engine: "memcached", shards: 3, keyspace: { keys: 3_000 } }, "us-east-1a", { db: true })
    // A third of the keys were on the node in us-east-1a.
    expect(during.items / before.items).toBeGreaterThan(0.6)
    expect(during.items / before.items).toBeLessThan(0.73)
  })

  it("a serverless cache doesn't notice a zone outage", async () => {
    const { all } = await loseZone({ deployment: "serverless" })
    expect(rate(all, "app", "fail", 2_000)).toBe(0)
    expect(rate(all, "writer", "fail", 2_000)).toBe(0)
  })
})
