import { describe, expect, it } from "vitest"
import { dist, gauge, rate } from "../../../../testing.ts"
import { design, run } from "../../testing.ts"

/** 10 KB values, 20 keys (every read a hit once they are filled), writes rewriting the key: one shard, one replica. */
const settings = { keyspace: { keys: 20, itemSize: 10 }, caching: { stampede: "lock", writes: "write-through" } }
const VALUE = 10 * 1024
/** cache.r7g.large's baseline network: 0.937 Gbps (CacheNodes.SupportedTypes.html), in bytes a second. */
const NETWORK = 0.937e9 / 8

describe("aws.elasticache: what its dashboard reads", () => {
  it("counts the bytes CloudWatch does: values read out, written in, and sent to the replica", async () => {
    const { all } = await run(design({ settings, writes: 50 }), 15_000)
    // 1,000 GETs a second, all hits, each returning a 10 KB value.
    expect(rate(all, "cache", "networkBytesOut", 5_000)).toBeCloseTo(1_000 * VALUE, -4)
    // 50 writes a second, each a SET of its value (write-through), which the primary sends to its one replica.
    expect(rate(all, "cache", "setTypeCmds", 5_000)).toBeCloseTo(50, -1)
    expect(rate(all, "cache", "networkBytesIn", 5_000)).toBeCloseTo(50 * VALUE, -4)
    expect(rate(all, "cache", "replicationBytes", 5_000)).toBeCloseTo(50 * VALUE, -4)
  })

  it("splits the busiest node's engine from its network: 10.75 MB a second sent is 9% of r7g.large's baseline", async () => {
    const { all } = await run(design({ settings, writes: 50 }), 15_000)
    const network = gauge(all, "cache", "networkUtilization", 5_000)
    // The primary sends the hits' values and the replica's copies: 1,050 values a second.
    expect(network).toBeCloseTo((1_050 * VALUE) / NETWORK, 2)
    expect(gauge(all, "cache", "engineCpu", 5_000)).toBeLessThan(network)
    expect(gauge(all, "cache", "engineUtilization", 5_000)).toBeCloseTo(network, 3)
  })

  it("times the cache's own commands, the database's time apart, and how far the replica lags", async () => {
    const { all } = await run(design({ settings, writes: 50 }), 15_000)
    // The database (20 ms) answers misses and writes; a GET or SET on an idle node takes a fraction of a millisecond.
    expect(dist(all, "cache", "readLatency", 5_000).p99).toBeLessThan(1)
    expect(dist(all, "cache", "writeLatency", 5_000).p99).toBeLessThan(1)
    expect(dist(all, "cache", "latency", 5_000).p99).toBeGreaterThan(20)
    const lag = dist(all, "cache", "replicationLag", 5_000)
    expect(lag.windows).toBeGreaterThan(0)
    expect(lag.p99).toBeLessThan(1)
  })
})
