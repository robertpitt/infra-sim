import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../../../Builder.ts"
import { dist, frames, mean, sim } from "../../../testing.ts"
import { audit } from "../Audit.ts"
import { putEventsRequests } from "../EventBus.ts"
import { type Outcomes, Pacer } from "../Delivery.ts"

type BusTotals = Outcomes & { readonly pending: number; readonly quotaWait: number }
import { invocationRate, putEventsRate, rulesPerBus } from "../Quotas.ts"

interface Target {
  readonly id: string
  readonly type?: string
  readonly settings?: Record<string, unknown>
  readonly edge?: Record<string, unknown>
}

interface Shape {
  readonly bus?: Record<string, unknown>
  readonly load?: Record<string, unknown>
  readonly publishEdge?: Record<string, unknown>
  readonly targets: ReadonlyArray<Target>
  readonly region?: string
  readonly account?: Record<string, unknown>
  /** Wire a dead-letter queue to the bus. */
  readonly dlq?: boolean
  readonly seed?: number
}

const quick = { latency: { mean: 10, cv: 0 } }

/** clients -> bus -> targets [-> dead-letter queue] */
const design = (s: Shape) => {
  const b = Builder.make("eventbridge", { seed: s.seed ?? 4 })
  const region = s.region ?? "us-east-1"
  const web = b.add("common.client", { id: "web", settings: { arrival: "constant", ...s.load } })
  const bus = b.add("aws.eventbridge", { id: "bus", region, settings: s.bus ?? {} })
  b.connect(web, bus, s.publishEdge)
  for (const t of s.targets) {
    const aws = t.type?.startsWith("aws.") === true
    b.connect(bus, b.add(t.type ?? "common.http-endpoint", { id: t.id, ...(aws ? { region } : {}), settings: t.settings ?? quick }), t.edge)
  }
  if (s.dlq === true) b.connect(bus.port("dlq"), b.add("aws.sqs", { id: "dlq", region }))
  if (s.account !== undefined) b.account(`aws:${region}`, s.account)
  return b.build()
}

const run = (s: Shape, ms: number) => frames(design(s), ms)
const probe = async (s: Shape, ms: number, node = "bus") =>
  sim(design(s), (sm) => Effect.flatMap(sm.advanceTo(ms), () => sm.probe(node))).then((p) => p.state as Record<string, any>)

/** A target that always fails with a 500. */
const broken = (id: string, edge: Record<string, unknown> = {}): Target => ({ id, settings: { ...quick, errorRate: 1 }, edge })

describe("aws.eventbridge: rules and targets", () => {
  it("invokes every matching target, and answers the publisher before delivering", async () => {
    const slow = { latency: { mean: 2_000, cv: 0 } }
    const all = await run({ load: { rps: 100 }, targets: ["a", "b", "c"].map((id) => ({ id, settings: slow })) }, 20_000)
    for (const id of ["a", "b", "c"]) expect(mean(all, "nodes", id, "rates", "in", 5_000)).toBeCloseTo(100, -1)
    expect(mean(all, "nodes", "bus", "rates", "invocations", 5_000)).toBeCloseTo(300, -1)
    expect(mean(all, "nodes", "bus", "rates", "matched", 5_000)).toBeCloseTo(100, -1)
    // The publisher waits for PutEvents and the network, never for the 2-second targets.
    expect(dist(all, "web", "latency", 5_000).p99).toBeLessThan(100)
  })

  it("lets through the share of events a rule matches", async () => {
    const all = await run({ load: { rps: 200, arrival: "poisson" }, targets: [{ id: "a", edge: { match: 0.25 } }, { id: "b" }] }, 30_000)
    expect(mean(all, "nodes", "a", "rates", "in", 5_000) / 200).toBeCloseTo(0.25, 1)
    expect(mean(all, "nodes", "b", "rates", "in", 5_000)).toBeCloseTo(200, -1)
  })

  it("gives the targets of one rule the same events, and a different rule its own draw", () =>
    sim(
      design({
        load: { rps: 100 },
        targets: [
          { id: "a", edge: { rule: "orders", match: 0.5 } },
          { id: "b", edge: { rule: "orders", match: 0.5 } },
          { id: "c", edge: { rule: "other", match: 0.5 } }
        ]
      }),
      (s) =>
        Effect.gen(function*() {
          yield* s.advanceTo(20_000)
          // Stop publishing and let every delivery land before counting.
          yield* s.configureNode("web", { rps: 0 })
          yield* s.advanceTo(25_000)
          const [a, b, c] = yield* Effect.forEach(["a", "b", "c"], (id) => Effect.map(s.probe(id), (p) => (p.state as { served: number }).served))
          expect(a).toBe(b)
          expect(Math.abs(c! - a!)).toBeGreaterThan(5)
          expect(a! / 2_000).toBeCloseTo(0.5, 1)
          const bus = (yield* s.probe("bus")).state as { rules: unknown }
          expect(bus.rules).toEqual([
            { rule: "orders", active: true, targets: ["a", "b"], ignored: [] },
            { rule: "other", active: true, targets: ["c"], ignored: [] }
          ])
        })
    ))

  it("gives a rule five targets at most: a sixth is left out", async () => {
    const targets = ["t1", "t2", "t3", "t4", "t5", "t6"].map((id) => ({ id, edge: { rule: "fan" } }))
    const state = await probe({ load: { rps: 20 }, targets }, 10_000)
    expect(state.rules[0].targets).toHaveLength(5)
    expect(state.rules[0].ignored).toEqual(["t6"])
    const sixth = await probe({ load: { rps: 20 }, targets }, 10_000, "t6")
    expect(sixth.served).toBe(0)
  })

  it("leaves out rules past the account's rules-per-bus quota", async () => {
    const state = await probe({ load: { rps: 20 }, targets: [{ id: "a" }, { id: "b" }, { id: "c" }], account: { eventBridgeRulesPerBus: 2 } }, 5_000)
    expect(state.rules.map((r: { active: boolean }) => r.active)).toEqual([true, true, false])
    expect((await probe({ load: { rps: 20 }, targets: [{ id: "a" }, { id: "b" }, { id: "c" }], account: { eventBridgeRulesPerBus: 2 } }, 5_000, "c")).served).toBe(0)
  })

  it("counts events no rule matches, and fails nothing on a bus with no rules", async () => {
    const all = await run({ load: { rps: 50 }, targets: [] }, 10_000)
    expect(mean(all, "nodes", "web", "rates", "fail", 2_000)).toBe(0)
    expect(mean(all, "nodes", "bus", "rates", "unmatched", 2_000)).toBeCloseTo(50, -1)
  })

  it("invokes Lambda targets asynchronously, so a slow function never slows the publisher", () =>
    sim(
      design({ load: { rps: 10 }, targets: [{ id: "fn", type: "aws.lambda", settings: { memory: 1769, duration: { mean: 3_000, cv: 0 }, timeout: "10 seconds" } }] }),
      (s) =>
        Effect.gen(function*() {
          const all = yield* s.advanceTo(20_000)
          const fn = (yield* s.probe("fn")).state as { asyncPending: number }
          expect(fn.asyncPending).toBeGreaterThan(20)
          expect(dist(all, "web", "latency", 2_000).p99).toBeLessThan(100)
        })
    ))

  it("delivers about 40 ms after ingestion on average, with a P99 near AWS's 129 ms", async () => {
    const all = await run({ load: { rps: 200, arrival: "poisson" }, targets: [{ id: "a" }] }, 30_000)
    const start = dist(all, "bus", "startLatency", 2_000)
    expect(start.mean).toBeGreaterThan(30)
    expect(start.mean).toBeLessThan(50)
    expect(start.p99).toBeGreaterThan(90)
    expect(start.p99).toBeLessThan(170)
  })

  it("is deterministic: the same design and seed give the same frames", async () => {
    const shape: Shape = { load: { rps: 80, arrival: "poisson" }, targets: [{ id: "a", settings: { errorRate: 0.3, latency: { mean: 10, cv: 0.5 } }, edge: { match: 0.5, retryPolicy: { maxRetries: 3 } } }] }
    expect(await run(shape, 10_000)).toEqual(await run(shape, 10_000))
  })
})

describe("aws.eventbridge: PutEvents", () => {
  it("throttles PutEvents at the region's quota: 10,000/s in us-east-1, 600/s in eu-north-1", async () => {
    expect(mean(await run({ load: { rps: 1_000 }, targets: [{ id: "a" }] }, 10_000), "nodes", "web", "rates", "fail", 3_000)).toBe(0)
    const small = await run({ load: { rps: 1_000 }, targets: [{ id: "a" }], region: "eu-north-1" }, 10_000)
    expect(mean(small, "nodes", "web", "rates", "ok", 3_000)).toBeCloseTo(600, -2)
    expect(mean(small, "nodes", "web", "rates", "fail.Throttled", 3_000)).toBeGreaterThan(350)
    // A quota is a setting: raise it and nothing is throttled.
    const raised = await run({ load: { rps: 1_000 }, targets: [{ id: "a" }], region: "eu-north-1", account: { eventBridgePutEventsRate: 2_000 } }, 10_000)
    expect(mean(raised, "nodes", "web", "rates", "fail", 3_000)).toBe(0)
  })

  it("has AWS's published regional quotas", () => {
    expect(["us-east-1", "us-east-2", "us-west-1", "eu-west-2", "ap-south-1", "eu-north-1", "af-south-1"].map(putEventsRate)).toEqual([10_000, 2_400, 1_200, 1_200, 600, 600, 400])
    expect(["us-west-2", "eu-central-1", "ap-southeast-2", "sa-east-1", "me-south-1"].map(invocationRate)).toEqual([18_750, 4_500, 2_250, 1_100, 750])
    expect(["us-east-1", "af-south-1", "eu-south-1"].map(rulesPerBus)).toEqual([300, 100, 100])
  })

  it("takes a live change of the PutEvents quota on the next request", () =>
    sim(design({ load: { rps: 400 }, targets: [{ id: "a" }], account: { eventBridgePutEventsRate: 100 } }), (s) =>
      Effect.gen(function*() {
        const before = yield* s.advanceTo(10_000)
        expect(mean(before, "nodes", "web", "rates", "ok", 5_000)).toBeCloseTo(100, -1)
        yield* s.configureAccount("aws:us-east-1", { eventBridgePutEventsRate: 5_000 })
        const after = yield* s.advanceTo(20_000)
        expect(mean(after, "nodes", "web", "rates", "fail", 12_000)).toBe(0)
      })))

  it("refuses an entry over 1 MB, which retrying cannot help", async () => {
    const all = await run({ load: { rps: 5, payload: 1_100 }, targets: [{ id: "a" }] }, 5_000)
    expect(mean(all, "nodes", "web", "rates", "fail.Rejected", 1_000)).toBeCloseTo(5, 0)
    const fits = await run({ load: { rps: 5, payload: 1_000 }, targets: [{ id: "a" }] }, 5_000)
    expect(mean(fits, "nodes", "web", "rates", "fail", 1_000)).toBe(0)
  })

  it("packs a batch into requests of at most 10 entries and 1 MB", () => {
    expect(putEventsRequests(1, 1_024)).toBe(1)
    expect(putEventsRequests(10, 1_024)).toBe(1)
    expect(putEventsRequests(11, 1_024)).toBe(2)
    expect(putEventsRequests(200, 1_024)).toBe(20)
    // 300 KB entries: three fit in a request.
    expect(putEventsRequests(10, 300 * 1024)).toBe(4)
    expect(putEventsRequests(3, 0)).toBe(1)
  })
})

describe("aws.eventbridge: retries and dead-letter queues", () => {
  it("retries a failing target up to the policy's limit, then dead-letters the event", async () => {
    const all = await run({ load: { rps: 20 }, targets: [broken("a", { retryPolicy: { maxRetries: 3 }, deadLetterQueue: true })], dlq: true, bus: { retryBackoff: { initial: 100, max: 400 } } }, 30_000)
    // Four attempts per event, then the queue.
    expect(mean(all, "nodes", "a", "rates", "in", 10_000)).toBeCloseTo(80, -1)
    expect(mean(all, "nodes", "bus", "rates", "retries", 10_000)).toBeCloseTo(60, -1)
    expect(mean(all, "nodes", "bus", "rates", "deadLettered", 10_000)).toBeCloseTo(20, 0)
    expect(mean(all, "nodes", "dlq", "rates", "in", 10_000)).toBeCloseTo(20, 0)
    expect(mean(all, "nodes", "bus", "rates", "dropped", 10_000)).toBe(0)
  })

  it("drops what it gives up on when the target has no dead-letter queue", async () => {
    const state = await probe({ load: { rps: 10 }, targets: [broken("a", { retryPolicy: { maxRetries: 0 } })] }, 10_000)
    expect(state.failed).toBeGreaterThan(90)
    expect(state.dropped).toBe(state.failed)
    expect(state.retries).toBe(0)
  })

  it("does not retry an error that retrying cannot fix", async () => {
    const state = await probe({ load: { rps: 10, payload: 20 }, targets: [{ id: "a", settings: { ...quick, maxPayload: 10 }, edge: { deadLetterQueue: true } }], dlq: true }, 10_000)
    expect(state.retries).toBe(0)
    expect(state.failed).toBeGreaterThan(90)
    expect(state.deadLettered).toBe(state.failed)
  })

  it("stops retrying when the event reaches its maximum age, however many retries are left", () =>
    sim(design({ load: { rps: 10 }, targets: [broken("a", { retryPolicy: { maxEventAge: "60 seconds" }, deadLetterQueue: true })], dlq: true, bus: { retryBackoff: { initial: 1_000, max: 5_000 } } }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(55_000)
        const early = (yield* s.probe("bus")).state as BusTotals
        expect(early.expired).toBe(0)
        yield* s.advanceTo(150_000)
        const late = (yield* s.probe("bus")).state as BusTotals
        expect(late.expired).toBeGreaterThan(800)
        expect(late.deadLettered).toBe(late.expired)
        // No event is held much past a minute: what is pending is at most about a minute's worth.
        expect(late.pending).toBeLessThan(700)
      })))

  it("retries for up to 24 hours by default, with backoff that spreads 185 retries over about a day", () =>
    sim(design({ load: { rps: 0.01 }, targets: [broken("a", { deadLetterQueue: true })], dlq: true }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(23 * 3_600_000)
        const during = (yield* s.probe("bus")).state as BusTotals
        yield* s.advanceTo(25 * 3_600_000 + 60_000)
        const after = (yield* s.probe("bus")).state as BusTotals
        // The first events (one every 100 s) have used up their retries or their day; a few are still pending.
        expect(during.failed).toBeLessThan(after.failed)
        expect(after.retries / after.invocations).toBeGreaterThan(100)
        expect(after.retries / after.invocations).toBeLessThanOrEqual(185)
      })), 60_000)

  it("counts a dead-letter queue that is not wired as a failure to dead-letter", async () => {
    const state = await probe({ load: { rps: 10 }, targets: [broken("a", { retryPolicy: { maxRetries: 0 }, deadLetterQueue: true })] }, 5_000)
    expect(state.deadLetterFailed).toBe(state.failed)
  })

  it("bounds what a stuck target can hold", async () => {
    const state = await probe({ load: { rps: 100 }, targets: [broken("a")], bus: { maxPendingPerTarget: 200 } }, 20_000)
    expect(state.pending).toBeLessThanOrEqual(200)
    expect(state.overflow).toBeGreaterThan(1_000)
  })
})

describe("aws.eventbridge: the invocation quota", () => {
  it("delays invocations past the region's quota instead of failing them", () =>
    sim(design({ load: { rps: 50 }, targets: ["a", "b", "c", "d"].map((id) => ({ id })), account: { eventBridgeInvocationRate: 100 } }), (s) =>
      Effect.gen(function*() {
        const all = yield* s.advanceTo(30_000)
        // 200 invocations a second are created; 100 a second get through, and nothing fails.
        const delivered = ["a", "b", "c", "d"].reduce((n, id) => n + mean(all, "nodes", id, "rates", "in", 10_000), 0)
        expect(delivered).toBeCloseTo(100, -1)
        expect(mean(all, "nodes", "bus", "rates", "delayed", 10_000)).toBeGreaterThan(150)
        expect(mean(all, "nodes", "bus", "rates", "failed", 0)).toBe(0)
        expect(mean(all, "nodes", "web", "rates", "fail", 0)).toBe(0)
        const state = (yield* s.probe("bus")).state as BusTotals
        expect(state.quotaWait).toBeGreaterThan(10_000)
      })))

  it("shares one quota between every bus in the region", async () => {
    const b = Builder.make("two-buses", { seed: 3 })
    const web = b.add("common.client", { id: "web", settings: { rps: 100, arrival: "constant" } })
    for (const id of ["bus1", "bus2"]) {
      const bus = b.add("aws.eventbridge", { id, region: "us-east-1" })
      b.connect(web, bus, { weight: 1 })
      b.connect(bus, b.add("common.http-endpoint", { id: `${id}-t`, settings: quick }))
    }
    b.account("aws:us-east-1", { eventBridgeInvocationRate: 60 })
    const all = await frames(b.build(), 30_000)
    const total = mean(all, "nodes", "bus1-t", "rates", "in", 10_000) + mean(all, "nodes", "bus2-t", "rates", "in", 10_000)
    expect(total).toBeCloseTo(60, -1)
  })

  it("holds an API destination to its rate and gives each request 5 seconds", async () => {
    const paced = await run({ load: { rps: 50 }, targets: [{ id: "api", edge: { apiDestination: { enabled: true, rate: 10 } } }] }, 30_000)
    expect(mean(paced, "nodes", "api", "rates", "in", 10_000)).toBeCloseTo(10, 0)
    const slow = await probe({ load: { rps: 5 }, targets: [{ id: "api", settings: { latency: { mean: 8_000, cv: 0 } }, edge: { apiDestination: { enabled: true }, retryPolicy: { maxRetries: 1 } } }], bus: { retryBackoff: { initial: 100, max: 100 } } }, 30_000)
    expect(slow.delivered).toBe(0)
    expect(slow.retries).toBeGreaterThan(50)
    // Without the API destination the edge's own 30 s timeout applies and 8 s is fine.
    const plain = await probe({ load: { rps: 5 }, targets: [{ id: "api", settings: { latency: { mean: 8_000, cv: 0 } } }] }, 30_000)
    expect(plain.delivered).toBeGreaterThan(90)
  })

  it("holds retries to an API destination's rate too: the rate is what reaches the endpoint", async () => {
    // 20 events a second to an endpoint that fails them all, at a rate of 30: first tries and retries share the 30.
    const all = await run({ load: { rps: 20 }, targets: [broken("api", { apiDestination: { enabled: true, rate: 30 } })], bus: { retryBackoff: { initial: 100, max: 1_000 } } }, 30_000)
    expect(mean(all, "nodes", "api", "rates", "in", 10_000)).toBeLessThan(32)
    expect(mean(all, "nodes", "api", "rates", "in", 10_000)).toBeGreaterThan(25)
  })

  it("paces exactly at the rate once in debt", () => {
    const pacer = new Pacer()
    const waits = Array.from({ length: 30 }, () => pacer.take(0, 10))
    expect(waits.slice(0, 10)).toEqual(Array(10).fill(0))
    expect(waits[10]).toBeCloseTo(100, 6)
    expect(waits[29]).toBeCloseTo(2_000, 6)
    expect(pacer.wait(2_000, 10)).toBeCloseTo(100, 6)
  })
})

describe("aws.eventbridge: audit", () => {
  it("warns when a region has more buses than the account allows", () => {
    const members = Array.from({ length: 3 }, (_, i) => ({ id: `b${i}`, type: "aws.eventbridge", config: {} }))
    expect(audit("us-east-1", members as never, { eventBridgeBuses: 2 } as never)).toHaveLength(1)
    expect(audit("us-east-1", members as never, { eventBridgeBuses: 100 } as never)).toHaveLength(0)
  })
})
