import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../../Builder.ts"
import { dist, mean, sim } from "../../components/testing.ts"
import { type MappingState, near, peak, run, type StreamState, stream } from "./testkit.ts"

const fn = (edge: Record<string, unknown> = {}, f: Record<string, unknown> = {}) => [{ id: "fn", edge, fn: f }]

describe("aws.kinesis.event-source-mapping: reading", () => {
  it("delivers every record once, in batches of at most the batch size, one batch per shard at a time", async () => {
    const doc = stream({ stream: { shards: 2 }, load: { rps: 400 }, consumers: fn({ batchSize: 50 }) })
    const { frames, edges } = await run(doc, 30_000, ["fn"])
    const m = edges.fn!
    expect(m.shards).toBe(2)
    expect(m.totals.records).toBeGreaterThan(11_400) // 400 a second for 30 s, less what is in flight
    expect(m.totals.records).toBeLessThanOrEqual(12_000)
    expect(m.totals.records / m.totals.batches).toBeLessThanOrEqual(50)
    expect(peak(frames, "edges", "s.consumers->fn", "concurrency")).toBeLessThanOrEqual(2)
    expect(m.totals.discarded).toBe(0)
    expect(m.iteratorAge).toBeLessThan(1_500) // polled about once a second
  })

  it("a slow function falls behind: IteratorAge grows while the shard is processed one batch at a time", async () => {
    // One shard, 300 records a second, 100 a batch, 1 s a batch: 100 a second processed.
    const doc = stream({ load: { rps: 300 }, consumers: fn({ batchSize: 100 }, { latency: { mean: 1_000, cv: 0 } }) })
    const { frames, edges } = await run(doc, 60_000, ["fn"])
    const age = (t: number) => frames.find((f) => f.t >= t)!.edges["s.consumers->fn"]!.gauges.iteratorAge!
    expect(age(30_000)).toBeGreaterThan(15_000)
    expect(age(60_000)).toBeGreaterThan(age(30_000) + 15_000)
    expect(mean(frames, "edges", "s.consumers->fn", "rates", "records", 10_000)).toBeCloseTo(100, -1)
    expect(edges.fn!.backlog).toBeGreaterThan(10_000)
  })

  it("a parallelization factor processes several batches of a shard at once", async () => {
    const slow = { latency: { mean: 1_000, cv: 0 } }
    const one = await run(stream({ load: { rps: 300 }, consumers: fn({ batchSize: 100 }, slow) }), 60_000, ["fn"])
    const five = await run(stream({ load: { rps: 300 }, consumers: fn({ batchSize: 100, parallelization: 5 }, slow) }), 60_000, ["fn"])
    expect(mean(five.frames, "edges", "s.consumers->fn", "rates", "records", 20_000)).toBeCloseTo(300, -1)
    expect(peak(five.frames, "edges", "s.consumers->fn", "concurrency")).toBeGreaterThanOrEqual(3)
    expect(five.edges.fn!.iteratorAge).toBeLessThan(5_000)
    expect(one.edges.fn!.iteratorAge).toBeGreaterThan(20_000)
  })

  it("...but records of one partition key stay in order in one lane: a hot key gains nothing", async () => {
    const slow = { latency: { mean: 1_000, cv: 0 } }
    const doc = stream({ load: { rps: 300, hotKeys: 1 }, consumers: fn({ batchSize: 100, parallelization: 5 }, slow) })
    const { frames } = await run(doc, 60_000, ["fn"])
    expect(peak(frames, "edges", "s.consumers->fn", "concurrency")).toBe(1)
    expect(mean(frames, "edges", "s.consumers->fn", "rates", "records", 20_000)).toBeCloseTo(100, -1)
  })

  it("holds a batch for the batching window, then sends what has gathered", async () => {
    const doc = stream({ load: { rps: 100 }, consumers: fn({ batchSize: 10_000, batchWindow: "5 seconds" }) })
    const { frames } = await run(doc, 60_000, ["fn"])
    const batches = mean(frames, "edges", "s.consumers->fn", "rates", "batches", 10_000)
    expect(batches).toBeGreaterThan(0.15)
    expect(batches).toBeLessThan(0.25)
    expect(mean(frames, "edges", "s.consumers->fn", "rates", "records", 10_000)).toBeCloseTo(100, -1)
  })

  it("enhanced fan-out pushes records: they reach the function sooner than polling does", async () => {
    const polled = await run(stream({ load: { rps: 20 }, consumers: fn({ batchSize: 1 }) }), 30_000)
    const pushed = await run(stream({ load: { rps: 20 }, consumers: fn({ batchSize: 1, enhancedFanOut: true }) }), 30_000)
    const p = dist(polled.frames, "fn", "age", 5_000)
    const e = dist(pushed.frames, "fn", "age", 5_000)
    expect(p.p50).toBeGreaterThan(400) // half a second's poll on average
    expect(e.p50).toBeLessThan(200) // the segment's propagation delay
    expect(pushed.stream.totals.getRecords).toBe(0)
  })
})

describe("aws.kinesis.event-source-mapping: failures", () => {
  it("a failing batch blocks its shard: nothing behind it is processed while it is retried", async () => {
    const doc = stream({ load: { rps: 100 }, consumers: fn({ retryBackoff: 500, maxRetryBackoff: 2_000 }, { errorRate: 1 }) })
    const { frames, edges } = await run(doc, 60_000, ["fn"])
    const m = edges.fn!
    expect(m.totals.records).toBe(0)
    expect(m.blocked).toBeGreaterThan(0)
    expect(m.blocked).toBeLessThanOrEqual(100)
    expect(m.iteratorAge).toBeGreaterThan(55_000)
    expect(m.backlog).toBeGreaterThan(5_500)
    expect(mean(frames, "nodes", "fn", "rates", "in", 20_000)).toBeLessThan(1) // retried on a backoff, never read past
  })

  it("maximum retry attempts: the batch is discarded to the on-failure destination and the shard moves on", async () => {
    const doc = stream({ load: { rps: 100 }, dlq: true, consumers: fn({ maxRetries: 2, retryBackoff: 200, maxRetryBackoff: 200 }, { errorRate: 1 }) })
    const { frames, edges, stream: s } = await run(doc, 60_000, ["fn"])
    expect(edges.fn!.totals.discarded).toBeGreaterThan(5_000)
    expect(edges.fn!.iteratorAge).toBeLessThan(5_000)
    expect(mean(frames, "nodes", "dlq", "rates", "in", 10_000)).toBeGreaterThan(0.5) // one record of metadata per batch
    expect(s.totals.onFailureSent).toBeGreaterThan(50)
  })

  it("maximum record age: a batch older than it is discarded instead of retried", async () => {
    const doc = stream({ load: { rps: 50 }, dlq: true, consumers: fn({ maxRecordAge: 60, retryBackoff: 1_000, maxRetryBackoff: 1_000 }, { errorRate: 1 }) })
    const { edges } = await run(doc, 150_000, ["fn"])
    expect(edges.fn!.totals.discarded).toBeGreaterThan(0)
    expect(edges.fn!.iteratorAge).toBeLessThan(65_000)
    expect(edges.fn!.totals.retries).toBeGreaterThan(50)
  })

  it("a throttled invocation is retried without using up retries", async () => {
    // A function that takes two calls a second, fed a batch every poll by two shards and a factor of 5.
    const doc = stream({ stream: { shards: 2 }, load: { rps: 300 }, consumers: fn({ batchSize: 10, parallelization: 5, maxRetries: 0, retryBackoff: 100 }, { rateLimit: 2, burst: 2 }) })
    const { frames, edges } = await run(doc, 30_000, ["fn"])
    expect(mean(frames, "edges", "s.consumers->fn", "rates", "throttledInvokes", 5_000)).toBeGreaterThan(1)
    expect(edges.fn!.totals.discarded).toBe(0)
  })

  it("a poison record: without bisecting, whole batches are lost; bisecting isolates the record", async () => {
    const edge = { batchSize: 100, maxRetries: 1, retryBackoff: 100, maxRetryBackoff: 100, poisonRecords: 0.001 }
    const whole = await run(stream({ load: { rps: 200 }, dlq: true, consumers: fn(edge) }), 120_000, ["fn"])
    const split = await run(stream({ load: { rps: 200 }, dlq: true, consumers: fn({ ...edge, bisectOnError: true }) }), 120_000, ["fn"])
    // About 24 poison records in 24,000.
    const lostWhole = whole.edges.fn!.totals.discarded
    const lostSplit = split.edges.fn!.totals.discarded
    expect(lostWhole).toBeGreaterThan(800) // a batch of about 100 for each
    expect(lostSplit).toBeGreaterThan(10)
    expect(lostSplit).toBeLessThan(50) // the poison records alone
    expect(split.edges.fn!.totals.bisected).toBeGreaterThan(100)
    expect(split.edges.fn!.totals.records + lostSplit).toBeGreaterThan(23_500)
  })

  it("ReportBatchItemFailures checkpoints before the first failed record and retries from there", async () => {
    const edge = { batchSize: 100, maxRetries: 1, retryBackoff: 100, maxRetryBackoff: 100, poisonRecords: 0.001, reportBatchItemFailures: true }
    const { edges } = await run(stream({ load: { rps: 200 }, dlq: true, consumers: fn(edge) }), 120_000, ["fn"])
    const m = edges.fn!
    expect(m.totals.itemFailures).toBeGreaterThan(0)
    // Only what follows the poison record in its batch is retried and, at the end, discarded: about half a batch each.
    expect(m.totals.discarded).toBeGreaterThan(200)
    expect(m.totals.discarded).toBeLessThan(2_000)
  })

  it("a Lambda function's reported failures are acted on only with ReportBatchItemFailures", async () => {
    const lambda = (report: boolean) => {
      const b = Builder.make("k", { seed: 2 })
      const web = b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 100 } })
      const s = b.add("aws.kinesis", { id: "s" })
      const f = b.add("aws.lambda", { id: "f", settings: { memory: 1024, duration: { mean: 10 }, errorRate: 0.01, batch: { errors: "report" } } })
      b.connect(web, s, near)
      b.connect(s.port("consumers"), f, { ...near, batchSize: 100, reportBatchItemFailures: report, maxRetries: 3 })
      return b.build()
    }
    const off = await run(lambda(false), 30_000)
    const on = await run(lambda(true), 30_000)
    const ignored = off.frames.reduce((n, f) => n + (f.edges["s.consumers->f"]?.rates.itemFailuresIgnored ?? 0), 0)
    const acted = on.frames.reduce((n, f) => n + (f.edges["s.consumers->f"]?.rates.itemFailures ?? 0), 0)
    expect(ignored).toBeGreaterThan(0)
    expect(acted).toBeGreaterThan(0)
  })

  it("a shard blocked by a failing batch is held for the stream's retention: records go only as they expire", async () => {
    const doc = stream({ load: { rps: 1 }, dlq: true, consumers: fn({ retryBackoff: "1 minute", maxRetryBackoff: "10 minutes" }, { errorRate: 1 }) })
    const hour = 60 * 60_000
    const { mapping, stream: s } = await sim(doc, (sim) =>
      Effect.gen(function*() {
        // A day and more, an hour at a time, keeping no frames.
        for (let h = 1; h <= 26; h++) yield* sim.advanceTo(h * hour)
        return {
          mapping: (yield* sim.probeEdge("s.consumers->fn")).state as MappingState,
          stream: (yield* sim.probe("s")).state as StreamState
        }
      }), { frameMs: 60_000 })
    // Each batch is retried until its records are 24 hours old, then discarded: what has gone is what is over a day old.
    const gone = mapping.totals.discarded + mapping.totals.expired
    expect(gone).toBeGreaterThan(6_500)
    expect(gone).toBeLessThan(7_500)
    expect(mapping.totals.records).toBe(0)
    expect(mapping.iteratorAge).toBeGreaterThan(23.5 * hour)
    expect(s.retained).toBeGreaterThan(80_000)
  }, 60_000)

  it("a generic poller can read the stream too, as one shared consumer", async () => {
    const doc = stream({ stream: { shards: 2 }, load: { rps: 200 }, consumers: [{ id: "w", connector: "core.poller", edge: { workers: 2, batchSize: 50 } }] })
    const { frames } = await run(doc, 30_000)
    expect(mean(frames, "nodes", "w", "rates", "in", 10_000)).toBeGreaterThan(3)
    expect(mean(frames, "nodes", "s", "rates", "outgoing", 10_000)).toBeCloseTo(200, -1)
  })
})

describe("aws.kinesis.event-source-mapping: falling behind", () => {
  it("records older than the maximum record age are skipped, not sent: a mapping that is behind catches up by dropping them", async () => {
    // 300 a second, 100 processed a second: without a maximum age the backlog only grows.
    const slow = { latency: { mean: 1_000, cv: 0 } }
    const doc = stream({ load: { rps: 300 }, dlq: true, consumers: fn({ batchSize: 100, maxRecordAge: 60 }, slow) })
    const { edges, frames } = await run(doc, 240_000, ["fn"])
    expect(edges.fn!.iteratorAge).toBeLessThan(62_000)
    expect(edges.fn!.totals.discarded).toBeGreaterThan(20_000)
    expect(mean(frames, "nodes", "dlq", "rates", "in", 120_000)).toBeGreaterThan(0)
  })
})
