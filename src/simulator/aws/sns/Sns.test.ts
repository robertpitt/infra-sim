import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../../Builder.ts"
import { frames, mean, sim } from "../../components/testing.ts"
import { audit } from "./audit.ts"
import { snsFifoRate, snsStandardRate } from "./quotas.ts"

interface Subscriber {
  readonly id: string
  readonly type?: string
  readonly settings?: Record<string, unknown>
  readonly edge?: Record<string, unknown>
}

interface Shape {
  readonly topic?: Record<string, unknown>
  readonly load?: Record<string, unknown>
  readonly publishEdge?: Record<string, unknown>
  readonly subscribers: ReadonlyArray<Subscriber>
  readonly region?: string
  readonly account?: Record<string, unknown>
  /** Wire a dead-letter queue to the topic. */
  readonly dlq?: boolean
}

const quick = { latency: { mean: 10, cv: 0 } }

/** clients -> topic -> subscribers [-> dead-letter queue] */
const design = (s: Shape) => {
  const b = Builder.make("sns", { seed: 6 })
  const region = s.region
  const web = b.add("common.client", { id: "web", settings: { arrival: "constant", ...s.load } })
  const t = b.add("aws.sns", { id: "topic", ...(region === undefined ? {} : { region }), settings: s.topic ?? {} })
  b.connect(web, t, s.publishEdge)
  for (const sub of s.subscribers) {
    const aws = sub.type?.startsWith("aws.") === true && region !== undefined
    b.connect(t, b.add(sub.type ?? "common.http-endpoint", { id: sub.id, ...(aws ? { region } : {}), settings: sub.settings ?? quick }), sub.edge)
  }
  if (s.dlq === true) b.connect(t.port("dlq"), b.add("aws.sqs", { id: "dlq", ...(region === undefined ? {} : { region }) }))
  if (s.account !== undefined) b.account(`aws:${region ?? "us-east-1"}`, s.account)
  return b.build()
}

const run = (s: Shape, ms: number) => frames(design(s), ms)
const state = async (s: Shape, ms: number, node = "topic") => sim(design(s), (sm) => Effect.flatMap(sm.advanceTo(ms), () => sm.probe(node))).then((p) => p.state as Record<string, any>)

const A: Subscriber = { id: "a" }

describe("aws.sns: fan-out", () => {
  it("delivers a copy to every subscriber", async () => {
    const all = await run({ load: { rps: 100 }, subscribers: [A, { id: "b" }, { id: "c" }] }, 20_000)
    for (const id of ["a", "b", "c"]) expect(mean(all, "nodes", id, "rates", "ok", 5_000)).toBeCloseTo(100, -1)
    expect(mean(all, "nodes", "topic", "rates", "delivered", 5_000)).toBeCloseTo(300, -1)
    expect(mean(all, "nodes", "topic", "rates", "published", 5_000)).toBeCloseTo(100, -1)
  })

  it("publishes to a topic with no subscribers without failing", async () => {
    const all = await run({ load: { rps: 50 }, subscribers: [] }, 10_000)
    expect(mean(all, "nodes", "web", "rates", "fail", 2_000)).toBe(0)
    expect(mean(all, "nodes", "topic", "rates", "published", 2_000)).toBeCloseTo(50, -1)
  })

  it("a slow or dead subscriber never delays the others or the publisher", async () => {
    const stuck = { id: "stuck", settings: { latency: { mean: 60_000, cv: 0 } }, edge: { timeout: "1 minute" } }
    const all = await run({ load: { rps: 50 }, subscribers: [A, stuck] }, 30_000)
    expect(mean(all, "nodes", "a", "rates", "ok", 10_000)).toBeCloseTo(50, -1)
    expect(mean(all, "nodes", "web", "rates", "fail", 0)).toBe(0)
    const latency = all.flatMap((f) => (f.nodes.web?.dist.latency ? [f.nodes.web.dist.latency.p99] : []))
    expect(Math.max(...latency)).toBeLessThan(60)
    expect(mean(all, "nodes", "topic", "gauges", "pending", 25_000)).toBeGreaterThan(1_000) // the stuck one is holding its own backlog
  })

  it("invokes Lambda subscribers asynchronously, so a slow function never slows the publisher", () =>
    sim(
      design({
        load: { rps: 10 },
        region: "us-east-1",
        subscribers: [{ id: "fn", type: "aws.lambda", settings: { memory: 1769, duration: { mean: 3_000, cv: 0 }, timeout: "10 seconds" } }]
      }),
      (s) =>
        Effect.gen(function*() {
          const all = yield* s.advanceTo(20_000)
          const fn = (yield* s.probe("fn")).state as { asyncPending: number }
          expect(fn.asyncPending).toBeGreaterThan(20)
          const latency = all.flatMap((f) => (f.nodes.web?.dist.latency ? [f.nodes.web.dist.latency.p50] : []))
          expect(Math.max(...latency)).toBeLessThan(60)
        })
    ))

  it("records the size of what is published", async () => {
    const all = await run({ load: { rps: 20, payload: 10 }, subscribers: [A] }, 10_000)
    const size = all.flatMap((f) => (f.nodes.topic?.dist.publishSize ? [f.nodes.topic.dist.publishSize.mean] : []))
    expect(size.length).toBeGreaterThan(10)
    for (const s of size) expect(s).toBeCloseTo(10 * 1024, -1)
  })

  it("is deterministic: the same design and seed give the same frames", async () => {
    const shape: Shape = { load: { rps: 80, arrival: "poisson" }, subscribers: [{ id: "a", settings: { errorRate: 0.3, latency: { mean: 10, cv: 0.5 } }, edge: { filterMatch: 0.5 } }] }
    const first = await run(shape, 10_000)
    const second = await run(shape, 10_000)
    expect(second).toEqual(first)
  })
})

describe("aws.sns: publish quotas", () => {
  it("limits publishes to the region's quota: 30,000/s in us-east-1 but only 300/s in eu-north-1", async () => {
    const at = (region: string, account?: Record<string, unknown>) => run({ load: { rps: 600 }, subscribers: [A], region, ...(account === undefined ? {} : { account }) }, 20_000)
    expect(mean(await at("us-east-1"), "nodes", "web", "rates", "fail", 5_000)).toBe(0)
    const small = await at("eu-north-1")
    expect(mean(small, "nodes", "web", "rates", "ok", 5_000)).toBeCloseTo(300, -2)
    expect(mean(small, "nodes", "web", "rates", "fail.Throttled", 5_000)).toBeGreaterThan(250)
    // The quota is a setting: ask AWS for more and it is raised.
    expect(mean(await at("eu-north-1", { snsPublishRate: 1_000 }), "nodes", "web", "rates", "fail", 5_000)).toBe(0)
  })

  it("has AWS's published regional defaults", () => {
    expect([snsStandardRate("us-east-1"), snsStandardRate("us-west-2"), snsStandardRate("eu-west-1"), snsStandardRate("eu-central-1"), snsStandardRate("ap-south-1"), snsStandardRate("eu-north-1"), snsStandardRate("sa-east-1")]).toEqual([30_000, 9_000, 9_000, 1_500, 1_500, 300, 300])
    expect([snsFifoRate("us-east-1"), snsFifoRate("us-west-2"), snsFifoRate("eu-west-1"), snsFifoRate("eu-central-1"), snsFifoRate("eu-north-1")]).toEqual([30_000, 9_000, 9_000, 3_000, 3_000])
  })

  it("keeps standard and FIFO publish quotas apart", async () => {
    const account = { snsPublishRate: 100, snsFifoPublishRate: 1_000 }
    const standard = await run({ load: { rps: 400 }, subscribers: [A], account }, 15_000)
    expect(mean(standard, "nodes", "web", "rates", "ok", 5_000)).toBeCloseTo(100, -1)
    const fifo = await run({ topic: { kind: "fifo" }, load: { rps: 400, messageGroups: 50 }, subscribers: [A], account }, 15_000)
    expect(mean(fifo, "nodes", "web", "rates", "fail", 5_000)).toBe(0)
  })

  it("takes a live change of the account quota on the next publish", () =>
    sim(design({ load: { rps: 400 }, subscribers: [A], region: "eu-north-1" }), (s) =>
      Effect.gen(function*() {
        const before = yield* s.advanceTo(10_000)
        expect(mean(before, "nodes", "web", "rates", "fail.Throttled", 5_000)).toBeGreaterThan(50)
        yield* s.configureAccount("aws:eu-north-1", { snsPublishRate: 5_000 })
        const after = yield* s.advanceTo(30_000)
        expect(mean(after, "nodes", "web", "rates", "fail", 25_000)).toBe(0)
      })))
})

describe("aws.sns: message size", () => {
  it("refuses messages over its size limit, which can be raised to 1 MiB", async () => {
    const big = await run({ load: { rps: 10, payload: 300 }, subscribers: [A] }, 5_000)
    expect(mean(big, "nodes", "web", "rates", "fail.Rejected", 1_000)).toBeGreaterThan(8)
    const raised = await run({ topic: { maxMessageSize: 512 }, load: { rps: 10, payload: 300 }, subscribers: [A] }, 5_000)
    expect(mean(raised, "nodes", "web", "rates", "fail", 1_000)).toBe(0)
  })

  it("accepts exactly 256 KB and refuses a byte more", async () => {
    const exact = await run({ load: { rps: 10, payload: 256 }, subscribers: [A] }, 5_000)
    expect(mean(exact, "nodes", "web", "rates", "fail", 1_000)).toBe(0)
    const over = await run({ load: { rps: 10, payload: 256.01 }, subscribers: [A] }, 5_000)
    expect(mean(over, "nodes", "web", "rates", "fail.Rejected", 1_000)).toBeGreaterThan(8)
  })

  it("holds a topic with more than 100 subscriptions at 256 KB, because AWS only allows a larger size with 100 or fewer", async () => {
    const many = (n: number): ReadonlyArray<Subscriber> => Array.from({ length: n }, (_, i) => ({ id: `s${i}` }))
    const shape = (n: number): Shape => ({ topic: { maxMessageSize: 512 }, load: { rps: 5, payload: 300 }, subscribers: many(n) })
    expect(mean(await run(shape(100), 4_000), "nodes", "web", "rates", "fail", 1_000)).toBe(0)
    expect(mean(await run(shape(101), 4_000), "nodes", "web", "rates", "fail.Rejected", 1_000)).toBeGreaterThan(3)
    expect((await state(shape(101), 2_000)).maxMessageSize).toBe(256)
    expect((await state(shape(100), 2_000)).maxMessageSize).toBe(512)
  })

  it("takes a live change of the maximum message size", () =>
    sim(design({ load: { rps: 10, payload: 300 }, subscribers: [A] }), (s) =>
      Effect.gen(function*() {
        const before = yield* s.advanceTo(5_000)
        expect(mean(before, "nodes", "web", "rates", "fail.Rejected", 2_000)).toBeGreaterThan(8)
        yield* s.configureNode("topic", { maxMessageSize: 400 })
        const after = yield* s.advanceTo(10_000)
        expect(mean(after, "nodes", "web", "rates", "fail", 7_000)).toBe(0)
      })))

  it("sends the JSON envelope only when raw message delivery is off", async () => {
    // A 1 KB message to an endpoint that refuses more than 1.5 KB: it fits raw, and does not fit wrapped.
    const to = (raw: boolean): Shape => ({ load: { rps: 10, payload: 1 }, subscribers: [{ id: "a", settings: { ...quick, maxPayload: 1.5 }, edge: { rawMessageDelivery: raw } }] })
    expect(mean(await run(to(true), 10_000), "nodes", "a", "rates", "ok", 3_000)).toBeCloseTo(10, 0)
    const wrapped = await run(to(false), 10_000)
    expect(mean(wrapped, "nodes", "a", "rates", "ok", 3_000)).toBe(0)
    expect(mean(wrapped, "nodes", "a", "rates", "fail.Rejected", 3_000)).toBeGreaterThan(8)
  })
})

describe("aws.sns: FIFO topics", () => {
  it("limits a FIFO topic to 300 messages a second per message group", async () => {
    const all = await run({ topic: { kind: "fifo" }, load: { rps: 600, messageGroups: 1 }, subscribers: [A] }, 20_000)
    expect(mean(all, "nodes", "web", "rates", "ok", 5_000)).toBeCloseTo(300, -2)
  })

  it("treats publishes with no message group as one group", async () => {
    const all = await run({ topic: { kind: "fifo" }, load: { rps: 600 }, subscribers: [A] }, 20_000)
    expect(mean(all, "nodes", "web", "rates", "ok", 5_000)).toBeCloseTo(300, -2)
  })

  it("limits the topic to 3,000 a second unless message group throughput scope is on", async () => {
    const at = (fifoThroughput: string) => run({ topic: { kind: "fifo", fifoThroughput }, load: { rps: 4_500, messageGroups: 100 }, subscribers: [A] }, 8_000)
    expect(mean(await at("topic"), "nodes", "web", "rates", "ok", 3_000)).toBeCloseTo(3_000, -2)
    expect(mean(await at("messageGroup"), "nodes", "web", "rates", "ok", 3_000)).toBeCloseTo(4_500, -2)
  })

  it("limits the topic to 20 MB a second by size", async () => {
    // 100 messages a second of 400 KB would be 40 MB/s, so about half get through (burst aside).
    const all = await run({ topic: { kind: "fifo", maxMessageSize: 512 }, load: { rps: 100, payload: 400, messageGroups: 50 }, subscribers: [A] }, 20_000)
    const ok = mean(all, "nodes", "web", "rates", "ok", 10_000)
    expect(ok).toBeGreaterThan(40)
    expect(ok).toBeLessThan(60)
  })

  it("delivers one message of a group at a time to each subscriber, groups side by side", async () => {
    // The endpoint takes 100 ms. One group is a serial lane: 10 a second however fast messages arrive. Ten groups run alongside.
    const slow = { id: "a", settings: { latency: { mean: 100, cv: 0 } }, edge: { latency: { mean: 1, cv: 0 } } }
    const one = await run({ topic: { kind: "fifo" }, load: { rps: 50, messageGroups: 1 }, subscribers: [slow] }, 20_000)
    expect(mean(one, "nodes", "a", "rates", "ok", 8_000)).toBeCloseTo(10, 0)
    const ten = await run({ topic: { kind: "fifo" }, load: { rps: 50, messageGroups: 10 }, subscribers: [slow] }, 20_000)
    expect(mean(ten, "nodes", "a", "rates", "ok", 8_000)).toBeCloseTo(50, -1)
  })

  it("does not order a standard topic: the same load is not serialised", async () => {
    const slow = { id: "a", settings: { latency: { mean: 100, cv: 0 } }, edge: { latency: { mean: 1, cv: 0 } } }
    const all = await run({ load: { rps: 50, messageGroups: 1 }, subscribers: [slow] }, 20_000)
    expect(mean(all, "nodes", "a", "rates", "ok", 8_000)).toBeCloseTo(50, -1)
  })

  it("lets a failing subscriber hold up only its own groups' messages, not the other subscribers'", async () => {
    const stuck = { id: "stuck", settings: { errorRate: 1, latency: { mean: 10, cv: 0 } } }
    const all = await run({ topic: { kind: "fifo" }, load: { rps: 50, messageGroups: 5 }, subscribers: [A, stuck] }, 30_000)
    expect(mean(all, "nodes", "a", "rates", "ok", 10_000)).toBeCloseTo(50, -1)
  })

  it("leaves no lane behind for a group once its messages are delivered", async () => {
    // A thousand groups at a time, each used a few times: the number of open lanes tracks what is in flight, not what has been seen.
    const all = await run({ topic: { kind: "fifo" }, load: { rps: 200, messageGroups: 1_000 }, subscribers: [A] }, 30_000)
    expect(mean(all, "nodes", "topic", "gauges", "openGroups", 10_000)).toBeLessThan(10)
    const stuck = await state({ topic: { kind: "fifo" }, load: { rps: 100, messageGroups: 20 }, subscribers: [{ id: "a", settings: { errorRate: 1, latency: { mean: 10, cv: 0 } } }] }, 30_000)
    expect(stuck.openGroups).toBe(20) // every group is blocked behind its first failing message
  })

  it("drops a duplicate publish when deduplication is on: a retry after a timeout is acknowledged but not delivered twice", async () => {
    // The publish takes 2 s but the publisher gives up after 100 ms and tries again: SNS accepts both.
    const shape = (deduplication: boolean): Shape => ({
      topic: { kind: "fifo", deduplication, publishLatency: { mean: 2_000, cv: 0 } },
      load: { rps: 5, messageGroups: 20 },
      publishEdge: { timeout: 100, retry: { maxAttempts: 2, backoff: 0, jitter: false } },
      subscribers: [A]
    })
    const on = await run(shape(true), 40_000)
    const off = await run(shape(false), 40_000)
    expect(mean(on, "nodes", "topic", "rates", "delivered", 15_000)).toBeCloseTo(5, 0)
    expect(mean(on, "nodes", "topic", "rates", "duplicates", 15_000)).toBeCloseTo(5, 0)
    expect(mean(off, "nodes", "topic", "rates", "delivered", 15_000)).toBeCloseTo(10, 0)
  })
})

describe("aws.sns: delivery retries", () => {
  it("keeps retrying a failing subscriber until the message gets through", async () => {
    const flaky = { id: "flaky", settings: { errorRate: 0.5, latency: { mean: 10, cv: 0 } } }
    const all = await run({ load: { rps: 20 }, subscribers: [flaky] }, 40_000)
    expect(mean(all, "nodes", "topic", "rates", "delivered", 10_000)).toBeCloseTo(20, -1) // nothing lost
    expect(mean(all, "nodes", "topic", "rates", "undelivered", 0)).toBe(0)
    expect(mean(all, "nodes", "flaky", "rates", "in", 10_000)).toBeGreaterThan(30) // roughly two attempts each
  })

  it("follows the subscription's delivery policy: with three attempts a dead endpoint is given up on", async () => {
    const dead = { id: "dead", settings: { errorRate: 1, latency: { mean: 10, cv: 0 } }, edge: { retry: { maxAttempts: 3, backoff: "100 millis", jitter: false } } }
    const all = await run({ load: { rps: 20 }, subscribers: [dead] }, 20_000)
    expect(mean(all, "nodes", "topic", "rates", "undelivered", 10_000)).toBeCloseTo(20, -1)
    expect(mean(all, "nodes", "topic", "rates", "delivered", 0)).toBe(0)
    expect(mean(all, "nodes", "dead", "rates", "in", 10_000)).toBeCloseTo(60, -1) // three attempts each
  })

  it("does not retry what the endpoint refuses outright (a client error)", async () => {
    const strict = { id: "strict", settings: { ...quick, maxPayload: 0.5 }, edge: { retry: { maxAttempts: 5 } } }
    const all = await run({ load: { rps: 20, payload: 1 }, subscribers: [strict] }, 15_000)
    expect(mean(all, "nodes", "strict", "rates", "in", 5_000)).toBeCloseTo(20, -1) // one attempt each
    expect(mean(all, "nodes", "topic", "rates", "undelivered", 5_000)).toBeCloseTo(20, -1)
  })

  it("bounds what it remembers for a subscriber that never answers, and counts the rest as overflow", async () => {
    const stuck = { id: "stuck", settings: { errorRate: 1, latency: { mean: 10, cv: 0 } } }
    const s = await state({ topic: { maxPendingPerSubscription: 500 }, load: { rps: 100 }, subscribers: [A, stuck] }, 60_000)
    const pendingOf = (node: string): number => s.backlog.find((b: { node: string }) => b.node === node).pending
    expect(pendingOf("stuck")).toBe(500)
    expect(pendingOf("a")).toBeLessThan(10) // only what is in flight right now
    expect(s.pending).toBe(pendingOf("stuck") + pendingOf("a"))
    expect(s.overflow).toBeGreaterThan(1_000)
    expect(s.undelivered).toBeGreaterThanOrEqual(s.overflow)
  })

  it("takes a live change of the pending limit", () =>
    sim(design({ topic: { maxPendingPerSubscription: 200 }, load: { rps: 100 }, subscribers: [{ id: "stuck", settings: { errorRate: 1, latency: quick.latency } }] }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(20_000)
        expect(((yield* s.probe("topic")).state as { pending: number }).pending).toBe(200)
        yield* s.configureNode("topic", { maxPendingPerSubscription: 50 })
        yield* s.advanceTo(40_000)
        expect(((yield* s.probe("topic")).state as { pending: number }).pending).toBeLessThanOrEqual(200)
      })))
})

describe("aws.sns: dead-letter queue", () => {
  const dead = (edge: Record<string, unknown>): Subscriber => ({ id: "dead", settings: { errorRate: 1, latency: { mean: 10, cv: 0 } }, edge: { retry: { maxAttempts: 2, backoff: "50 millis", jitter: false }, ...edge } })

  it("moves a message whose retries are used up to the dead-letter queue", async () => {
    const all = await run({ load: { rps: 20 }, subscribers: [dead({ deadLetterQueue: true })], dlq: true }, 20_000)
    expect(mean(all, "nodes", "topic", "rates", "undelivered", 10_000)).toBeCloseTo(20, -1)
    expect(mean(all, "nodes", "topic", "rates", "redriven", 10_000)).toBeCloseTo(20, -1)
    expect(mean(all, "nodes", "dlq", "gauges", "depth", 15_000)).toBeGreaterThan(200)
  })

  it("discards it when the subscription has no dead-letter queue", async () => {
    const all = await run({ load: { rps: 20 }, subscribers: [dead({})], dlq: true }, 20_000)
    expect(mean(all, "nodes", "topic", "rates", "undelivered", 10_000)).toBeCloseTo(20, -1)
    expect(mean(all, "nodes", "topic", "rates", "redriven", 0)).toBe(0)
    expect(mean(all, "nodes", "dlq", "gauges", "depth", 15_000)).toBe(0)
  })

  it("counts a redrive that has nowhere to go as failed", async () => {
    const all = await run({ load: { rps: 20 }, subscribers: [dead({ deadLetterQueue: true })] }, 20_000)
    expect(mean(all, "nodes", "topic", "rates", "redriveFailed", 10_000)).toBeCloseTo(20, -1)
    expect(mean(all, "nodes", "topic", "rates", "redriven", 0)).toBe(0)
  })

  it("sends client errors straight to the dead-letter queue without retrying", async () => {
    const strict: Subscriber = { id: "strict", settings: { ...quick, maxPayload: 0.5 }, edge: { deadLetterQueue: true, retry: { maxAttempts: 5 } } }
    const all = await run({ load: { rps: 20, payload: 1 }, subscribers: [strict], dlq: true }, 15_000)
    expect(mean(all, "nodes", "strict", "rates", "in", 5_000)).toBeCloseTo(20, -1)
    expect(mean(all, "nodes", "topic", "rates", "redriven", 5_000)).toBeCloseTo(20, -1)
  })
})

describe("aws.sns: subscription filter policies", () => {
  it("delivers only the share of messages the filter policy matches, and counts the rest as filtered out", async () => {
    const all = await run({ load: { rps: 200 }, subscribers: [{ id: "some", settings: quick, edge: { filterMatch: 0.25 } }, { id: "all", settings: quick }] }, 30_000)
    expect(mean(all, "nodes", "some", "rates", "ok", 10_000)).toBeCloseTo(50, -1)
    expect(mean(all, "nodes", "all", "rates", "ok", 10_000)).toBeCloseTo(200, -1)
    expect(mean(all, "nodes", "topic", "rates", "filteredOut", 10_000)).toBeCloseTo(150, -1)
    expect(mean(all, "nodes", "topic", "rates", "undelivered", 0)).toBe(0) // filtering is not failing
  })

  it("a subscription that matches nothing receives nothing", async () => {
    const all = await run({ load: { rps: 50 }, subscribers: [{ id: "none", settings: quick, edge: { filterMatch: 0 } }] }, 10_000)
    expect(mean(all, "nodes", "none", "rates", "in", 0)).toBe(0)
  })

  it("takes a live change of an edge: the next publish is filtered by the new policy", () =>
    sim(design({ load: { rps: 100 }, subscribers: [A] }), (s) =>
      Effect.gen(function*() {
        const before = yield* s.advanceTo(10_000)
        expect(mean(before, "nodes", "a", "rates", "ok", 5_000)).toBeCloseTo(100, -1)
        yield* s.configureEdge("topic.out->a", { filterMatch: 0 })
        const after = yield* s.advanceTo(20_000)
        expect(mean(after, "nodes", "a", "rates", "in", 12_000)).toBe(0)
      })))
})

describe("aws.sns: delivery throttle and latency", () => {
  it("holds deliveries back to maxReceivesPerSecond without failing or retrying them", async () => {
    const all = await run({ load: { rps: 50 }, subscribers: [{ id: "a", settings: quick, edge: { maxReceivesPerSecond: 10 } }] }, 20_000)
    expect(mean(all, "nodes", "a", "rates", "in", 5_000)).toBeCloseTo(10, 0)
    expect(mean(all, "nodes", "a", "rates", "fail", 0)).toBe(0)
    expect(mean(all, "nodes", "topic", "rates", "undelivered", 0)).toBe(0)
    expect(mean(all, "nodes", "topic", "gauges", "pending", 15_000)).toBeGreaterThan(300) // the backlog is visible
  })

  it("adds the delivery latency before a subscriber sees the message", async () => {
    const all = await run({ topic: { deliveryLatency: { mean: 500, cv: 0 } }, load: { rps: 20 }, subscribers: [A] }, 20_000)
    const age = all.flatMap((f) => (f.nodes.a?.dist.age ? [f.nodes.a.dist.age.p50] : []))
    expect(Math.min(...age.slice(10))).toBeGreaterThan(500)
    expect(mean(all, "nodes", "a", "rates", "ok", 5_000)).toBeCloseTo(20, 0)
  })
})

describe("aws.sns: account audit", () => {
  const member = (id: string, kind: string) => ({ id, name: id, type: "aws.sns", config: { kind } })
  const account = { snsStandardTopics: 2, snsFifoTopics: 1 }
  it("warns when a region has more topics than the account allows", () => {
    const codes = (members: ReadonlyArray<ReturnType<typeof member>>) => audit("us-east-1", members, account).map((d) => d.code)
    expect(codes([member("a", "standard"), member("b", "standard"), member("c", "fifo")])).toEqual([])
    expect(codes([member("a", "standard"), member("b", "standard"), member("c", "standard")])).toEqual(["sns-standard-topics"])
    expect(codes([member("a", "fifo"), member("b", "fifo")])).toEqual(["sns-fifo-topics"])
  })
})
