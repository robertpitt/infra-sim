import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../Builder.ts"
import { frames, mean, sim } from "../components/testing.ts"

interface Shape {
  readonly load?: Record<string, unknown>
  readonly queue?: Record<string, unknown>
  readonly consumer?: Record<string, unknown> | null
  readonly mapping?: Record<string, unknown>
  readonly dlq?: boolean
  readonly account?: Record<string, unknown>
}

/** clients -> queue -> (an external endpoint standing in for a consumer) [-> dead-letter queue] */
const pipeline = (s: Shape = {}) => {
  const b = Builder.make("sqs", { seed: 8 })
  const web = b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 50, ...s.load } })
  const q = b.add("aws.sqs", { id: "q", settings: s.queue ?? {} })
  b.connect(web, q)
  if (s.consumer !== null) {
    const worker = b.add("common.http-endpoint", { id: "worker", settings: { latency: { mean: 20, cv: 0 }, ...s.consumer } })
    b.connect(q.port("deliver"), worker, { batchSize: 1, ...s.mapping })
  }
  if (s.dlq) b.connect(q.port("dlq"), b.add("aws.sqs", { id: "dlq" }))
  if (s.account !== undefined) b.account("aws:us-east-1", s.account)
  return b.build()
}

describe("aws.sqs: delivery", () => {
  it("a fast consumer keeps the queue empty and deletes everything it receives", async () => {
    const all = await frames(pipeline(), 30_000)
    expect(mean(all, "nodes", "q", "gauges", "depth", 10_000)).toBeLessThan(2)
    expect(mean(all, "nodes", "q", "rates", "deleted", 10_000)).toBeCloseTo(50, -1)
    expect(mean(all, "nodes", "q", "rates", "redelivered", 0)).toBe(0)
  })

  it("a slow consumer builds a backlog you can see growing and ageing", async () => {
    // 2 invocations at a time, 200 ms each: 10 messages a second out, 50 in.
    const all = await frames(pipeline({ consumer: { latency: { mean: 200, cv: 0 } }, mapping: { maxConcurrency: 2 } }), 30_000)
    expect(mean(all, "nodes", "q", "gauges", "depth", 25_000)).toBeGreaterThan(900)
    expect(mean(all, "nodes", "q", "gauges", "oldestAgeMs", 25_000)).toBeGreaterThan(10_000)
  })

  it("failed deliveries come back after the visibility timeout, and finally move to the dead-letter queue", () =>
    sim(pipeline({ dlq: true, queue: { visibilityTimeout: "1 second", maxReceives: 3 } }), (s) =>
      Effect.gen(function*() {
        yield* s.faults.inject({ kind: "node", id: "worker" }, { _tag: "Outage" })
        const all = yield* s.advanceTo(30_000)
        expect(mean(all, "nodes", "q", "rates", "redelivered", 10_000)).toBeGreaterThan(50) // two redeliveries per message
        expect(mean(all, "nodes", "q", "rates", "deadLettered", 10_000)).toBeGreaterThan(40)
        expect(mean(all, "nodes", "dlq", "gauges", "depth", 25_000)).toBeGreaterThan(500)
        expect(mean(all, "nodes", "q", "rates", "deleted", 10_000)).toBe(0)
      })))

  it("without a dead-letter queue nothing is ever given up on: messages are retried until retention ends", () =>
    sim(pipeline({ queue: { visibilityTimeout: "1 second", maxReceives: 2 } }), (s) =>
      Effect.gen(function*() {
        yield* s.faults.inject({ kind: "node", id: "worker" }, { _tag: "Outage" })
        const all = yield* s.advanceTo(30_000)
        expect(mean(all, "nodes", "q", "rates", "deadLettered", 10_000)).toBe(0)
        expect(mean(all, "nodes", "q", "rates", "redelivered", 20_000)).toBeGreaterThan(50)
      })))

  it("a consumer slower than the visibility timeout makes the work happen more than once", async () => {
    const all = await frames(pipeline({ consumer: { latency: { mean: 2_000, cv: 0 } }, queue: { visibilityTimeout: "1 second", maxReceives: 10 }, mapping: { maxConcurrency: 1_000 } }), 70_000)
    // Once the consumer has scaled up to the ~100 it needs, every message is delivered at least twice.
    expect(mean(all, "nodes", "q", "rates", "redelivered", 40_000)).toBeGreaterThan(40)
    expect(mean(all, "nodes", "q", "rates", "duplicates", 40_000)).toBeGreaterThan(40)
    expect(mean(all, "nodes", "worker", "rates", "in", 40_000)).toBeGreaterThan(80) // well above the 50 msg/s sent
  })

  it("a delivery delay keeps new messages invisible", async () => {
    const all = await frames(pipeline({ queue: { delay: "10 seconds" } }), 25_000)
    expect(mean(all, "nodes", "q", "rates", "deleted", 0, 8_000)).toBe(0)
    expect(mean(all, "nodes", "q", "gauges", "delayed", 6_000, 8_000)).toBeGreaterThan(200)
    expect(mean(all, "nodes", "q", "rates", "deleted", 15_000)).toBeGreaterThan(40)
  })

  it("batches messages for one consumer invocation, waiting up to the batching window", async () => {
    const all = await frames(pipeline({ load: { rps: 100 }, mapping: { batchSize: 10, batchWindow: 1_000 } }), 30_000)
    expect(mean(all, "nodes", "q", "rates", "deleted", 10_000)).toBeCloseTo(100, -1) // every message still deleted
    expect(mean(all, "nodes", "worker", "rates", "in", 10_000)).toBeLessThan(16) // ...by about ten invocations a second
    expect(mean(all, "nodes", "worker", "rates", "in", 10_000)).toBeGreaterThan(7)
  })

  it("starts a consumer small and scales it up while messages wait: 5 at first, then 300 a minute", async () => {
    const all = await frames(pipeline({ load: { rps: 1_000 }, consumer: { latency: { mean: 1_000, cv: 0 } }, mapping: { maxConcurrency: 0 } }), 65_000)
    const early = mean(all, "nodes", "worker", "gauges", "inflight", 9_000, 11_000)
    const late = mean(all, "nodes", "worker", "gauges", "inflight", 58_000, 62_000)
    expect(early).toBeGreaterThan(30) // about 5 + 5 a second
    expect(early).toBeLessThan(80)
    expect(late).toBeGreaterThan(250)
    expect(late).toBeLessThan(380)
  })

  it("never has more messages in flight than its limit", async () => {
    const all = await frames(pipeline({ load: { rps: 200 }, consumer: { latency: { mean: 5_000, cv: 0 } }, queue: { inFlightLimit: 50, visibilityTimeout: "12 hours" }, mapping: { maxConcurrency: 1_000 } }), 40_000)
    expect(Math.max(...all.map((f) => f.nodes.q!.gauges.hidden!))).toBeLessThanOrEqual(50)
    expect(mean(all, "nodes", "q", "gauges", "depth", 30_000)).toBeGreaterThan(1_000)
  })
})

describe("aws.sqs: retention and size", () => {
  it("deletes messages that outlive the retention period", async () => {
    const all = await frames(pipeline({ consumer: null, load: { rps: 20 }, queue: { retention: "1 minute" } }), 200_000)
    expect(mean(all, "nodes", "q", "rates", "expired", 100_000)).toBeCloseTo(20, -1)
    const depth = mean(all, "nodes", "q", "gauges", "depth", 150_000)
    expect(depth).toBeGreaterThan(1_000) // 20 a second for one minute
    expect(depth).toBeLessThan(1_500)
  })

  it("refuses messages over 1 MiB", async () => {
    const all = await frames(pipeline({ consumer: null, load: { rps: 10, payload: 1_025 } }), 5_000)
    expect(mean(all, "nodes", "web", "rates", "fail.Rejected", 1_000)).toBeGreaterThan(8)
    const ok = await frames(pipeline({ consumer: null, load: { rps: 10, payload: 1_024 } }), 5_000)
    expect(mean(ok, "nodes", "web", "rates", "fail", 1_000)).toBe(0)
  })
})

describe("aws.sqs: FIFO", () => {
  const fifo = { kind: "fifo", ...{} }

  it("delivers one message per message group at a time, so one group can't go faster than its consumer", async () => {
    const one = await frames(pipeline({ queue: fifo, load: { messageGroups: 1 }, consumer: { latency: { mean: 200, cv: 0 } } }), 30_000)
    expect(mean(one, "nodes", "q", "rates", "deleted", 10_000)).toBeLessThan(6) // 1 / 0.2 s, however many consumers
    expect(mean(one, "nodes", "q", "gauges", "depth", 25_000)).toBeGreaterThan(1_000)
    const many = await frames(pipeline({ queue: fifo, load: { messageGroups: 40 }, consumer: { latency: { mean: 200, cv: 0 } } }), 30_000)
    expect(mean(many, "nodes", "q", "rates", "deleted", 10_000)).toBeGreaterThan(40) // groups proceed in parallel
  })

  it("a message that keeps failing blocks everything behind it in its group", () =>
    sim(pipeline({ queue: { kind: "fifo", visibilityTimeout: "2 seconds" }, load: { messageGroups: 1, rps: 20 } }), (s) =>
      Effect.gen(function*() {
        yield* s.faults.inject({ kind: "node", id: "worker" }, { _tag: "Outage" })
        yield* s.advanceTo(20_000)
        const state = (yield* s.probe("q")).state as { ready: number; groups: { blocked: number } }
        expect(state.groups.blocked).toBe(1)
        expect(state.ready).toBeGreaterThan(300) // everything piled up behind the one failing message
        yield* s.faults.clearAll
        const after = yield* s.advanceTo(60_000)
        expect(mean(after, "nodes", "q", "rates", "deleted", 55_000)).toBeGreaterThan(5) // the group drains once it can
      })))

  it("limits a FIFO queue to 300 API calls a second in normal mode", async () => {
    const all = await frames(pipeline({ consumer: null, queue: fifo, load: { rps: 600 } }), 20_000)
    expect(mean(all, "nodes", "web", "rates", "ok", 10_000)).toBeCloseTo(300, -2)
    expect(mean(all, "nodes", "web", "rates", "fail.Throttled", 10_000)).toBeGreaterThan(250)
  })

  it("high-throughput mode raises the limit to the region's quota, which is editable", async () => {
    const load = { rps: 600 }
    const normal = await frames(pipeline({ consumer: null, queue: { kind: "fifo", highThroughput: true }, load, account: { sqsFifoHighThroughput: 400 } }), 20_000)
    expect(mean(normal, "nodes", "web", "rates", "ok", 10_000)).toBeCloseTo(400, -2)
    const raised = await frames(pipeline({ consumer: null, queue: { kind: "fifo", highThroughput: true }, load }), 20_000)
    expect(mean(raised, "nodes", "web", "rates", "fail", 10_000)).toBe(0) // us-east-1: 70,000
  })
})
