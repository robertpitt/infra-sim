import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../../../Builder.ts"
import { frames, mean, sim } from "../../../testing.ts"

interface Shape {
  readonly load?: Record<string, unknown>
  /** The edge from the clients to the queue (latency, timeout, retry). */
  readonly send?: Record<string, unknown>
  readonly queue?: Record<string, unknown>
  readonly consumer?: Record<string, unknown> | null
  readonly mapping?: Record<string, unknown>
  readonly dlq?: boolean | Record<string, unknown>
  readonly account?: Record<string, unknown>
}

interface QueueState {
  readonly ready: number
  readonly hidden: number
  readonly delayed: number
  readonly oldestAge: number
  readonly totals: Record<"enqueued" | "sent" | "received" | "deleted" | "redelivered" | "deadLettered" | "expired" | "duplicates" | "deduplicated" | "redriven" | "throttled", number>
  readonly groups: { waiting: number; blocked: number; inflight: number }
  readonly parked: number
  readonly sample: ReadonlyArray<{ id: number; group: string; receives: number; age: number; status: string }>
}

/** clients -> queue -> (an external endpoint standing in for a consumer) [-> dead-letter queue] */
const pipeline = (s: Shape = {}) => {
  const b = Builder.make("sqs", { seed: 8 })
  const web = b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 50, ...s.load } })
  const q = b.add("aws.sqs", { id: "q", settings: s.queue ?? {} })
  b.connect(web, q, s.send)
  if (s.consumer !== null) {
    const worker = b.add("common.http-endpoint", { id: "worker", settings: { latency: { mean: 20, cv: 0 }, ...s.consumer } })
    b.connect(q.port("deliver"), worker, { batchSize: 1, ...s.mapping })
  }
  if (s.dlq) b.connect(q.port("dlq"), b.add("aws.sqs", { id: "dlq", settings: s.dlq === true ? {} : s.dlq }))
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

/** What a queue reports when probed. */
const stateOf = (s: Parameters<Parameters<typeof sim>[1]>[0], id = "q") => Effect.map(s.probe(id), (p) => p.state as QueueState)

const outage = (s: Parameters<Parameters<typeof sim>[1]>[0], id: string) => s.faults.inject({ kind: "node", id }, { _tag: "Outage" })

describe("aws.sqs: FIFO deduplication", () => {
  /** A send whose reply is slower than the caller's timeout: the queue accepts the message, the producer retries it. */
  const retrying = { latency: { mean: 300, cv: 0 }, timeout: 500, retry: { maxAttempts: 2, backoff: 100, jitter: false } }
  const run = (deduplication: boolean) =>
    sim(pipeline({ consumer: null, queue: { kind: "fifo", deduplication }, load: { rps: 10, messageGroups: 20 }, send: retrying }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(10_000)
        return { q: yield* stateOf(s), sent: ((yield* s.probe("web")).state as { sent: number }).sent }
      }))

  it("acknowledges a retried send but does not enqueue it twice", async () => {
    const { q, sent } = await run(true)
    // Every message arrives twice (the producer retries after its timeout); the second is dropped.
    expect(q.totals.deduplicated).toBeGreaterThan(70)
    expect(q.totals.sent).toBeGreaterThan(70)
    expect(q.totals.sent).toBeLessThanOrEqual(sent)
    expect(q.totals.sent + q.totals.deduplicated).toBeGreaterThan(1.8 * q.totals.sent - 25)
  })

  it("without it the same retried send is enqueued twice", async () => {
    const { q } = await run(false)
    expect(q.totals.deduplicated).toBe(0)
    expect(q.totals.sent).toBeGreaterThan(150)
  })

  it("remembers an id for five minutes and no longer", () =>
    // One message, tried again after 1 minute (inside the window) and after 10 more (outside it).
    sim(
      pipeline({
        consumer: null,
        queue: { kind: "fifo", deduplication: true },
        load: { rps: 0.0008 },
        send: { latency: { mean: 300, cv: 0 }, timeout: 500, retry: { maxAttempts: 3, backoff: "1 minute", backoffFactor: 10, maxBackoff: "10 minutes", jitter: false } }
      }),
      (s) =>
        Effect.gen(function*() {
          yield* s.advanceTo(1_960_000)
          const q = yield* stateOf(s)
          expect(q.totals.deduplicated).toBe(1) // the retry after a minute
          expect(q.totals.sent).toBe(2) // the first, and the one eleven minutes on
        })
    ))

  it("is not applied to a standard queue", async () => {
    const q = await sim(pipeline({ consumer: null, queue: { deduplication: true }, load: { rps: 10 }, send: retrying }), (s) => Effect.andThen(s.advanceTo(5_000), stateOf(s)))
    expect(q.totals.deduplicated).toBe(0)
  })
})

describe("aws.sqs: FIFO throughput", () => {
  it("holds one message group to one partition's 300 calls a second even in high-throughput mode", async () => {
    const one = await frames(pipeline({ consumer: null, queue: { kind: "fifo", highThroughput: true }, load: { rps: 600, messageGroups: 1 } }), 20_000)
    expect(mean(one, "nodes", "web", "rates", "ok", 10_000)).toBeCloseTo(300, -2)
    expect(mean(one, "nodes", "web", "rates", "fail.Throttled", 10_000)).toBeGreaterThan(250)
    const many = await frames(pipeline({ consumer: null, queue: { kind: "fifo", highThroughput: true }, load: { rps: 600, messageGroups: 20 } }), 20_000)
    expect(mean(many, "nodes", "web", "rates", "fail", 10_000)).toBe(0)
  })

  it("a batch consumer reads many groups in one invocation", async () => {
    // With a backlog (a slow consumer) each batch is filled from one group after another.
    const all = await frames(pipeline({ queue: { kind: "fifo" }, load: { rps: 200, messageGroups: 40 }, consumer: { latency: { mean: 500, cv: 0 } }, mapping: { batchSize: 10 } }), 40_000)
    expect(mean(all, "nodes", "q", "rates", "deleted", 25_000)).toBeGreaterThan(150)
    expect(mean(all, "nodes", "worker", "rates", "in", 25_000)).toBeLessThan(0.6 * mean(all, "nodes", "q", "rates", "deleted", 25_000)) // fewer invocations than messages
  })

  it("limits receives as well as sends to 300 calls a second in normal mode", () =>
    // Every message fails and comes back each second, so receives would grow far past the 250 a second sent.
    sim(pipeline({ queue: { kind: "fifo", visibilityTimeout: "1 second", maxReceives: 1_000 }, load: { rps: 250, messageGroups: 50_000 } }), (s) =>
      Effect.gen(function*() {
        yield* outage(s, "worker")
        const all = yield* s.advanceTo(30_000)
        const received = mean(all, "nodes", "q", "rates", "received", 20_000)
        expect(received).toBeGreaterThan(250)
        expect(received).toBeLessThan(330)
      })))

  it("reports the groups that have a message in flight", () =>
    sim(pipeline({ queue: { kind: "fifo" }, load: { rps: 50, messageGroups: 5 }, consumer: { latency: { mean: 5_000, cv: 0 } } }), (s) =>
      Effect.gen(function*() {
        const all = yield* s.advanceTo(10_000)
        expect(mean(all, "nodes", "q", "gauges", "groupsInflight", 8_000)).toBe(5)
        expect((yield* stateOf(s)).groups.inflight).toBe(5)
      })))
})

describe("aws.sqs: visibility timeout and the mapping", () => {
  it("a batching window longer than the visibility timeout makes messages come back before the batch is sent", async () => {
    const run = (window: number, visibility: string) =>
      frames(pipeline({ load: { rps: 5 }, queue: { visibilityTimeout: visibility, maxReceives: 1_000 }, mapping: { batchSize: 1_000, batchWindow: window } }), 70_000)
    const bad = await run(30_000, "10 seconds")
    expect(mean(bad, "nodes", "q", "rates", "redelivered", 20_000)).toBeGreaterThan(0.5)
    const good = await run(5_000, "30 seconds")
    expect(mean(good, "nodes", "q", "rates", "redelivered", 10_000)).toBe(0)
    expect(mean(good, "nodes", "q", "rates", "deleted", 20_000)).toBeCloseTo(5, 0)
  })

  it("a throttled consumer keeps its batch and retries, instead of hiding the whole backlog", async () => {
    // An endpoint that answers 429 above 20 calls a second, fed 50 a second.
    const all = await frames(pipeline({ load: { rps: 50 }, consumer: { rateLimit: 20, burst: 20, latency: { mean: 10, cv: 0 } }, queue: { visibilityTimeout: "30 seconds" } }), 40_000)
    expect(mean(all, "nodes", "q", "rates", "deleted", 20_000, 40_000)).toBeGreaterThan(15)
    expect(mean(all, "nodes", "q", "rates", "deleted", 20_000, 40_000)).toBeLessThan(25)
    expect(mean(all, "nodes", "q", "gauges", "hidden", 20_000, 40_000)).toBeLessThan(30) // a few pollers' batches, not the backlog
    expect(mean(all, "nodes", "q", "gauges", "depth", 35_000)).toBeGreaterThan(500)
  })

  it("never has more in flight than the limit even when a batch would cross it", async () => {
    const all = await frames(pipeline({ load: { rps: 200 }, consumer: { latency: { mean: 5_000, cv: 0 } }, queue: { inFlightLimit: 25, visibilityTimeout: "12 hours" }, mapping: { batchSize: 10, maxConcurrency: 1_000 } }), 30_000)
    expect(Math.max(...all.map((f) => f.nodes.q!.gauges.hidden!))).toBe(25)
  })

  it("provisioned mode starts with the pollers it was given instead of five", async () => {
    const run = (mapping: Record<string, unknown>) =>
      frames(pipeline({ load: { rps: 1_000 }, consumer: { latency: { mean: 1_000, cv: 0 } }, mapping }), 40_000)
    const provisioned = await run({ provisionedMinPollers: 20, provisionedMaxPollers: 30 })
    expect(mean(provisioned, "nodes", "worker", "gauges", "inflight", 3_000, 5_000)).toBeGreaterThan(150) // 20 pollers x 10 invocations
    expect(mean(provisioned, "nodes", "worker", "gauges", "inflight", 30_000, 40_000)).toBeLessThan(310) // capped at 30 x 10
    const standard = await run({})
    expect(mean(standard, "nodes", "worker", "gauges", "inflight", 3_000, 5_000)).toBeLessThan(60)
  })

  it("estimates the empty long-poll receives of idle pollers: five pollers, one empty receive per 20 seconds each", async () => {
    const all = await frames(pipeline({ load: { rps: 0 } }), 60_000)
    expect(mean(all, "nodes", "q", "rates", "emptyReceives", 10_000)).toBeCloseTo(0.25, 1)
  })
})

describe("aws.sqs: dead-letter queues", () => {
  it("a standard dead-letter queue keeps counting retention from the original enqueue; FIFO restarts it", async () => {
    // Messages fail once for a visibility timeout of 30 s, then move; the dead-letter queue keeps them one minute.
    const run = (kind: string) =>
      sim(
        pipeline({ dlq: { kind, retention: "1 minute" }, queue: { kind, visibilityTimeout: "30 seconds", maxReceives: 1, retention: "1 hour" }, load: { rps: 1, messageGroups: 1_000 }, consumer: {} }),
        (s) =>
          Effect.gen(function*() {
            yield* outage(s, "worker")
            const all = yield* s.advanceTo(200_000)
            return mean(all, "nodes", "dlq", "gauges", "depth", 150_000)
          })
      )
    const standard = await run("standard")
    const fifo = await run("fifo")
    expect(standard).toBeGreaterThan(20)
    expect(standard).toBeLessThan(40) // 30 s of the minute was spent in the source queue
    expect(fifo).toBeGreaterThan(50) // the whole minute
  })

  it("does not count a dead-letter move as a send", () =>
    sim(pipeline({ dlq: true, queue: { visibilityTimeout: "1 second", maxReceives: 2 }, load: { rps: 20 } }), (s) =>
      Effect.gen(function*() {
        yield* outage(s, "worker")
        yield* s.advanceTo(20_000)
        const dlq = yield* stateOf(s, "dlq")
        const q = yield* stateOf(s)
        expect(q.totals.deadLettered).toBeGreaterThan(200)
        expect(dlq.totals.enqueued).toBe(q.totals.deadLettered)
        expect(dlq.totals.sent).toBe(0)
      })))

  it("keeps a message in flight and retries when the dead-letter queue refuses it, losing nothing", () =>
    sim(pipeline({ dlq: true, queue: { visibilityTimeout: "1 second", maxReceives: 1 }, load: { rps: 10 } }), (s) =>
      Effect.gen(function*() {
        yield* outage(s, "worker")
        const down = yield* outage(s, "dlq")
        yield* s.advanceTo(10_000)
        expect((yield* stateOf(s)).parked).toBeGreaterThan(50)
        expect((yield* stateOf(s, "dlq")).ready).toBe(0)
        yield* s.faults.clear(down.id)
        yield* s.advanceTo(20_000)
        const q = yield* stateOf(s)
        expect(q.parked).toBe(0)
        expect((yield* stateOf(s, "dlq")).totals.enqueued).toBe(q.totals.deadLettered)
        expect(q.totals.deadLettered).toBeGreaterThan(100)
      })))

  it("a standard queue stops counting a message that keeps coming back towards its oldest age; FIFO can't", async () => {
    const run = (kind: string) =>
      sim(pipeline({ queue: { kind, visibilityTimeout: "1 second", maxReceives: 1_000 }, load: { rps: 1, messageGroups: 1 } }), (s) =>
        Effect.gen(function*() {
          yield* outage(s, "worker")
          const all = yield* s.advanceTo(60_000)
          return mean(all, "nodes", "q", "gauges", "oldestAgeMs", 50_000)
        }))
    expect(await run("standard")).toBeLessThan(8_000) // poison messages are left out after three receives
    expect(await run("fifo")).toBeGreaterThan(45_000) // the first message blocks its group and keeps ageing
  })
})

describe("aws.sqs: redrive", () => {
  /** source -> consumer, source -dlq-> dead-letter queue -redrive-> source */
  const looped = (redriveSettings: Record<string, unknown> = {}) => {
    const b = Builder.make("redrive", { seed: 3 })
    const web = b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 50 } })
    const q = b.add("aws.sqs", { id: "q", settings: { visibilityTimeout: "1 second", maxReceives: 2 } })
    const dlq = b.add("aws.sqs", { id: "dlq", settings: redriveSettings })
    const worker = b.add("common.http-endpoint", { id: "worker", settings: { latency: { mean: 20, cv: 0 } } })
    b.connect(web, q)
    b.connect(q.port("deliver"), worker, { batchSize: 1 })
    b.connect(q.port("dlq"), dlq)
    b.connect(dlq.port("redrive"), q)
    return b.build()
  }

  it("moves a dead-letter queue's messages back to the source at the chosen velocity, as new messages", () =>
    sim(looped(), (s) =>
      Effect.gen(function*() {
        const failing = yield* outage(s, "worker")
        yield* s.advanceTo(15_000)
        const before = yield* stateOf(s, "dlq")
        expect(before.ready).toBeGreaterThan(400)
        // The consumer is fixed, and the redrive starts.
        yield* s.faults.clear(failing.id)
        yield* s.configureNode("dlq", { redrive: true, redriveVelocity: 100 })
        const all = yield* s.advanceTo(35_000)
        expect(mean(all, "nodes", "dlq", "rates", "redriven", 17_000, 22_000)).toBeGreaterThan(80)
        expect(mean(all, "nodes", "dlq", "rates", "redriven", 17_000, 22_000)).toBeLessThan(120)
        const after = yield* stateOf(s, "dlq")
        expect(after.ready).toBeLessThan(5)
        expect(after.totals.redriven).toBeGreaterThan(before.ready)
        // Redriven messages are processed by the source's consumer, and are not counted as the producer's sends.
        const q = yield* stateOf(s)
        const sent = ((yield* s.probe("web")).state as { sent: number }).sent
        expect(q.totals.sent).toBeLessThanOrEqual(sent)
        expect(q.totals.deleted).toBeGreaterThan(before.ready * 0.9)
      })))

  it("does nothing until switched on", () =>
    sim(looped(), (s) =>
      Effect.gen(function*() {
        yield* outage(s, "worker")
        yield* s.advanceTo(10_000)
        expect((yield* stateOf(s, "dlq")).totals.redriven).toBe(0)
      })))
})

describe("aws.sqs: deep queues and hardening", () => {
  it("a queue of hundreds of thousands of messages ages and expires without scanning: oldest age and retention stay exact", async () => {
    const all = await frames(pipeline({ consumer: null, queue: { retention: "1 minute" }, load: { rps: 3_000, arrival: "constant" } }), 100_000)
    expect(mean(all, "nodes", "q", "gauges", "depth", 95_000)).toBeGreaterThan(170_000) // a minute of 3,000 a second
    expect(mean(all, "nodes", "q", "gauges", "depth", 95_000)).toBeLessThan(190_000)
    expect(mean(all, "nodes", "q", "gauges", "oldestAgeMs", 95_000)).toBeGreaterThan(58_000)
    expect(mean(all, "nodes", "q", "gauges", "oldestAgeMs", 95_000)).toBeLessThan(61_500)
  })

  it("a FIFO queue with a message group per message does not keep the groups once they are gone", () =>
    sim(pipeline({ queue: { kind: "fifo" }, load: { rps: 250, messageGroups: 100_000 } }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(20_000)
        const q = yield* stateOf(s)
        // The consumer keeps up, so almost nothing is waiting; groups of deleted messages must not pile up.
        expect(q.groups.waiting).toBeLessThan(100)
        expect(q.ready).toBeLessThan(100)
        expect(q.totals.deleted).toBeGreaterThan(4_000)
      })))

  it("copes with odd settings: tiny retention, zero visibility timeout, maximum batch and window, nothing wired", async () => {
    const odd = await sim(
      pipeline({ queue: { retention: "1 minute", visibilityTimeout: 0, delay: "15 minutes", maxReceives: 1, inFlightLimit: 1 }, mapping: { batchSize: 10_000, batchWindow: "5 minutes", maxConcurrency: 1 }, load: { rps: 20 } }),
      (s) => Effect.gen(function*() {
        yield* s.advanceTo(30_000)
        return { defects: yield* s.defects, q: yield* stateOf(s) }
      })
    )
    expect(odd.defects).toEqual([])
    expect(odd.q.delayed).toBeGreaterThan(400)
    const bare = await sim(pipeline({ consumer: null, queue: { kind: "fifo" }, load: { rps: 5, messageGroups: 3 } }), (s) => Effect.gen(function*() {
      yield* s.advanceTo(10_000)
      return { defects: yield* s.defects, q: yield* stateOf(s) }
    }))
    expect(bare.defects).toEqual([])
    expect(bare.q.ready).toBeGreaterThan(40)
  })

  it("the queue's books balance: what was accepted is waiting, in flight, delayed, deleted, expired or dead-lettered", () =>
    sim(pipeline({ dlq: true, queue: { visibilityTimeout: "3 seconds", maxReceives: 2, retention: "1 minute" }, load: { rps: 40 }, consumer: { errorRate: 0.3, latency: { mean: 50, cv: 0.5 } } }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(90_000)
        const q = yield* stateOf(s)
        const t = q.totals
        expect(q.ready + q.hidden + q.delayed + t.deleted + t.expired + t.deadLettered).toBe(t.enqueued)
        expect(t.redelivered).toBeGreaterThan(0)
      })))
})

describe("aws.sqs: partial batch responses (ReportBatchItemFailures)", () => {
  /** clients -> queue -> a Lambda that fails a fifth of its records, in batches of ten. */
  const reporting = (o: { readonly errors: string; readonly report: boolean; readonly connector?: string; readonly queue?: Record<string, unknown> }) => {
    const b = Builder.make("partial", { seed: 5 })
    const web = b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 100, ...(o.queue?.kind === "fifo" ? { messageGroups: 1 } : {}) } })
    const q = b.add("aws.sqs", { id: "q", settings: { visibilityTimeout: "2 seconds", ...o.queue } })
    const fn = b.add("aws.lambda", { id: "fn", settings: { errorRate: 0.2, fanOut: "none", duration: { mean: 50, cv: 0 }, batch: { errors: o.errors } } })
    b.connect(web, q)
    const consumer = o.connector === undefined ? { batchSize: 10, batchWindow: "1 second", reportBatchItemFailures: o.report } : { batchSize: 10, workers: 20 }
    b.connect(q.port("deliver"), fn, consumer, o.connector === undefined ? {} : { connector: o.connector })
    return b.build()
  }
  const run = (design: ReturnType<typeof reporting>) =>
    sim(design, (s) =>
      Effect.gen(function*() {
        const all = yield* s.advanceTo(40_000)
        return { all, q: yield* stateOf(s), fn: (yield* s.probe("fn")).state as { errors: number; itemFailures: number }, edge: yield* s.probeEdge("q.deliver->fn") }
      }))

  it("only the records that failed come back; the rest of the batch is deleted", async () => {
    const reported = await run(reporting({ errors: "report", report: true }))
    const whole = await run(reporting({ errors: "record", report: false }))
    // Reported: a fifth of the records fail and come back; the invocations themselves succeed.
    expect(reported.fn.errors).toBe(0)
    expect(reported.fn.itemFailures).toBeGreaterThan(500)
    const back = mean(reported.all, "nodes", "q", "rates", "redelivered", 10_000)
    expect(back).toBeGreaterThan(15)
    expect(back).toBeLessThan(35)
    expect(mean(reported.all, "edges", "q.deliver->fn", "rates", "itemFailures", 10_000)).toBeCloseTo(back, -1)
    // Whole batches: one bad record in ten fails nine good ones with it (1 - 0.8^10 of batches), so far more comes back.
    expect(whole.fn.errors).toBeGreaterThan(500)
    expect(mean(whole.all, "nodes", "q", "rates", "redelivered", 10_000)).toBeGreaterThan(3 * back)
  })

  it("a function's report is ignored by a mapping that isn't set to act on it: the failed records are deleted too", async () => {
    const ignored = await run(reporting({ errors: "report", report: false }))
    expect(ignored.fn.itemFailures).toBeGreaterThan(500)
    expect(ignored.q.totals.redelivered).toBe(0)
    expect(mean(ignored.all, "edges", "q.deliver->fn", "rates", "itemFailuresIgnored", 10_000)).toBeGreaterThan(15)
  })

  it("from a FIFO queue, a failed record keeps the rest of its group behind it", async () => {
    const fifo = await run(reporting({ errors: "report", report: true, queue: { kind: "fifo" } }))
    const kept = fifo.all.reduce((sum, f) => sum + (f.edges["q.deliver->fn"]?.rates.itemFailures ?? 0), 0)
    const reported = fifo.all.reduce((sum, f) => sum + (f.nodes.fn?.rates.itemFailures ?? 0), 0)
    expect(reported).toBeGreaterThan(0)
    expect(kept).toBeGreaterThan(reported)
  })

  it("the generic poller honours a partial reply the same way", async () => {
    const pooled = await run(reporting({ errors: "report", report: true, connector: "core.poller" }))
    expect(pooled.fn.errors).toBe(0)
    expect(pooled.q.totals.redelivered).toBeGreaterThan(0)
    expect((pooled.edge.state as { recordsFailed: number }).recordsFailed).toBeGreaterThan(500)
  })
})
