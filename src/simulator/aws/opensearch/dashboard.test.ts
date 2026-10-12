import { describe, expect, it } from "vitest"
import { dist, mean } from "../../components/testing.ts"
import { domain, frames, read } from "./testkit.ts"

/** One r6g.large node (2 vCPUs, 2 write and 4 search threads), one shard, no replica. */
const single = { dataNodes: 1, primaryShards: 1, replicas: 0 }
/** Every document costs exactly 1 ms of CPU, every shard query exactly 10 ms. */
const flat = { indexing: { cpuPerDocument: 1, cpuPerRequest: 0 }, search: { cpuPerShard: { mean: 10, cv: 0 } } }
const rate = (all: Awaited<ReturnType<typeof frames>>, name: string, from: number) => mean(all, "nodes", "d", "rates", name, from)

describe("aws.opensearch: what its dashboard reads", () => {
  it("times a shard's query while it runs, not while it queues: 4 search threads share 2 vCPUs, so 10 ms takes 20", async () => {
    const all = await frames(domain({ ...single, ...flat }, [{ kind: "client", id: "readers", settings: { rps: 300 }, edge: read }]), 10_000)
    expect(dist(all, "d", "searchLatency", 3_000).p50).toBeCloseTo(20, 0)
    // The callers wait far longer: the queue grows by 100 a second.
    expect(dist(all, "readers", "latency", 8_000).p50).toBeGreaterThan(200)
  })

  it("times indexing, and counts a full write queue's rejections in shard tasks", async () => {
    // 2 write threads index 2,000 one-document writes a second; 12,000 arrive, so the 10,000-task queue is full in a second.
    const all = await frames(domain({ ...single, ...flat }, [{ kind: "client", id: "writers", settings: { rps: 12_000 } }]), 6_000)
    expect(dist(all, "d", "indexingLatency", 3_000).p50).toBeCloseTo(1, 0)
    const rejected = rate(all, "writeTasksRejected", 3_000)
    expect(rejected).toBeCloseTo(10_000, -3)
    expect(rejected).toBeCloseTo(rate(all, "fail.Throttled", 3_000), 0)
  })

  it("counts indexing pressure's rejections where they happen: on one node, all on the coordinating node", async () => {
    // As in OpenSearch.test.ts: 48 MiB bulks pile up until a tenth of the heap is in flight, then new ones are refused.
    const all = await frames(domain({ ...single, ...flat }, [{ kind: "bulk", id: "indexer", settings: { rps: 2, docs: 5_000, kb: 10 } }]), 30_000)
    const coordinating = rate(all, "coordinatingWriteRejected", 15_000)
    expect(coordinating).toBeGreaterThan(1)
    expect(coordinating).toBeCloseTo(rate(all, "fail.Throttled", 15_000), 5)
    expect(rate(all, "primaryWriteRejected", 0)).toBe(0)
    expect(rate(all, "writeTasksRejected", 0)).toBe(0)
  })

  it("publishes the status as CloudWatch's three metrics, and counts active shards", async () => {
    const all = await frames(domain({ dataNodes: 2, primaryShards: 3, replicas: 1 }, []), 3_000)
    const last = all[all.length - 1]!.nodes.d!.gauges
    expect([last.statusGreen, last.statusYellow, last.statusRed]).toEqual([1, 0, 0])
    expect(last.activeShards).toBe(6)
  })
})
