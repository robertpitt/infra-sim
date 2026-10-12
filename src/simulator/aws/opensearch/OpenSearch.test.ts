import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { dist, mean } from "../../components/testing.ts"
import { domain, frames, peak, read, run, sim, stateAt, type State } from "./testkit.ts"

/** One r6g.large node (2 vCPUs), one shard, no replica: a single pair of thread pools to measure. */
const single = { dataNodes: 1, primaryShards: 1, replicas: 0 }
/** Every document costs exactly 1 ms of CPU, every shard query exactly 10 ms. */
const flat = { indexing: { cpuPerDocument: 1, cpuPerRequest: 0 }, search: { cpuPerShard: { mean: 10, cv: 0 } } }

describe("aws.opensearch: thread pools", () => {
  it("sizes the pools from the instance's vCPUs: write = vCPUs, search = int(vCPUs × 3 / 2) + 1, queues 10,000 and 1,000", async () => {
    const at = (instanceType: string): Promise<State> => stateAt(domain({ instanceType }, []), 10)
    const large = await at("r6g.large.search")
    expect(large.threads).toEqual({ write: 2, search: 4 })
    expect(large.queues).toEqual({ write: 10_000, search: 1_000 })
    expect((await at("r6g.xlarge.search")).threads).toEqual({ write: 4, search: 7 })
    expect((await at("r6g.4xlarge.search")).threads).toEqual({ write: 16, search: 25 })
  })

  it("gives the JVM half the memory, at most 32 GiB, and indexing pressure a tenth of that", async () => {
    const at = (instanceType: string): Promise<State> => stateAt(domain({ instanceType }, []), 10)
    expect((await at("m6g.large.search")).heapGiB).toBe(4)
    const large = await at("r6g.large.search")
    expect(large.heapGiB).toBe(8)
    expect(large.indexingPressureLimit).toBeCloseTo(0.8 * 1024 ** 3, -3)
    expect((await at("r6g.4xlarge.search")).heapGiB).toBe(32) // 128 GiB of memory, heap capped
  })

  it("queues searches up to 1,000 per node, then rejects them with 429", async () => {
    // 2 vCPUs at 10 ms a shard query serve 200 searches a second; 300 arrive. The queue fills in 10 s, then 100/s are refused.
    const doc = domain({ ...single, ...flat }, [{ kind: "client", id: "readers", settings: { rps: 300 }, edge: read }])
    const { frames: all, state } = await run(doc, 40_000)
    expect(mean(all, "nodes", "readers", "rates", "ok", 20_000)).toBeCloseTo(200, -1)
    expect(mean(all, "nodes", "readers", "rates", "fail.Throttled", 20_000)).toBeCloseTo(100, -1)
    expect(peak(all, "d", "searchQueue")).toBe(1_000)
    expect(state.perNode[0]!.search.rejected).toBeGreaterThan(1_500)
    // Waiting behind a full queue: 1,000 searches at 200 a second is 5 s.
    expect(dist(all, "readers", "latency", 25_000).p50).toBeGreaterThan(4_500)
  })

  it("queues writes up to 10,000 per node, then rejects them with 429", async () => {
    // 2 vCPUs at 1 ms a document index 2,000 a second; 2,500 arrive, so the queue gains 500 a second and is full at 20 s.
    const doc = domain({ ...single, ...flat }, [{ kind: "client", id: "writers", settings: { rps: 2_500 } }])
    const { frames: all, state } = await run(doc, 45_000)
    expect(mean(all, "nodes", "writers", "rates", "fail", 0, 15_000)).toBe(0)
    expect(mean(all, "nodes", "writers", "rates", "ok", 25_000)).toBeCloseTo(2_000, -2)
    expect(mean(all, "nodes", "writers", "rates", "fail.Throttled", 25_000)).toBeCloseTo(500, -2)
    expect(peak(all, "d", "writeQueue")).toBe(10_000)
    expect(state.totals.writeRejected).toBeGreaterThan(8_000)
    expect(state.totals.pressureRejected).toBe(0) // 10,000 queued 1 KB documents are nowhere near 10% of the heap
  })

  it("makes indexing and search share the CPU: a write flood starves searches that ran fine alone", async () => {
    // Alone, 180 searches a second use 90% of the 2 vCPUs. With both write threads busy, the 4 search threads get 4/6 of
    // the CPU: 133 searches a second, so the search queue fills and the rest are rejected.
    const searches = { kind: "client" as const, id: "readers", settings: { rps: 180 }, edge: read }
    const alone = await frames(domain({ ...single, ...flat }, [searches]), 60_000)
    expect(mean(alone, "nodes", "readers", "rates", "fail", 10_000)).toBe(0)
    expect(dist(alone, "readers", "latency", 10_000).p50).toBeLessThan(50)

    const both = await frames(domain({ ...single, ...flat }, [searches, { kind: "client", id: "writers", settings: { rps: 4_000 } }]), 60_000)
    expect(mean(both, "nodes", "readers", "rates", "ok", 35_000)).toBeCloseTo(133, -1)
    expect(mean(both, "nodes", "readers", "rates", "fail.Throttled", 35_000)).toBeGreaterThan(30)
    expect(dist(both, "readers", "latency", 35_000).p50).toBeGreaterThan(5_000)
    expect(mean(both, "nodes", "d", "gauges", "cpu", 10_000)).toBeGreaterThan(0.99)
  })

  it("grows its pools when the instance type grows, live", async () => {
    // Saturated on 2 vCPUs, then moved to 4: the write rate doubles and the queue drains.
    const settings = { ...single, ...flat }
    const doc = domain(settings, [{ kind: "client", id: "writers", settings: { rps: 3_000 } }])
    const all = await sim(doc, (s) =>
      Effect.gen(function*() {
        const before = yield* s.advanceTo(15_000)
        yield* s.configureNode("d", { ...settings, instanceType: "r6g.xlarge.search" })
        const after = yield* s.advanceTo(40_000)
        return [...before, ...after]
      }))
    expect(mean(all, "nodes", "d", "rates", "indexed", 5_000, 15_000)).toBeCloseTo(2_000, -2)
    expect(mean(all, "nodes", "d", "rates", "indexed", 16_000, 25_000)).toBeCloseTo(4_000, -2) // catching up on the queue
    expect(mean(all, "nodes", "d", "gauges", "writeQueue", 35_000)).toBeLessThan(10)
  })
})

describe("aws.opensearch: shards and replicas", () => {
  const two = { dataNodes: 2, primaryShards: 2, ...flat }

  it("writes every document again on each replica, so replicas cost write capacity", async () => {
    // Two nodes, 4 vCPUs: 4,000 documents a second without a replica, 2,000 with one.
    const load = [{ kind: "client" as const, id: "writers", settings: { rps: 3_000 } }]
    const none = await run(domain({ ...two, replicas: 0 }, load), 60_000)
    expect(mean(none.frames, "nodes", "writers", "rates", "fail", 5_000)).toBe(0)
    expect(none.state.totals.replicated).toBe(0)
    const one = await run(domain({ ...two, replicas: 1 }, load), 60_000)
    expect(mean(one.frames, "nodes", "d", "rates", "indexed", 35_000)).toBeCloseTo(2_000, -2)
    expect(mean(one.frames, "nodes", "writers", "rates", "fail.Throttled", 35_000)).toBeCloseTo(1_000, -2)
    expect(mean(one.frames, "nodes", "d", "rates", "replicated", 35_000)).toBeCloseTo(2_000, -2)
  })

  it("spreads a bulk request's documents over every shard and charges a shard request once", async () => {
    // 10 bulks a second of 100 documents, 5 shards with a replica on 3 nodes: 5 shard requests per bulk on each copy.
    const settings = { indexing: { cpuPerDocument: 0.5, cpuPerRequest: 1 } }
    const bulk = await run(domain(settings, [{ kind: "bulk", id: "indexer", settings: { rps: 10, docs: 100 } }]), 30_000)
    expect(mean(bulk.frames, "nodes", "d", "rates", "indexed", 5_000)).toBeCloseTo(1_000, -1)
    expect(mean(bulk.frames, "nodes", "d", "rates", "replicated", 5_000)).toBeCloseTo(1_000, -1)
    expect(mean(bulk.frames, "nodes", "d", "rates", "writeRequests", 5_000)).toBeCloseTo(10, 0)
    // CPU: (1,000 × 0.5 + 50 × 1) × 2 copies = 1,100 ms a second of 6 vCPUs; the same documents one by one cost 3,000.
    expect(mean(bulk.frames, "nodes", "d", "gauges", "cpu", 5_000)).toBeCloseTo(1_100 / 6_000, 1)
    const singles = await frames(domain(settings, [{ kind: "client", id: "writers", settings: { rps: 1_000 } }]), 30_000)
    expect(mean(singles, "nodes", "d", "gauges", "cpu", 5_000)).toBeCloseTo(3_000 / 6_000, 1)
  })

  it("places copies like the balanced allocator: never two copies of a shard on one node", async () => {
    const state = await stateAt(domain({ dataNodes: 3, primaryShards: 5, replicas: 1 }, []), 10)
    expect(state.perNode.map((n) => n.primaries + n.replicas)).toEqual([4, 3, 3])
    expect(state.perNode.reduce((s, n) => s + n.primaries, 0)).toBe(5)
    expect(state.status).toBe("green")
    // Three copies of each shard on two nodes: one copy of each can't be placed and the cluster stays yellow.
    const short = await stateAt(domain({ dataNodes: 2, primaryShards: 2, replicas: 2 }, []), 10)
    expect(short.shards.unassigned).toBe(2)
    expect(short.status).toBe("yellow")
  })

  it("routing by key makes a hot key a hot shard; routing by ID spreads it", async () => {
    // Three nodes of 2,000 documents a second each; 3,000 a second all with the same key.
    const settings = { dataNodes: 3, primaryShards: 3, replicas: 0, ...flat }
    const hot = { kind: "client" as const, id: "writers", settings: { rps: 3_000, hotKeys: 1 } }
    const routed = await run(domain({ ...settings, routing: "key" }, [hot]), 40_000)
    expect(mean(routed.frames, "nodes", "d", "rates", "indexed", 20_000)).toBeCloseTo(2_000, -2)
    expect(mean(routed.frames, "nodes", "writers", "rates", "fail.Throttled", 20_000)).toBeCloseTo(1_000, -2)
    const cpus = routed.state.perNode.map((n) => n.cpu)
    expect(Math.max(...cpus)).toBeGreaterThan(0.99)
    expect(cpus.filter((u) => u < 0.01)).toHaveLength(2) // the other two nodes sit idle
    const byId = await frames(domain(settings, [hot]), 40_000)
    expect(mean(byId, "nodes", "writers", "rates", "fail", 5_000)).toBe(0)
  })

  it("asks one copy of every shard per search, or only the routed shard", async () => {
    const settings = { dataNodes: 3, primaryShards: 6, replicas: 1 }
    const all = await frames(domain(settings, [{ kind: "client", id: "readers", settings: { rps: 50 }, edge: read }]), 20_000)
    expect(mean(all, "nodes", "d", "rates", "searchShards", 5_000)).toBeCloseTo(300, -1)
    const routed = await frames(domain({ ...settings, routing: "key" }, [{ kind: "client", id: "readers", settings: { rps: 50 }, edge: read }]), 20_000)
    expect(mean(routed, "nodes", "d", "rates", "searchShards", 5_000)).toBeCloseTo(50, 0)
  })

  it("spreads searches over the copies of a shard by how busy their nodes are", async () => {
    // One shard on two nodes: each copy should take about half the searches.
    const state = await stateAt(domain({ dataNodes: 2, primaryShards: 1, replicas: 1, ...flat }, [{ kind: "client", id: "readers", settings: { rps: 150 }, edge: read }]), 20_000)
    const busy = state.perNode.map((n) => n.cpu)
    expect(busy[0]).toBeGreaterThan(0.25)
    expect(busy[1]).toBeGreaterThan(0.25)
  })
})

describe("aws.opensearch: requests", () => {
  it("refuses a request larger than the instance type accepts with 413, which is not retried", async () => {
    const big = (instanceType: string) =>
      frames(domain({ instanceType }, [{ kind: "bulk", id: "indexer", settings: { rps: 2, docs: 11, kb: 1_024 }, edge: { retry: { maxAttempts: 3 } } }]), 5_000)
    const small = await big("m6g.large.search") // 10 MiB
    expect(mean(small, "nodes", "d", "rates", "fail.Rejected", 1_000)).toBeCloseTo(2, 0)
    expect(mean(small, "edges", "indexer.out->d", "rates", "retries", 1_000)).toBe(0)
    const large = await big("r6g.large.search") // 100 MiB
    expect(mean(large, "nodes", "d", "rates", "fail", 1_000)).toBe(0)
  })

  it("rejects bulk requests past the indexing pressure limit long before the write queue is full", async () => {
    // 2 bulks a second of 48 MiB each, on one node that indexes 0.4 a second: bulks pile up until 10% of the 8 GiB heap
    // (819 MiB, about 17 bulks) is in flight, then new ones are refused.
    const doc = domain({ ...single, ...flat }, [{ kind: "bulk", id: "indexer", settings: { rps: 2, docs: 5_000, kb: 10 } }])
    const { frames: all, state } = await run(doc, 40_000)
    expect(state.totals.pressureRejected).toBeGreaterThan(0)
    expect(state.totals.writeRejected).toBe(0)
    expect(peak(all, "d", "writeQueue")).toBeLessThan(20)
    expect(peak(all, "d", "indexingPressure")).toBeGreaterThan(0.9)
    expect(peak(all, "d", "indexingPressure")).toBeLessThanOrEqual(1)
  })

  it("makes documents searchable at the next refresh: half the interval on average", async () => {
    const lag = async (refreshInterval: string): Promise<number> =>
      dist(await frames(domain({ refreshInterval }, [{ kind: "client", id: "writers", settings: { rps: 100 } }]), 60_000), "d", "searchableAfter", 5_000).mean
    expect(await lag("1 second")).toBeGreaterThan(450)
    expect(await lag("1 second")).toBeLessThan(560)
    expect(await lag("10 seconds")).toBeGreaterThan(4_500)
  })

  it("with refresh off, nothing new becomes searchable until it is turned back on", async () => {
    const settings = { refreshInterval: 0 }
    const doc = domain(settings, [{ kind: "client", id: "writers", settings: { rps: 100 } }])
    const { all, state } = await sim(doc, (s) =>
      Effect.gen(function*() {
        const off = yield* s.advanceTo(20_000)
        const offState = (yield* s.probe("d")).state as State
        yield* s.configureNode("d", { refreshInterval: "1 second" })
        yield* s.advanceTo(22_000)
        return { all: off, state: { off: offState, on: (yield* s.probe("d")).state as State } }
      }))
    expect(state.off.refresh.unrefreshed).toBeGreaterThan(1_900)
    expect(peak(all, "d", "refreshLag")).toBeGreaterThan(19_000)
    expect(state.on.refresh.unrefreshed).toBeLessThan(150)
  })

  it("answers a write with refresh=wait_for only once it is searchable", async () => {
    const latency = async (waitForRefresh: boolean): Promise<number> =>
      dist(await frames(domain({ indexing: { waitForRefresh } }, [{ kind: "client", id: "writers", settings: { rps: 50 } }]), 30_000), "writers", "latency", 5_000).mean
    // Half a refresh interval more on average, on top of the network and the indexing itself.
    expect((await latency(true)) - (await latency(false))).toBeGreaterThan(450)
  })

  it("plays the same run twice from the same seed", async () => {
    const doc = domain({ ...flat }, [{ kind: "client", id: "writers", settings: { rps: 500, arrival: "poisson" } }, { kind: "client", id: "readers", settings: { rps: 100, arrival: "poisson" }, edge: read }])
    const a = await stateAt(doc, 20_000)
    const b = await stateAt(doc, 20_000)
    expect(a.totals).toEqual(b.totals)
    expect(a.perNode).toEqual(b.perNode)
  })

  it("survives odd inputs: an empty message, every node failed, one node holding three copies' worth", async () => {
    const empty = await frames(domain({}, [{ kind: "bulk", id: "indexer", settings: { rps: 10, docs: 1, kb: 0.001 } }]), 5_000)
    expect(mean(empty, "nodes", "d", "rates", "fail", 1_000)).toBe(0)
    const down = await frames(domain({ failover: { failedNodes: 3 } }, [{ kind: "client", id: "writers", settings: { rps: 10 } }]), 5_000)
    expect(mean(down, "nodes", "writers", "rates", "fail.Unavailable", 1_000)).toBeCloseTo(10, 0)
    const lonely = await run(domain({ dataNodes: 1, replicas: 2 }, [{ kind: "client", id: "writers", settings: { rps: 10 } }]), 5_000)
    expect(mean(lonely.frames, "nodes", "writers", "rates", "fail", 1_000)).toBe(0)
    expect(lonely.state.status).toBe("yellow")
    // Every setting at its maximum: 1,002 nodes, 1,024 shards with 30 replicas each.
    const huge = await run(domain({ dataNodes: 1_002, primaryShards: 1_024, replicas: 30 }, [{ kind: "bulk", id: "indexer", settings: { rps: 5, docs: 2_000 } }, { kind: "client", id: "readers", settings: { rps: 5 }, edge: read }]), 3_000)
    expect(mean(huge.frames, "nodes", "d", "rates", "fail", 1_000)).toBe(0)
    expect(huge.state.shards.active).toBe(1_024 * 31)
    expect(huge.state.status).toBe("green")
  })
})
