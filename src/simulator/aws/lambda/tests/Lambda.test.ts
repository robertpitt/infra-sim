import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../../../Builder.ts"
import { frames, mean, sim } from "../../../testing.ts"

const lambdaWith = (fn: Record<string, unknown>, load: Record<string, unknown> = {}, account?: Record<string, unknown>, edge?: Record<string, unknown>) => {
  const b = Builder.make("lambda", { seed: 4 })
  const web = b.add("common.client", { id: "web", settings: { arrival: "constant", ...load } })
  const f = b.add("aws.lambda", { id: "fn", settings: { memory: 1769, duration: { mean: 100, cv: 0 }, ...fn } })
  b.connect(web, f, edge)
  if (account !== undefined) b.account("aws:us-east-1", account)
  return b.build()
}

const probeOf = (id: string, ms: number, doc: Builder.Builder extends never ? never : ReturnType<typeof lambdaWith>) =>
  sim(doc, (s) =>
    Effect.gen(function*() {
      const all = yield* s.advanceTo(ms)
      const probe = yield* s.probe(id)
      return { all, state: probe.state as Record<string, number> }
    }))

describe("aws.lambda: execution environments", () => {
  it("cold starts only when it has to: a trickle of traffic reuses one warm environment", async () => {
    const { all, state } = await probeOf("fn", 30_000, lambdaWith({ coldStart: { init: { mean: 500, cv: 0 } } }, { rps: 5 }))
    expect(state.invocations).toBeGreaterThan(130)
    expect(state.coldStarts).toBeLessThanOrEqual(3) // 5 rps x 100 ms is half a busy environment
    expect(mean(all, "nodes", "fn", "rates", "coldStarts", 5_000)).toBe(0)
  })

  it("the cold start shows up in the first request's latency", async () => {
    const all = await frames(lambdaWith({ coldStart: { init: { mean: 800, cv: 0 } } }, { rps: 1 }), 5_000)
    const first = all.find((f) => f.nodes.web?.dist.latency !== undefined)!
    expect(first.nodes.web!.dist.latency!.max).toBeGreaterThan(850) // 800 init + 100 handler + network
  })

  it("a burst needs one environment per concurrent request, each cold", async () => {
    const { state } = await probeOf("fn", 3_000, lambdaWith({ duration: { mean: 1_000, cv: 0 }, timeout: "10 seconds" }, { rps: 100 }))
    expect(state.environments).toBeGreaterThan(80)
    expect(state.coldStarts).toBeGreaterThan(80)
  })

  it("provisioned concurrency never cold starts", async () => {
    const { state } = await probeOf("fn", 20_000, lambdaWith({ provisioned: 5, coldStart: { init: { mean: 500, cv: 0 } } }, { rps: 20 }))
    expect(state.coldStarts).toBe(0)
    expect(state.invocations).toBeGreaterThan(350)
  })

  it("a smaller memory size slows the CPU-bound part of the handler", async () => {
    const run = (memory: number) => frames(lambdaWith({ memory, cpuBound: 1, duration: { mean: 100, cv: 0 } }, { rps: 5 }), 20_000)
    const small = await run(128)
    const big = await run(1769)
    const p50 = (all: Awaited<ReturnType<typeof run>>) => all.slice(20).reduce((s, f) => s + (f.nodes.web?.dist.latency?.p50 ?? 0), 0) / 40
    // 1,769 MB is one full vCPU; 128 MB gets a fourteenth of that.
    expect(p50(small)).toBeGreaterThan(8 * p50(big))
  })

  it("a function that times out is killed and its environment discarded, so the next call is cold again", async () => {
    const { state } = await probeOf("fn", 20_000, lambdaWith({ duration: { mean: 3_000, cv: 0 }, timeout: "1 second", coldStart: { init: { mean: 10, cv: 0 } } }, { rps: 2 }))
    expect(state.timeouts).toBeGreaterThan(25)
    expect(state.coldStarts).toBeGreaterThan(25) // one per timeout: nothing was ever reused
  })
})

describe("aws.lambda: concurrency", () => {
  it("throttles with 429 once the regional concurrency is used up", async () => {
    // 100 rps x 500 ms needs 50 at once; the account allows 10.
    const doc = lambdaWith({ duration: { mean: 500, cv: 0 }, timeout: "5 seconds" }, { rps: 100 }, { lambdaConcurrency: 10 })
    const { all, state } = await probeOf("fn", 20_000, doc)
    expect(state.concurrent).toBeLessThanOrEqual(10)
    expect(mean(all, "nodes", "web", "rates", "fail.Throttled", 5_000)).toBeGreaterThan(70)
    expect(mean(all, "nodes", "web", "rates", "ok", 5_000)).toBeLessThan(25) // 10 / 0.5 s = 20 rps
  })

  it("reserved concurrency is both a floor and a cap", async () => {
    const doc = lambdaWith({ duration: { mean: 500, cv: 0 }, timeout: "5 seconds", reserved: { enabled: true, concurrency: 5 } }, { rps: 100 })
    const { all, state } = await probeOf("fn", 20_000, doc)
    expect(state.limit).toBe(5)
    expect(state.concurrent).toBeLessThanOrEqual(5)
    expect(mean(all, "nodes", "web", "rates", "ok", 5_000)).toBeLessThan(13)
  })

  it("reserved concurrency of zero throttles the function completely", async () => {
    const all = await frames(lambdaWith({ reserved: { enabled: true, concurrency: 0 } }, { rps: 20 }), 10_000)
    expect(mean(all, "nodes", "web", "rates", "ok", 2_000)).toBe(0)
    expect(mean(all, "nodes", "web", "rates", "fail.Throttled", 2_000)).toBeGreaterThan(15)
  })

  it("functions in a region share one concurrency pool, and one can starve the other", () => {
    const b = Builder.make("shared", { seed: 4 })
    const noisy = b.add("common.client", { id: "noisy", settings: { arrival: "constant", rps: 300 } })
    const quiet = b.add("common.client", { id: "quiet", settings: { arrival: "constant", rps: 20 } })
    const heavy = b.add("aws.lambda", { id: "heavy", settings: { duration: { mean: 1_000, cv: 0 }, timeout: "5 seconds" } })
    const light = b.add("aws.lambda", { id: "light", settings: { duration: { mean: 100, cv: 0 } } })
    b.connect(noisy, heavy)
    b.connect(quiet, light)
    b.account("aws:us-east-1", { lambdaConcurrency: 100 })
    return sim(b.build(), (s) =>
      Effect.gen(function*() {
        const all = yield* s.advanceTo(20_000)
        // The heavy function wants 300 at once and takes the whole pool; the light one is throttled through no fault of its own.
        expect(mean(all, "nodes", "quiet", "rates", "fail.Throttled", 5_000)).toBeGreaterThan(5)
        yield* s.configureAccount("aws:us-east-1", { lambdaConcurrency: 2_000 })
        const after = yield* s.advanceTo(40_000)
        expect(mean(after, "nodes", "quiet", "rates", "fail", 30_000)).toBe(0)
      }))
  })

  it("a function can only add 1,000 execution environments per 10 seconds", async () => {
    const doc = lambdaWith({ duration: { mean: 5_000, cv: 0 }, timeout: "10 seconds" }, { rps: 3_000 }, { lambdaConcurrency: 100_000 })
    const { state } = await probeOf("fn", 2_000, doc)
    // 3,000 requests a second want 3,000 new environments, the scale-up allowance is 1,000 plus a refill of 100/s.
    expect(state.environments).toBeLessThanOrEqual(1_300)
    expect(state.throttles).toBeGreaterThan(2_000)
  })
})

describe("aws.lambda: invocation types and payloads", () => {
  it("rejects payloads over the 6 MB synchronous and 1 MB asynchronous limits", async () => {
    const sync = await frames(lambdaWith({}, { rps: 5, payload: 7 * 1024 }), 5_000)
    expect(mean(sync, "nodes", "web", "rates", "fail.Rejected", 1_000)).toBeGreaterThan(3)
    const async = await frames(lambdaWith({}, { rps: 5, payload: 2 * 1024, invocation: "async" }), 5_000)
    expect(mean(async, "nodes", "web", "rates", "fail.Rejected", 1_000)).toBeGreaterThan(3)
    const fine = await frames(lambdaWith({}, { rps: 5, payload: 5 * 1024 }), 5_000)
    expect(mean(fine, "nodes", "web", "rates", "fail", 1_000)).toBe(0)
  })

  it("answers an asynchronous invocation at once and does the work afterwards", async () => {
    const doc = lambdaWith({ duration: { mean: 2_000, cv: 0 }, timeout: "5 seconds" }, { rps: 5, invocation: "async" })
    const { all, state } = await probeOf("fn", 10_000, doc)
    const latency = all.flatMap((f) => (f.nodes.web?.dist.latency ? [f.nodes.web.dist.latency.p50] : []))
    expect(Math.max(...latency)).toBeLessThan(50) // the caller never waits for the 2 s handler
    expect(state.asyncPending).toBeGreaterThan(5)
  })

  it("retries failed asynchronous invocations twice, then hands the event to the on-failure destination", () => {
    const b = Builder.make("async", { seed: 4 })
    const web = b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 2, invocation: "async" } })
    const fn = b.add("aws.lambda", {
      id: "fn",
      settings: { errorRate: 1, duration: { mean: 10, cv: 0 }, async: { firstRetryDelay: "1 second", secondRetryDelay: "2 seconds" } }
    })
    const dlq = b.add("aws.sqs", { id: "failed" })
    b.connect(web, fn)
    b.connect(fn.port("onFailure"), dlq)
    return sim(b.build(), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(30_000)
        const fn = (yield* s.probe("fn")).state as { invocations: number; asyncFailed: number }
        // 3 attempts per event (the first plus two retries), and every event ends up failed.
        expect(fn.invocations / fn.asyncFailed).toBeGreaterThan(2.7)
        expect(fn.invocations / fn.asyncFailed).toBeLessThan(3.6)
        const queue = (yield* s.probe("failed")).state as { totals: { enqueued: number } }
        expect(queue.totals.enqueued).toBe(fn.asyncFailed)
      }))
  })

  it("keeps retrying a throttled asynchronous event until it gets in, instead of failing it", async () => {
    const doc = lambdaWith({ duration: { mean: 1_000, cv: 0 }, timeout: "5 seconds" }, { rps: 20, invocation: "async" }, { lambdaConcurrency: 10 })
    const { state } = await probeOf("fn", 60_000, doc)
    expect(state.throttles).toBeGreaterThan(100)
    expect(state.asyncFailed).toBe(0)
  })
})
