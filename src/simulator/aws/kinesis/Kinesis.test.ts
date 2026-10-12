import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import type { Fast } from "../../Component.ts"
import { mean, sim } from "../../components/testing.ts"
import { Tally } from "../../kit/Tally.ts"
import type { Message } from "../../Message.ts"
import * as SeededRandom from "../../SeededRandom.ts"
import { MiB, SLICES, Stream, type StreamConfig } from "./config.ts"
import { laneCount, type Segment } from "./log.ts"
import { StreamModel, type StreamTallies } from "./stream.ts"
import { peak, run, type StreamState, stream } from "./testkit.ts"

/** A stream model on its own, with a clock the test moves and no timers firing. */
const model = (settings: Record<string, unknown>) => {
  let now = 0
  const config = Schema.decodeUnknownSync(Stream)(settings) as StreamConfig
  const t = Object.fromEntries(
    ["incoming", "incomingBytes", "throttled", "rejected", "getRecords", "outgoing", "outgoingBytes", "readThrottled", "pushed", "expired", "splits", "reshards"].map((k) => [k, new Tally(undefined)])
  ) as unknown as StreamTallies
  const fast = {
    settings: () => config,
    now: () => now,
    random: SeededRandom.make(1),
    after: () => ({ cancel: () => {} }),
    mint: () => ({}) as Message,
    account: () => ({ kinesisOnDemandWriteMBps: 200 })
  } as unknown as Fast<StreamConfig>
  const m = new StreamModel({ id: "s", fast, tallies: t, discard: () => {} })
  return { m, t, advance: (ms: number) => void (now += ms) }
}

const message = (count: number, bytes: number, key = 0.5): Message => ({ id: 1, bornAt: 0, origin: "web", attempt: 1, bytes, count, invocation: "sync", operation: "write", key })

describe("aws.kinesis: writes", () => {
  it("a shard takes 1,000 records a second; past that, writes are throttled", async () => {
    const { frames, stream: s } = await run(stream({ load: { rps: 1_500, payload: 0.1 } }), 20_000)
    expect(mean(frames, "nodes", "s", "rates", "incoming", 5_000)).toBeCloseTo(1_000, -2)
    expect(mean(frames, "nodes", "s", "rates", "throttled", 5_000)).toBeCloseTo(500, -2)
    expect(mean(frames, "nodes", "s", "rates", "fail.Throttled", 5_000)).toBeCloseTo(500, -2)
    expect(s.totals.incoming + s.totals.throttled).toBeGreaterThan(29_000)
  })

  it("a shard takes 1 MiB a second; large records are throttled on bytes long before the record limit", async () => {
    // 200 records a second of 10 KB: 2 MB/s offered, 200 records/s (well under 1,000).
    const { frames } = await run(stream({ load: { rps: 200, payload: 10 } }), 20_000)
    const bytes = mean(frames, "nodes", "s", "rates", "incomingBytes", 5_000)
    expect(bytes).toBeGreaterThan(0.9 * MiB)
    expect(bytes).toBeLessThan(1.05 * MiB)
    expect(mean(frames, "nodes", "s", "rates", "throttled", 5_000)).toBeGreaterThan(90)
  })

  it("more shards take more: the limits are per shard", async () => {
    const { frames } = await run(stream({ stream: { shards: 2 }, load: { rps: 1_500, payload: 0.1 } }), 20_000)
    expect(mean(frames, "nodes", "s", "rates", "incoming", 5_000)).toBeCloseTo(1_500, -2)
    expect(mean(frames, "nodes", "s", "rates", "throttled", 5_000)).toBe(0)
  })

  it("the partition key picks the shard: a hot key throttles its shard while the others idle", async () => {
    // Four shards, 2,000 writes a second, half of them with one partition key: its shard gets 1,250 a second.
    // The probe's per-shard rates are averaged over about a minute, so run long enough for them to settle.
    const hot = await run(stream({ stream: { shards: 4 }, load: { rps: 2_000, payload: 0.1, hotKeys: 0.5 } }), 180_000)
    expect(mean(hot.frames, "nodes", "s", "rates", "throttled", 5_000)).toBeCloseTo(250, -1)
    expect(hot.stream.hottest[0]!.shard).toBe("shardId-000000000000") // the key 0.1234 is in the first quarter
    expect(hot.stream.hottest[0]!.recordsPerSecond).toBeGreaterThan(1_150) // offered, throttled or not
    expect(hot.stream.hottest[3]!.recordsPerSecond).toBeLessThan(270)
    // The same traffic with keys spread evenly: 500 a shard, nothing throttled.
    const even = await run(stream({ stream: { shards: 4 }, load: { rps: 2_000, payload: 0.1 } }), 20_000)
    expect(mean(even.frames, "nodes", "s", "rates", "throttled", 5_000)).toBe(0)
  })

  it("PutRecords: up to 500 records and 10 MiB, spread over the shards by key, failing record by record", () => {
    const { m, t } = model({ shards: 4 })
    expect(m.put(message(501, 501))).toMatchObject({ _tag: "Rejected" })
    expect(m.put(message(10, 11 * MiB))).toMatchObject({ _tag: "Rejected" })
    expect(m.put(message(1, 2 * MiB))).toMatchObject({ _tag: "Rejected" }) // over the 1 MiB default record size
    expect(m.put(message(500, 500 * 100))).toBeUndefined()
    expect(t.incoming.total).toBe(500)
    for (const shard of m.openShards()) expect(shard.offeredRecords).toBe(125) // a quarter each
    // Four shards take 4,000 records in a second: seven more batches fit, the ninth fits nowhere.
    for (let i = 0; i < 7; i++) expect(m.put(message(500, 500 * 100))).toBeUndefined()
    expect(m.put(message(500, 500 * 100))).toMatchObject({ _tag: "Throttled" })
    expect(t.throttled.total).toBe(500)
  })

  it("PutRecords is not atomic: a busy shard fails its records and the rest are stored", () => {
    const { m, t } = model({ shards: 2 })
    // Fill the first shard (keys below 0.5) with single writes.
    for (let i = 0; i < 1_000; i++) m.put(message(1, 100, 0.1))
    const reply = m.put(message(100, 100 * 100))
    expect(reply).toMatchObject({ _tag: "ItemFailures" })
    const failed = (reply as { failed: ReadonlyArray<number> }).failed
    expect(failed.length).toBeGreaterThan(40)
    expect(failed.length).toBeLessThan(60)
    expect(t.incoming.total).toBe(1_000 + 100 - failed.length)
  })

  it("a record up to the stream's maximum record size is taken, drawing on the shard's burst", () => {
    const { m, advance } = model({ shards: 1, maxRecordSize: 10_240 })
    expect(m.put(message(1, 10 * MiB))).toBeUndefined()
    // The burst is spent: writes are throttled until the shard has refilled, at 1 MiB a second.
    expect(m.put(message(1, 600 * 1024))).toMatchObject({ _tag: "Throttled" })
    advance(1_000)
    expect(m.put(message(1, 600 * 1024))).toBeUndefined()
    expect(m.put(message(1, 600 * 1024))).toMatchObject({ _tag: "Throttled" })
  })
})

describe("aws.kinesis: lanes", () => {
  const segment = (slices: ReadonlyArray<number>): Segment => {
    const s = new Int32Array(SLICES)
    slices.forEach((n, i) => (s[i] = n))
    return { at: 0, last: 0, readyAt: 0, count: slices.reduce((a, b) => a + b, 0), bytes: 1, born: 0, bornLast: 0, slices: s }
  }

  it("lanes split a segment's records by key and always add up to its count", () => {
    const seg = segment([7, 3, 9, 1, 0, 4, 6, 2, 8, 5])
    for (let lanes = 1; lanes <= 10; lanes++) {
      let sum = 0
      for (let lane = 0; lane < lanes; lane++) {
        const n = laneCount(seg, lane, lanes)
        expect(n).toBeGreaterThanOrEqual(0)
        sum += n
      }
      expect(sum).toBe(seg.count)
    }
  })

  it("a hot key's records stay in one lane", () => {
    const seg = segment([0, 0, 0, 120, 0, 0, 0, 0, 0, 0])
    expect(laneCount(seg, 0, 2)).toBe(120)
    expect(laneCount(seg, 1, 2)).toBe(0)
    expect(laneCount(seg, 1, 5)).toBe(120)
  })
})

describe("aws.kinesis: capacity", () => {
  it("on-demand starts at four shards and splits shards over 500 KB/s, so capacity follows the peak", async () => {
    // About 3 MB/s: 750 KB/s a shard, under the limit but over the split threshold.
    const doc = stream({ stream: { mode: "on-demand", splitDelay: "1 minute" }, load: { rps: 3_000, payload: 1 } })
    const { frames, stream: s } = await run(doc, 240_000)
    expect(peak(frames, "nodes", "s", "shards", 0, 30_000)).toBe(4)
    expect(s.shards).toBe(8)
    expect(s.closedShards).toBe(0) // the parents were trimmed once everyone was past them (nobody reads)
    expect(s.totals.splits).toBe(4)
    expect(s.totals.throttled).toBe(0)
  })

  it("on-demand throttles traffic that more than doubles faster than it splits", async () => {
    // About 6 MB/s at once onto 4 MB/s of capacity: throttled until the split comes, then not.
    const doc = stream({ stream: { mode: "on-demand", splitDelay: "2 minutes" }, load: { rps: 6_000, payload: 1 } })
    const { frames } = await run(doc, 300_000)
    expect(mean(frames, "nodes", "s", "rates", "throttled", 10_000, 100_000)).toBeGreaterThan(1_000)
    expect(mean(frames, "nodes", "s", "rates", "throttled", 240_000)).toBe(0)
    expect(peak(frames, "nodes", "s", "shards", 240_000)).toBe(8)
  })

  it("on-demand can't spread one hot key: its shard splits, and the key is still held to one shard's limit", async () => {
    const doc = stream({ stream: { mode: "on-demand", splitDelay: "1 minute" }, load: { rps: 1_500, payload: 0.5, hotKeys: 1 } })
    const { frames } = await run(doc, 300_000)
    expect(peak(frames, "nodes", "s", "shards")).toBeGreaterThan(4)
    expect(mean(frames, "nodes", "s", "rates", "incoming", 200_000)).toBeLessThanOrEqual(1_010)
    expect(mean(frames, "nodes", "s", "rates", "throttled", 200_000)).toBeGreaterThan(450)
  })

  it("provisioned resharding (UpdateShardCount) doubles at most per step, a few minutes a step", async () => {
    const doc = stream({ stream: { shards: 2 }, load: { rps: 500, payload: 1 }, consumers: [{ id: "fn" }] })
    const result = await sim(doc, (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(10_000)
        yield* s.configureNode("s", { shards: 8 })
        const frames = yield* s.advanceTo(400_000)
        const probe = (yield* s.probe("s")).state as StreamState
        const edge = (yield* s.probeEdge("s.consumers->fn")).state as { totals: { records: number }; backlog: number }
        return { frames, probe, edge }
      }))
    expect(peak(result.frames, "nodes", "s", "shards", 0, 125_000)).toBe(2)
    expect(peak(result.frames, "nodes", "s", "shards", 135_000, 245_000)).toBe(4)
    expect(peak(result.frames, "nodes", "s", "shards", 260_000)).toBe(8)
    expect(result.probe.updatesToday).toBe(2)
    expect(result.probe.totals.reshards).toBe(2)
    // The consumer read every closed parent to its end before its children: nothing lost on the way.
    expect(result.edge.totals.records).toBeGreaterThan(result.probe.totals.incoming - 1_000)
  })
})

describe("aws.kinesis: reads", () => {
  it("standard consumers share a shard's 2 MiB a second: a third full-rate reader is throttled and falls behind", async () => {
    // About 1 MB/s written to one shard, read by three consumers: 3 MB/s wanted, 2 MiB/s served.
    const three = [{ id: "a" }, { id: "b" }, { id: "c" }]
    const shared = await run(stream({ load: { rps: 900, payload: 1 }, consumers: three }), 120_000, ["a", "b", "c"])
    expect(shared.stream.totals.readThrottled).toBeGreaterThan(10)
    // A call may overdraw the allowance (one call can return 10 MiB), so over a long window it averages 2 MiB/s.
    expect(mean(shared.frames, "nodes", "s", "rates", "outgoingBytes", 20_000)).toBeLessThan(2.15 * MiB)
    expect(Math.max(shared.edges.a!.iteratorAge, shared.edges.b!.iteratorAge, shared.edges.c!.iteratorAge)).toBeGreaterThan(5_000)
    // With enhanced fan-out each gets its own 2 MiB a second.
    const efo = three.map((c) => ({ ...c, edge: { enhancedFanOut: true } }))
    const fanned = await run(stream({ load: { rps: 900, payload: 1 }, consumers: efo }), 60_000, ["a", "b", "c"])
    expect(fanned.stream.totals.readThrottled).toBe(0)
    for (const id of ["a", "b", "c"]) expect(fanned.edges[id]!.iteratorAge).toBeLessThan(1_000)
  })

  it("five GetRecords calls a second per shard, shared: six idle pollers are more than a shard serves", async () => {
    const six = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id }))
    const { stream: s } = await run(stream({ load: { rps: 10, payload: 1 }, consumers: six }), 30_000)
    expect(s.totals.readThrottled).toBeGreaterThan(20)
    const five = await run(stream({ load: { rps: 10, payload: 1 }, consumers: six.slice(0, 5) }), 30_000)
    expect(five.stream.totals.readThrottled).toBeLessThan(s.totals.readThrottled / 4)
  })

  it("a stream registers at most 20 enhanced fan-out consumers", async () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ id: `c${i}`, edge: { enhancedFanOut: true } }))
    const { stream: s } = await run(stream({ load: { rps: 10 }, consumers: many }), 5_000)
    expect(s.consumers.filter((c) => c.efo).length).toBe(20)
    expect(s.consumers.filter((c) => c.refused).length).toBe(1)
  })

  it("nobody reading: nothing is kept", async () => {
    const { stream: s } = await run(stream({ load: { rps: 500 } }), 10_000)
    expect(s.retained).toBeLessThan(200) // only the segments not yet sealed
    expect(s.totals.incoming).toBeGreaterThan(4_900)
  })
})

describe("aws.kinesis: hardening", () => {
  it("odd messages: no records stores nothing, negative bytes count as none, a key that isn't a number lands on the first shard", () => {
    const { m, t } = model({ shards: 2 })
    expect(m.put(message(0, 100))).toBeUndefined()
    expect(m.put({ ...message(1, -5), key: Number.NaN })).toBeUndefined()
    expect(t.incoming.total).toBe(1)
    expect(t.incomingBytes.total).toBe(0)
    expect(m.openShards()[0]!.offeredRecords).toBe(1)
    expect(m.put({ ...message(1, 10), key: 1.5 })).toBeUndefined() // out of range: the last shard
    expect(m.openShards()[1]!.offeredRecords).toBe(1)
  })

  it("the same design and seed give the same result", async () => {
    const doc = stream({ stream: { shards: 3 }, load: { rps: 800, hotKeys: 0.2 }, consumers: [{ id: "a", edge: { parallelization: 3, poisonRecords: 0.001, bisectOnError: true } }] })
    const one = await run(doc, 20_000, ["a"])
    const two = await run(doc, 20_000, ["a"])
    expect(two.stream).toEqual(one.stream)
    expect(two.edges).toEqual(one.edges)
  })

  it("a parallelization factor changed while running applies once the shard's lanes are idle", async () => {
    const doc = stream({ load: { rps: 300 }, consumers: [{ id: "fn", edge: { batchSize: 100 }, fn: { latency: { mean: 1_000, cv: 0 } } }] })
    const frames = await sim(doc, (s) =>
      Effect.gen(function*() {
        const before = yield* s.advanceTo(30_000)
        yield* s.configureEdge("s.consumers->fn", { parallelization: 4 })
        const after = yield* s.advanceTo(60_000)
        return { before, after }
      }))
    expect(peak(frames.before, "edges", "s.consumers->fn", "concurrency")).toBe(1)
    expect(peak(frames.after, "edges", "s.consumers->fn", "concurrency")).toBe(4)
  })

  it("a mapping that is behind still takes a new factor: its lanes finish what they hold, then the shard is re-cut", async () => {
    // Two lanes, each always busy (never both idle at once), far behind: raising the factor must still apply.
    const doc = stream({ load: { rps: 600 }, consumers: [{ id: "fn", edge: { batchSize: 100, parallelization: 2 }, fn: { latency: { mean: 1_000, cv: 0.3 } } }] })
    const frames = await sim(doc, (s) =>
      Effect.gen(function*() {
        const before = yield* s.advanceTo(30_000)
        yield* s.configureEdge("s.consumers->fn", { batchSize: 100, parallelization: 6 })
        const after = yield* s.advanceTo(60_000)
        return { before, after }
      }))
    expect(peak(frames.before, "edges", "s.consumers->fn", "concurrency")).toBe(2)
    expect(peak(frames.after, "edges", "s.consumers->fn", "concurrency")).toBe(6)
  })
})
