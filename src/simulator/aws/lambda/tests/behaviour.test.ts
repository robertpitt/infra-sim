import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../../../Builder.ts"
import { dist, frames, mean, sim } from "../../../testing.ts"

type Doc = ReturnType<Builder.Builder["build"]>
interface Probe {
  readonly concurrent: number
  readonly environments: number
  readonly provisioned: number
  readonly limit: number
  readonly invocations: number
  readonly coldStarts: number
  readonly throttles: number
  readonly timeouts: number
  readonly errors: number
  readonly asyncPending: number
  readonly asyncRetries: number
  readonly asyncSucceeded: number
  readonly asyncFailed: number
  readonly destinationFailures: number
}

interface Shape {
  readonly fn?: Record<string, unknown>
  readonly load?: Record<string, unknown>
  readonly account?: Record<string, unknown>
  readonly edge?: Record<string, unknown>
}

/** client -> function */
const single = (s: Shape = {}): Doc => {
  const b = Builder.make("lambda", { seed: 4 })
  const web = b.add("common.client", { id: "web", settings: { arrival: "constant", ...s.load } })
  const fn = b.add("aws.lambda", { id: "fn", settings: { memory: 1769, duration: { mean: 100, cv: 0 }, ...s.fn } })
  b.connect(web, fn, s.edge)
  if (s.account !== undefined) b.account("aws:us-east-1", s.account)
  return b.build()
}

/** queue -> function, with the mapping gathering batches of ten */
const batched = (fn: Record<string, unknown>): Doc => {
  const b = Builder.make("batched", { seed: 4 })
  const web = b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 100 } })
  const q = b.add("aws.sqs", { id: "q" })
  const f = b.add("aws.lambda", { id: "fn", settings: { memory: 1769, duration: { mean: 100, cv: 0 }, ...fn } })
  b.connect(web, q)
  b.connect(q.port("deliver"), f, { batchSize: 10, batchWindow: 1_000 })
  return b.build()
}

/** Run to `ms` and report the function's probe. */
const stateAt = (doc: Doc, ms: number, id = "fn") =>
  sim(doc, (s) =>
    Effect.gen(function*() {
      const all = yield* s.advanceTo(ms)
      return { all, state: (yield* s.probe(id)).state as Probe }
    }))

const latencies = (all: Awaited<ReturnType<typeof frames>>): Array<number> => all.flatMap((f) => (f.nodes.web?.dist.latency ? [f.nodes.web.dist.latency.max] : []))

describe("aws.lambda: the Init phase and SnapStart", () => {
  it("an Init past its 10 s limit is run again inside the first invocation", async () => {
    const { all } = await stateAt(single({ load: { rps: 1 }, fn: { timeout: "60 seconds", coldStart: { init: { mean: 15_000, cv: 0 } } } }), 40_000)
    // 10 s of the failed Init, then the Init again (15 s), then the 100 ms handler.
    const slowest = Math.max(...latencies(all))
    expect(slowest).toBeGreaterThan(25_000)
    expect(slowest).toBeLessThan(25_500)
  })

  it("an Init under the limit costs just its own time", async () => {
    const { all } = await stateAt(single({ load: { rps: 1 }, fn: { coldStart: { init: { mean: 8_000, cv: 0 } } } }), 20_000)
    const slowest = Math.max(...latencies(all))
    expect(slowest).toBeGreaterThan(8_000)
    expect(slowest).toBeLessThan(8_500)
  })

  it("the repeated Init spends the function timeout, so a short timeout fails every cold start", async () => {
    const { all, state } = await stateAt(single({ load: { rps: 2 }, fn: { timeout: "3 seconds", coldStart: { init: { mean: 15_000, cv: 0 } } } }), 30_000)
    expect(state.timeouts).toBeGreaterThan(30)
    expect(mean(all, "nodes", "web", "rates", "ok", 5_000)).toBe(0)
  })

  it("SnapStart swaps Init for a much shorter Restore", async () => {
    const slow = await stateAt(single({ load: { rps: 1 }, fn: { coldStart: { init: { mean: 2_000, cv: 0 }, restore: { mean: 100, cv: 0 } } } }), 8_000)
    const snap = await stateAt(single({ load: { rps: 1 }, fn: { coldStart: { snapStart: true, init: { mean: 2_000, cv: 0 }, restore: { mean: 100, cv: 0 } } } }), 8_000)
    expect(Math.max(...latencies(slow.all))).toBeGreaterThan(2_100)
    expect(Math.max(...latencies(snap.all))).toBeLessThan(400)
    expect(snap.state.coldStarts).toBeGreaterThan(0) // it is still a new environment each time, just a cheaper one
    expect(dist(snap.all, "fn", "initDuration").mean).toBeCloseTo(100, 0)
  })

  it("SnapStart is ignored when the function has provisioned concurrency, as AWS doesn't support the two together", async () => {
    // 20 rps x 1 s needs ~20 environments; only one is provisioned, so the rest cold start with a real Init.
    const { all } = await stateAt(
      single({ load: { rps: 20 }, fn: { provisioned: 1, duration: { mean: 1_000, cv: 0 }, timeout: "10 seconds", coldStart: { snapStart: true, init: { mean: 2_000, cv: 0 }, restore: { mean: 100, cv: 0 } } } }),
      6_000
    )
    expect(Math.max(...latencies(all))).toBeGreaterThan(3_000)
  })

  it("environments are retired at their maximum lifetime, even when they stay busy", async () => {
    const lifetime = await stateAt(single({ load: { rps: 2 }, fn: { coldStart: { maxLifetime: "60 seconds" } } }), 300_000)
    const forever = await stateAt(single({ load: { rps: 2 }, fn: {} }), 300_000)
    expect(forever.state.coldStarts).toBeLessThanOrEqual(2)
    // One environment serves the trickle, and is replaced about once a minute.
    expect(lifetime.state.coldStarts).toBeGreaterThanOrEqual(4)
    expect(lifetime.state.coldStarts).toBeLessThanOrEqual(8)
  })
})

describe("aws.lambda: concurrency and rate limits", () => {
  it("with the request-rate limit on, 10 requests a second per unit of concurrency is the ceiling, however short the function", async () => {
    // 3,000 rps of 10 ms calls need only 30 concurrent executions, but the account's 100 allow just 1,000 requests a second.
    const on = await stateAt(single({ load: { rps: 3_000 }, fn: { duration: { mean: 10, cv: 0 }, rpsLimit: true }, account: { lambdaConcurrency: 100 } }), 15_000)
    const ok = mean(on.all, "nodes", "web", "rates", "ok", 5_000)
    expect(ok).toBeGreaterThan(900)
    expect(ok).toBeLessThan(1_100)
    expect(mean(on.all, "nodes", "web", "rates", "fail.Throttled", 5_000)).toBeGreaterThan(1_800)
    const off = await stateAt(single({ load: { rps: 3_000 }, fn: { duration: { mean: 10, cv: 0 } }, account: { lambdaConcurrency: 100 } }), 15_000)
    expect(mean(off.all, "nodes", "web", "rates", "fail.Throttled", 5_000)).toBe(0)
  })

  it("the request-rate limit applies to synchronous calls only", async () => {
    const { state } = await stateAt(single({ load: { rps: 3_000, invocation: "async" }, fn: { duration: { mean: 10, cv: 0 }, rpsLimit: true, coldStart: { init: { mean: 1, cv: 0 } } }, account: { lambdaConcurrency: 100 } }), 10_000)
    expect(state.throttles).toBe(0)
  })

  it("an idle function still holds back its reservation from everyone else's pool, and gives it back when it is edited", () => {
    const b = Builder.make("idle", { seed: 4 })
    const quiet = b.add("common.client", { id: "quiet", settings: { arrival: "constant", rps: 0 } })
    const busy = b.add("common.client", { id: "busy", settings: { arrival: "constant", rps: 10 } })
    b.connect(quiet, b.add("aws.lambda", { id: "reserved", settings: { reserved: { enabled: true, concurrency: 900 } } }))
    b.connect(busy, b.add("aws.lambda", { id: "fn" }))
    return sim(b.build(), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(1_000)
        expect(((yield* s.probe("fn")).state as Probe).limit).toBe(100) // 1,000 less the 900 held, and no call ever reached the reserved function
        yield* s.configureNode("reserved", { reserved: { enabled: false } })
        yield* s.advanceTo(1_100)
        expect(((yield* s.probe("fn")).state as Probe).limit).toBe(1_000)
      }))
  })

  it("raising provisioned concurrency while running allocates it after the warm-up, not at once", () => {
    // A live edit replaces the node's settings, so the edit restates the ones the design set.
    const fnSettings = { memory: 1769, duration: { mean: 100, cv: 0 }, provisionedAllocation: "5 seconds" }
    return sim(single({ load: { rps: 5 }, fn: fnSettings }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(2_000)
        yield* s.configureNode("fn", { ...fnSettings, provisioned: 5 })
        yield* s.advanceTo(4_000)
        expect(((yield* s.probe("fn")).state as Probe).provisioned).toBe(0)
        yield* s.advanceTo(9_000)
        const ready = (yield* s.probe("fn")).state as Probe
        expect(ready.provisioned).toBe(5)
        expect(ready.limit).toBe(1_000) // the shared pool, 995 after the 5 it now holds back, plus those 5
        yield* s.configureNode("fn", { ...fnSettings, provisioned: 2 })
        expect(((yield* s.probe("fn")).state as Probe).provisioned).toBe(2) // lowering is immediate
      }))
  })

  it("provisioned concurrency above the reservation is clamped to it", async () => {
    const { state } = await stateAt(single({ load: { rps: 5 }, fn: { reserved: { enabled: true, concurrency: 2 }, provisioned: 10 } }), 3_000)
    expect(state.provisioned).toBe(2)
    expect(state.limit).toBe(2)
  })
})

describe("aws.lambda: giving back what an invocation held", () => {
  it("timeouts leave nothing running: concurrency and environments return to zero once traffic stops", async () => {
    const state = await sim(single({ load: { rps: 50 }, fn: { duration: { mean: 3_000, cv: 0 }, timeout: "1 second" } }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(10_000)
        yield* s.configureNode("web", { arrival: "constant", rps: 0 })
        yield* s.advanceTo(30_000)
        return (yield* s.probe("fn")).state as Probe
      }))
    expect(state.timeouts).toBeGreaterThan(100)
    expect(state.concurrent).toBe(0)
    expect(state.environments).toBe(0)
  })

  it("a pool starved by a function that stopped is free again for another", () => {
    const b = Builder.make("pool", { seed: 4 })
    const a = b.add("common.client", { id: "a", settings: { arrival: "constant", rps: 100 } })
    const d = b.add("common.client", { id: "d", settings: { arrival: "constant", rps: 0 } })
    b.connect(a, b.add("aws.lambda", { id: "fnA", settings: { duration: { mean: 2_000, cv: 0 }, timeout: "1 second" } }))
    b.connect(d, b.add("aws.lambda", { id: "fnD", settings: { duration: { mean: 50, cv: 0 } } }))
    b.account("aws:us-east-1", { lambdaConcurrency: 10 })
    return sim(b.build(), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(10_000)
        yield* s.configureNode("a", { arrival: "constant", rps: 0 })
        yield* s.advanceTo(20_000)
        yield* s.configureNode("d", { rps: 5 })
        const all = yield* s.advanceTo(40_000)
        // Everything fnA took, timed out or abandoned, has been given back: fnD sees the whole pool.
        expect(mean(all, "nodes", "d", "rates", "fail", 25_000)).toBe(0)
        expect(mean(all, "nodes", "d", "rates", "ok", 25_000)).toBeGreaterThan(3)
      }))
  })

  it("a caller that cancels on timeout frees the function; one that doesn't leaves it running to the end", async () => {
    const run = (cancelOnTimeout: boolean) =>
      stateAt(single({ load: { rps: 20 }, fn: { duration: { mean: 2_000, cv: 0 }, timeout: "10 seconds" }, edge: { timeout: "500 millis", cancelOnTimeout } }), 10_000)
    const cancelling = await run(true)
    const patient = await run(false)
    // 20 rps for 0.5 s is about 10 running; for the full 2 s, about 40.
    expect(cancelling.state.concurrent).toBeLessThan(15)
    expect(patient.state.concurrent).toBeGreaterThan(30)
  })
})

describe("aws.lambda: errors and batches", () => {
  it("counts every function error, timeouts included, as CloudWatch's Errors does", async () => {
    const failing = await stateAt(single({ load: { rps: 20 }, fn: { errorRate: 0.5 } }), 10_000)
    expect(failing.state.errors / failing.state.invocations).toBeGreaterThan(0.4)
    expect(failing.state.errors / failing.state.invocations).toBeLessThan(0.6)
    const slow = await stateAt(single({ load: { rps: 5 }, fn: { duration: { mean: 3_000, cv: 0 }, timeout: "1 second" } }), 10_000)
    expect(slow.state.errors).toBe(slow.state.timeouts)
    expect(slow.state.timeouts).toBeGreaterThan(20)
  })

  it("a sync caller is told why the function failed", async () => {
    const { all } = await stateAt(single({ load: { rps: 5 }, fn: { errorRate: 1 } }), 3_000)
    expect(mean(all, "nodes", "web", "rates", "fail.Failed", 1_000)).toBeGreaterThan(3)
  })

  it("rolling the error rate per record makes a batch much likelier to fail: any bad record fails it all", async () => {
    const perBatch = await stateAt(batched({ errorRate: 0.1 }), 30_000)
    const perRecord = await stateAt(batched({ errorRate: 0.1, batch: { errors: "record" } }), 30_000)
    expect(perBatch.state.errors / perBatch.state.invocations).toBeLessThan(0.25)
    expect(perRecord.state.errors / perRecord.state.invocations).toBeGreaterThan(0.45) // 1 - 0.9^10 = 0.65 for a full batch
  })

  it("handler duration can scale with the records in the batch", async () => {
    const fixed = await stateAt(batched({}), 30_000)
    const scaled = await stateAt(batched({ batch: { duration: "record" } }), 30_000)
    expect(dist(fixed.all, "fn", "duration", 10_000).mean).toBeCloseTo(100, -1)
    expect(dist(scaled.all, "fn", "duration", 10_000).mean).toBeGreaterThan(600) // batches of about ten
  })
})

describe("aws.lambda: asynchronous invocation", () => {
  const asyncInto = (fn: Record<string, unknown>, ports: ReadonlyArray<"onFailure" | "onSuccess">, load: Record<string, unknown> = {}, account?: Record<string, unknown>): Doc => {
    const b = Builder.make("async", { seed: 4 })
    const web = b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 5, invocation: "async", ...load } })
    const f = b.add("aws.lambda", { id: "fn", settings: { memory: 1769, duration: { mean: 10, cv: 0 }, ...fn } })
    b.connect(web, f)
    for (const port of ports) b.connect(f.port(port), b.add("aws.sqs", { id: port }))
    if (account !== undefined) b.account("aws:us-east-1", account)
    return b.build()
  }
  it("a function reserved at zero sends events straight to the failure destination, without trying them", () =>
    sim(asyncInto({ reserved: { enabled: true, concurrency: 0 } }, ["onFailure"]), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(20_000)
        const fn = (yield* s.probe("fn")).state as Probe
        expect(fn.invocations).toBe(0)
        expect(fn.throttles).toBe(0)
        expect(fn.asyncRetries).toBe(0)
        expect(fn.asyncFailed).toBeGreaterThan(90)
        const queue = (yield* s.probe("onFailure")).state as { totals: { enqueued: number } }
        expect(Math.abs(queue.totals.enqueued - fn.asyncFailed)).toBeLessThanOrEqual(2)
      })))

  it("a successful event is reported to the on-success destination", () =>
    sim(asyncInto({}, ["onSuccess"]), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(20_000)
        const fn = (yield* s.probe("fn")).state as Probe
        expect(fn.asyncSucceeded).toBeGreaterThan(90)
        expect(fn.asyncFailed).toBe(0)
        const queue = (yield* s.probe("onSuccess")).state as { totals: { enqueued: number } }
        expect(Math.abs(queue.totals.enqueued - fn.asyncSucceeded)).toBeLessThanOrEqual(2)
      })))

  it("a retry that would come after the event's maximum age is not waited for: the event is discarded at that age", async () => {
    // Every attempt fails; the retry delay (2 minutes) is longer than the 1 minute the event may live.
    const doc = asyncInto({ errorRate: 1, async: { maxEventAge: "1 minute", firstRetryDelay: "2 minutes" } }, ["onFailure"], { rps: 1 })
    const { state } = await stateAt(doc, 200_000)
    expect(state.asyncRetries).toBe(0)
    expect(state.asyncFailed).toBeGreaterThan(100)
    expect(state.invocations).toBe(state.asyncFailed + state.asyncPending) // one attempt per event, then expiry
  })

  it("a throttled event that never gets in is discarded when it is too old", async () => {
    const doc = asyncInto({ duration: { mean: 1_000, cv: 0 }, async: { maxEventAge: "1 minute" } }, ["onFailure"], { rps: 20 }, { lambdaConcurrency: 10 })
    const { state } = await stateAt(doc, 300_000)
    expect(state.throttles).toBeGreaterThan(100)
    expect(state.asyncFailed).toBeGreaterThan(0)
  })

  it("an event still waiting to be retried holds no concurrency", async () => {
    // Events fail and wait a minute for their retry: the function sits idle in between.
    const doc = asyncInto({ errorRate: 1, async: { firstRetryDelay: "1 minute", secondRetryDelay: "1 minute" } }, ["onFailure"], { rps: 5 })
    const { state } = await stateAt(doc, 30_000)
    expect(state.asyncPending).toBeGreaterThan(100)
    expect(state.concurrent).toBeLessThanOrEqual(1)
  })
})
