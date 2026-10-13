import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { mean, peakGauge } from "../../../testing.ts"
import type { Frame } from "../../../Telemetry.ts"
import { domain, read, sim, type State, writersAndReaders } from "../testing.ts"

/**
 * A data node fails at 10 s and comes back at 30 s. Node 0 holds the primary of shard 0 (and a replica of shard 2 when
 * there are replicas), so writes for shard 0 lose their primary.
 */
const outage = (settings: Record<string, unknown>, loads: Parameters<typeof domain>[1]) =>
  sim(domain(settings, loads), (s) =>
    Effect.gen(function*() {
      const before = yield* s.advanceTo(10_000)
      const at = (yield* s.probe("d")).state as State
      yield* s.configureNode("d", { ...settings, failover: { ...(settings.failover as object), failedNodes: 1 } })
      const during = yield* s.advanceTo(30_000)
      const failed = (yield* s.probe("d")).state as State
      yield* s.configureNode("d", settings)
      const after = yield* s.advanceTo(45_000)
      const back = (yield* s.probe("d")).state as State
      return { frames: [...before, ...during, ...after] as ReadonlyArray<Frame>, at, failed, back }
    }))

describe("aws.opensearch: node failure", () => {
  it("with a replica: writes for the lost primary wait for the promotion, searches use the other copies, nothing is lost", async () => {
    const settings = { dataNodes: 3, primaryShards: 3, replicas: 1, failover: { detection: "5 seconds" } }
    const { frames, at, failed, back } = await outage(settings, writersAndReaders)
    expect(at.status).toBe("green")
    expect(failed.status).toBe("yellow")
    expect(failed.nodes.live).toBe(2)
    expect(failed.shards.promotions).toBe(1)
    expect(failed.perNode[0]!.up).toBe(false)
    // Writes for shard 0 waited for the cluster to notice (5 s), then went to the promoted replica.
    expect(peakGauge(frames, "d", "waitingWrites", 10_000, 15_000)).toBeGreaterThan(300)
    expect(peakGauge(frames, "d", "waitingWrites", 16_000, 30_000)).toBe(0)
    const slowest = frames.filter((f) => f.t > 14_000 && f.t <= 16_000).reduce((m, f) => Math.max(m, f.nodes.writers?.dist.latency?.max ?? 0), 0)
    expect(slowest).toBeGreaterThan(4_500)
    // Searches never noticed: another copy of every shard was up.
    expect(mean(frames, "nodes", "readers", "rates", "fail", 11_000)).toBe(0)
    expect(failed.totals.partialSearches).toBe(0)
    // Only requests the failed node was coordinating at that instant were cut off.
    expect(mean(frames, "nodes", "writers", "rates", "fail", 11_000)).toBe(0)
    expect(back.status).toBe("green")
    expect(back.nodes.live).toBe(3)
  })

  it("without a replica: the shard is red, writes for it fail with 503 after their timeout, searches return partial results", async () => {
    const settings = { dataNodes: 3, primaryShards: 3, replicas: 0, indexing: { timeout: "5 seconds" }, failover: { detection: "5 seconds" } }
    const { frames, failed, back } = await outage(settings, writersAndReaders)
    expect(failed.status).toBe("red")
    expect(failed.shards.promotions).toBe(0)
    // A third of the documents go to shard 0 and wait 5 s for a primary that never comes.
    expect(mean(frames, "nodes", "writers", "rates", "fail.Unavailable", 16_000, 30_000)).toBeCloseTo(100, -1)
    expect(mean(frames, "nodes", "writers", "rates", "ok", 16_000, 30_000)).toBeCloseTo(200, -1)
    // Searches succeed on the two shards left, as partial results.
    expect(mean(frames, "nodes", "readers", "rates", "fail", 11_000, 30_000)).toBe(0)
    expect(mean(frames, "nodes", "d", "rates", "partialSearches", 11_000, 30_000)).toBeCloseTo(50, 0)
    // The node comes back with its shard: everything is whole again.
    expect(back.status).toBe("green")
    expect(mean(frames, "nodes", "writers", "rates", "fail", 37_000)).toBe(0)
    expect(mean(frames, "nodes", "d", "rates", "partialSearches", 31_000)).toBe(0)
  })

  it("without a replica and without partial results, searches fail with 503 while the shard is red", async () => {
    const settings = { dataNodes: 3, primaryShards: 3, replicas: 0, search: { allowPartialResults: false } }
    const { frames } = await outage(settings, writersAndReaders)
    expect(mean(frames, "nodes", "readers", "rates", "fail.Unavailable", 11_000, 30_000)).toBeCloseTo(50, 0)
    expect(mean(frames, "nodes", "readers", "rates", "fail", 31_000)).toBe(0)
  })

  it("cuts off the requests a failing node was coordinating", async () => {
    // Searches that take 2 s each, about eight at a time: the ones node 0 is coordinating when it fails are lost with it.
    const settings = { instanceType: "r6g.4xlarge.search", dataNodes: 3, primaryShards: 3, replicas: 1, search: { cpuPerShard: { mean: 2_000, cv: 0 } } }
    const { frames, failed } = await outage(settings, [{ kind: "client", id: "readers", settings: { rps: 4 }, edge: read }])
    const cut = frames.filter((f) => f.t > 10_000 && f.t <= 10_500).reduce((n, f) => n + (f.nodes.readers?.rates["fail.Unavailable"] ?? 0), 0)
    expect(cut).toBeGreaterThan(0)
    expect(failed.totals.lostTasks).toBeGreaterThan(0) // its shard queries were lost too, and retried on other copies
    expect(mean(frames, "nodes", "readers", "rates", "fail", 13_000)).toBe(0)
  })
})
