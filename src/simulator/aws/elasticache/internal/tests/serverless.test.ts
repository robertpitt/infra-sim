import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { gauge, rate, sim } from "../../../../testing.ts"
import { design, run, stateOf } from "../../testing.ts"

const SERVERLESS = { deployment: "serverless", caching: { stampede: "lock" } }
/** Throttled reads fail rather than going to the database, so the client sees them. */
const STRICT = { ...SERVERLESS, caching: { stampede: "lock", failOpen: false } }

describe("aws.elasticache serverless: ECPUs", () => {
  it("a simple GET costs 1 ECPU per KB it returns, and at least 1", async () => {
    const at = (itemSize: number) => run(design({ settings: { ...SERVERLESS, keyspace: { keys: 1, itemSize } } }), 10_000)
    const big = await at(3.2)
    expect(rate(big.all, "cache", "ecpu", 2_000)).toBeCloseTo(3_200, -1)
    const small = await at(0.5)
    expect(rate(small.all, "cache", "ecpu", 2_000)).toBeCloseTo(1_000, -1)
  })

  it("starts at 30,000 ECPU/s, throttles beyond it, and doubles after 2.5 minutes of pressure", () =>
    sim(design({ settings: { ...STRICT, keyspace: { keys: 1_000, itemSize: 10 } }, load: { rps: 5_000 } }), (s) =>
      Effect.gen(function*() {
        // 50,000 ECPU/s asked of a cache that serves 30,000: 2,000 of the 5,000 reads a second are throttled.
        const early = yield* s.advanceTo(140_000)
        expect((yield* stateOf(s)).ecpuCeiling).toBe(30_000)
        expect(rate(early, "app", "fail.Throttled", 5_000)).toBeCloseTo(2_000, -2)
        const late = yield* s.advanceTo(200_000)
        expect((yield* stateOf(s)).ecpuCeiling).toBe(60_000)
        expect(rate(late, "app", "fail", 152_000)).toBe(0)
      })))

  it("never scales past the configured maximum, and starts from the pre-scaled minimum", async () => {
    const capped = await run(design({ settings: { ...STRICT, keyspace: { keys: 1_000, itemSize: 10 }, serverless: { maxEcpuPerSecond: 40_000, scaleInterval: "10 seconds" } }, load: { rps: 5_000 } }), 60_000)
    expect(capped.state.ecpuCeiling).toBe(40_000)
    expect(rate(capped.all, "app", "fail.Throttled", 30_000)).toBeCloseTo(1_000, -2)
    const warm = await run(design({ settings: { ...STRICT, keyspace: { keys: 1_000, itemSize: 10 }, serverless: { minEcpuPerSecond: 100_000 } }, load: { rps: 5_000 } }), 20_000)
    expect(warm.state.throttled).toBe(0)
  })

  it("one slot serves 30,000 ECPU/s however large the cache, 90,000 when reads go to replicas", async () => {
    const hot = (readFrom: string) =>
      run(design({ settings: { ...STRICT, readFrom, keyspace: { itemSize: 10 }, serverless: { minEcpuPerSecond: 1_000_000 } }, load: { rps: 4_000, hotKeys: 1 } }), 20_000)
    const primary = await hot("primary")
    expect(rate(primary.all, "app", "fail.Throttled", 5_000)).toBeCloseTo(1_000, -2)
    const replicas = await hot("replicas")
    expect(replicas.state.throttled).toBe(0)
  })

  it("at the storage maximum it evicts keys with a TTL", async () => {
    // 1 GB holds ten 100 MB values.
    const { state } = await run(design({ settings: { ...SERVERLESS, keyspace: { keys: 100, itemSize: 100 * 1024 }, serverless: { maxStorageGb: 1 } }, load: { rps: 2 } }), 120_000)
    expect(state.capacityPerShard).toBe(10)
    expect(state.items).toBeLessThanOrEqual(10)
    expect(state.evictions).toBeGreaterThan(0)
  })

  it("has no nodes to fail: pressing Fail primary changes nothing", () =>
    sim(design({ settings: { ...SERVERLESS, keyspace: { keys: 10 } }, writes: 10, db: false }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(5_000)
        yield* s.configureNode("cache", { ...SERVERLESS, keyspace: { keys: 10 }, actions: { failPrimary: 1 } })
        const all = yield* s.advanceTo(15_000)
        expect((yield* stateOf(s)).failovers).toBe(0)
        expect(rate(all, "writer", "fail", 5_000)).toBe(0)
        expect(gauge(all, "cache", "shardsWriteBlocked", 5_000)).toBe(0)
      })))
})
