import { describe, expect, it } from "vitest"
import * as Builder from "../../Builder.ts"
import { dist, frames, mean } from "../../components/testing.ts"
import { stateAt, write } from "./testkit.ts"

/** A client writing to table `t`, whose stream a consumer `fn` reads (and, optionally, a destination `dlq` for discarded records). */
const design = (o: { table?: Record<string, unknown>; load?: Record<string, unknown>; fn?: Record<string, unknown>; edge?: Record<string, unknown>; dlq?: boolean; extra?: boolean; seed?: number } = {}) => {
  const b = Builder.make("stream", { seed: o.seed ?? 4 })
  const web = b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 200, payload: 1, ...o.load } })
  const t = b.add("aws.dynamodb", { id: "t", settings: { partitions: 1, writeCapacity: 10_000, ...o.table } })
  const fn = b.add("common.http-endpoint", { id: "fn", settings: { latency: { mean: 20, cv: 0 }, ...o.fn } })
  b.connect(web, t, write)
  // A millisecond of network each way, so what the tests measure is the stream and the consumer, not the distance to the internet.
  const link = { latency: { mean: 1, cv: 0 } }
  b.connect(t.port("stream"), fn, { ...link, ...o.edge })
  if (o.extra === true) b.connect(t.port("stream"), b.add("common.http-endpoint", { id: "fn2", settings: { latency: { mean: 20, cv: 0 } } }), { ...link, ...o.edge })
  if (o.dlq === true) b.connect(t.port("discarded"), b.add("common.http-endpoint", { id: "dlq" }))
  return b.build()
}

describe("aws.dynamodb: streams", () => {
  it("delivers every change once to a consumer wired to the stream port, in batches", async () => {
    const s = await stateAt(design(), 20_000)
    expect(s.stream.active).toBe(true)
    expect(s.stream.consumers).toBe(1)
    expect(s.stream.shards).toBe(1) // one partition, one shard
    expect(s.stream.appended).toBeGreaterThan(3_900) // 200 a second for 20 s
    expect(s.stream.delivered).toBeLessThanOrEqual(s.stream.appended)
    expect(s.stream.delivered).toBeGreaterThan(s.stream.appended - 300) // only what is still in flight
    expect(s.stream.blocked).toBe(0)
    expect(s.stream.iteratorAge).toBeLessThan(1_500)
    expect(s.stream.segments).toBeLessThan(6) // delivered records are not kept
  })

  it("produces nothing with no consumer wired, and nothing when the view is off", async () => {
    const b = Builder.make("none", { seed: 1 })
    b.connect(b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 100 } }), b.add("aws.dynamodb", { id: "t" }), write)
    expect((await stateAt(b.build(), 5_000)).stream).toMatchObject({ active: false, appended: 0 })
    const off = await stateAt(design({ table: { stream: { view: "off" } } }), 5_000)
    expect(off.stream).toMatchObject({ active: false, appended: 0 })
  })

  it("makes a record readable after the stream's delay and the consumer's next poll", async () => {
    const all = await frames(design({ load: { rps: 5 } }), 40_000)
    const age = dist(all, "fn", "age", 5_000) // age of the oldest record in the batch when the function gets it
    expect(age.p50).toBeGreaterThan(100) // at least the 100 ms stream delay
    expect(age.p50).toBeLessThan(700) // plus a poll within 250 ms and the network
  })

  it("caps a batch at the batch size", async () => {
    const all = await frames(design({ edge: { batchSize: 5 } }), 20_000)
    const delivered = mean(all, "nodes", "t", "rates", "streamDelivered", 5_000)
    const batches = mean(all, "nodes", "t", "rates", "streamBatches", 5_000)
    expect(delivered / batches).toBeLessThanOrEqual(5)
    expect(delivered).toBeCloseTo(200, -1)
  })

  it("holds a batch for the batching window, then sends what has gathered", async () => {
    const all = await frames(design({ load: { rps: 100 }, edge: { batchSize: 10_000, batchWindow: 2_000 } }), 40_000)
    const batches = mean(all, "nodes", "t", "rates", "streamBatches", 10_000)
    expect(batches).toBeGreaterThan(0.35) // a batch roughly every two seconds
    expect(batches).toBeLessThan(0.55)
    expect(mean(all, "nodes", "t", "rates", "streamDelivered", 10_000)).toBeCloseTo(100, -1)
  })

  it("a full batch doesn't wait for the window to close", async () => {
    const all = await frames(design({ load: { rps: 100 }, edge: { batchSize: 20, batchWindow: 60_000 } }), 20_000)
    expect(mean(all, "nodes", "t", "rates", "streamDelivered", 5_000)).toBeCloseTo(100, -1)
  })

  it("a failing batch blocks its shard: nothing behind it is read until it goes through", async () => {
    const doc = design({ fn: { errorRate: 1 }, edge: { retryBackoff: 100, maxRetryBackoff: 1_000 } })
    const s = await stateAt(doc, 20_000)
    expect(s.stream.delivered).toBe(0)
    expect(s.stream.blocked).toBeGreaterThan(0) // the batch being retried
    expect(s.stream.blocked).toBeLessThanOrEqual(100)
    expect(s.stream.backlog).toBeGreaterThan(3_500) // everything behind it waits
    expect(s.stream.iteratorAge).toBeGreaterThan(18_000)
    const all = await frames(doc, 20_000)
    expect(mean(all, "nodes", "fn", "rates", "in", 5_000)).toBeLessThan(2) // retried on a backoff, not read past
  })

  it("gives up on a batch after the maximum retries, tells the on-failure destination, and moves on", async () => {
    const doc = design({ fn: { errorRate: 1 }, dlq: true, edge: { maxRetries: 2, retryBackoff: 50 } })
    const s = await stateAt(doc, 20_000)
    expect(s.stream.discarded).toBeGreaterThan(3_000)
    expect(s.stream.blocked).toBeLessThanOrEqual(100)
    const all = await frames(doc, 20_000)
    expect(mean(all, "nodes", "dlq", "rates", "in", 2_000)).toBeGreaterThan(0)
  })

  it("discards records older than the maximum record age instead of retrying them forever", async () => {
    const s = await stateAt(design({ fn: { errorRate: 1 }, edge: { maxRecordAge: 2, retryBackoff: 100, maxRetryBackoff: 500 } }), 20_000)
    expect(s.stream.discarded).toBeGreaterThan(2_000)
  })

  it("a bad record blocks the shard until the stream drops it after 24 hours; the memory held stays bounded", async () => {
    const doc = design({ load: { rps: 1 }, fn: { errorRate: 1 } })
    const s = await stateAt(doc, 25 * 60 * 60 * 1000, "t", { frameMs: 600_000 })
    expect(s.stream.expired).toBeGreaterThan(3_000) // records older than a day were trimmed, unread
    expect(s.stream.discarded).toBe(0)
    expect(s.stream.segments).toBeLessThan(90_000) // at most a day of one-second segments
  }, 120_000)

  it("splitting a failing batch retries it in halves, and everything still gets through", async () => {
    // A flaky consumer: 30% of its calls fail. Failing batches are split and retried, and everything gets through.
    const flaky = { load: { rps: 50 }, fn: { errorRate: 0.3 }, edge: { retryBackoff: 10, maxRetryBackoff: 50, batchSize: 8, bisectOnError: true } }
    const split = await stateAt(design(flaky), 30_000)
    expect(split.stream.delivered).toBeGreaterThan(split.stream.appended * 0.9)
    expect(split.stream.discarded).toBe(0)
    const all = await frames(design(flaky), 30_000)
    expect(mean(all, "nodes", "t", "rates", "streamFailedBatches", 5_000)).toBeGreaterThan(0)
  })

  it("concurrent batches per shard raise the throughput of a slow function, still within one shard", async () => {
    const slow = { fn: { latency: { mean: 1_000, cv: 0 } }, load: { rps: 100 } }
    const one = await stateAt(design({ ...slow, edge: { batchSize: 10, parallelization: 1 } }), 30_000)
    const five = await stateAt(design({ ...slow, edge: { batchSize: 10, parallelization: 5 } }), 30_000)
    expect(one.stream.delivered).toBeGreaterThan(240) // a batch of 10 a second
    expect(one.stream.delivered).toBeLessThan(330)
    expect(five.stream.delivered).toBeGreaterThan(1_200) // five batches a second
    expect(five.stream.delivered).toBeLessThan(1_650)
  })

  it("has a shard per partition, and reads each one", async () => {
    const s = await stateAt(design({ table: { partitions: 4 }, load: { rps: 400 } }), 20_000)
    expect(s.stream.shards).toBe(4)
    expect(s.stream.delivered).toBeGreaterThan(s.stream.appended - 600)
  })

  it("gives each consumer every record, with its own position", async () => {
    const s = await stateAt(design({ extra: true }), 20_000)
    expect(s.stream.consumers).toBe(2)
    expect(s.stream.delivered).toBeGreaterThan(2 * (s.stream.appended - 300))
  })

  it("a record weighs what the view says: keys only is small, both images is twice the item", async () => {
    // The consumer refuses requests over 100 KB. 50 records of 10 KB items per batch window: keys-only fits, both images doesn't.
    const rejected = async (view: string) => {
      const doc = design({ load: { rps: 50, payload: 10 }, table: { stream: { view } }, fn: { maxPayload: 100 }, edge: { batchSize: 1_000, batchWindow: 1_000, retryBackoff: 1_000 } })
      return mean(await frames(doc, 10_000), "nodes", "fn", "rates", "fail.Rejected", 3_000)
    }
    expect(await rejected("keys")).toBe(0)
    expect(await rejected("new-and-old")).toBeGreaterThan(0)
  })

  it("a plain edge to a Lambda function works: it is invoked with batches of records", async () => {
    const b = Builder.make("lambda", { seed: 4 })
    const web = b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 100, payload: 1 } })
    const t = b.add("aws.dynamodb", { id: "t", settings: { partitions: 1, writeCapacity: 10_000 } })
    const fn = b.add("aws.lambda", { id: "fn", settings: { duration: { mean: 30, cv: 0 } } })
    b.connect(web, t, write)
    b.connect(t.port("stream"), fn, { batchSize: 50 })
    const all = await frames(b.build(), 20_000)
    expect(mean(all, "nodes", "fn", "rates", "ok", 5_000)).toBeGreaterThan(1)
    expect(mean(all, "nodes", "fn", "rates", "fail", 5_000)).toBe(0)
    expect(mean(all, "nodes", "t", "rates", "streamDelivered", 5_000)).toBeCloseTo(100, -1)
  })
})

describe("aws.dynamodb: time to live", () => {
  const withTtl = (ttl: Record<string, unknown>, table: Record<string, unknown> = {}) => design({ load: { rps: 1 }, table: { ttl, ...table } })

  it("deletes items without write capacity, and puts them in the stream", async () => {
    const s = await stateAt(withTtl({ expiresPerSecond: 50 }), 20_000)
    expect(s.ttl.deleted).toBeGreaterThan(900)
    expect(s.consumed.writes).toBeLessThan(25) // only the client's own 20 writes
    expect(s.stream.appended).toBeGreaterThan(900 + 15)
  })

  it("costs every index a write per deleted item, and slips when an index is out of capacity", async () => {
    const roomy = await stateAt(withTtl({ expiresPerSecond: 50 }, { gsi: { count: 1, writeCapacity: 5_000 } }), 20_000)
    expect(roomy.indexes.consumedWrites).toBeGreaterThan(900)
    expect(roomy.ttl.deferred).toBe(0)
    const tight = await stateAt(withTtl({ expiresPerSecond: 50 }, { burstSeconds: 0, gsi: { count: 1, writeCapacity: 10 } }), 20_000)
    expect(tight.ttl.deferred).toBeGreaterThan(0)
    expect(tight.ttl.deleted).toBeLessThan(500) // about what the index can take
  })

  it("does nothing by default", async () => {
    const s = await stateAt(design({ load: { rps: 1 } }), 5_000)
    expect(s.ttl).toEqual({ deleted: 0, deferred: 0 })
  })
})
