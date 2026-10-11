import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../Builder.ts"
import { frames, mean, sim } from "../components/testing.ts"

const topic = (topicSettings: Record<string, unknown>, load: Record<string, unknown>, subscribers: ReadonlyArray<{ id: string; type?: string; settings?: Record<string, unknown>; edge?: Record<string, unknown> }>, region?: string, account?: Record<string, unknown>) => {
  const b = Builder.make("sns", { seed: 6 })
  const web = b.add("common.client", { id: "web", settings: { arrival: "constant", ...load } })
  const t = b.add("aws.sns", { id: "topic", ...(region === undefined ? {} : { region }), settings: topicSettings })
  b.connect(web, t)
  for (const s of subscribers) b.connect(t, b.add(s.type ?? "common.http-endpoint", { id: s.id, ...(region !== undefined && s.type?.startsWith("aws.") ? { region } : {}), settings: s.settings ?? { latency: { mean: 10, cv: 0 } } }), s.edge)
  if (account !== undefined) b.account(`aws:${region ?? "us-east-1"}`, account)
  return b.build()
}

describe("aws.sns", () => {
  it("delivers a copy to every subscriber", async () => {
    const all = await frames(topic({}, { rps: 100 }, [{ id: "a" }, { id: "b" }, { id: "c" }]), 20_000)
    for (const id of ["a", "b", "c"]) expect(mean(all, "nodes", id, "rates", "ok", 5_000)).toBeCloseTo(100, -1)
  })

  it("limits publishes to the region's quota: 30,000/s in us-east-1 but only 300/s in eu-north-1", async () => {
    const run = (region: string, account?: Record<string, unknown>) => frames(topic({}, { rps: 600 }, [{ id: "a" }], region, account), 20_000)
    expect(mean(await run("us-east-1"), "nodes", "web", "rates", "fail", 5_000)).toBe(0)
    const small = await run("eu-north-1")
    expect(mean(small, "nodes", "web", "rates", "ok", 5_000)).toBeCloseTo(300, -2)
    expect(mean(small, "nodes", "web", "rates", "fail.Throttled", 5_000)).toBeGreaterThan(250)
    // The quota is a setting: ask AWS for more and it is raised.
    expect(mean(await run("eu-north-1", { snsPublishRate: 1_000 }), "nodes", "web", "rates", "fail", 5_000)).toBe(0)
  })

  it("limits a FIFO topic to 300 messages a second per message group", async () => {
    const all = await frames(topic({ kind: "fifo" }, { rps: 600, messageGroups: 1 }, [{ id: "a" }]), 20_000)
    expect(mean(all, "nodes", "web", "rates", "ok", 5_000)).toBeCloseTo(300, -2)
  })

  it("refuses messages over its size limit, which can be raised to 1 MiB", async () => {
    const big = await frames(topic({}, { rps: 10, payload: 300 }, [{ id: "a" }]), 5_000)
    expect(mean(big, "nodes", "web", "rates", "fail.Rejected", 1_000)).toBeGreaterThan(8)
    const raised = await frames(topic({ maxMessageSize: 512 }, { rps: 10, payload: 300 }, [{ id: "a" }]), 5_000)
    expect(mean(raised, "nodes", "web", "rates", "fail", 1_000)).toBe(0)
  })

  it("keeps retrying a failing subscriber until the message gets through", async () => {
    const flaky = { id: "flaky", settings: { errorRate: 0.5, latency: { mean: 10, cv: 0 } } }
    const all = await frames(topic({}, { rps: 20 }, [flaky]), 40_000)
    expect(mean(all, "nodes", "topic", "rates", "delivered", 10_000)).toBeCloseTo(20, -1) // nothing lost
    expect(mean(all, "nodes", "topic", "rates", "undelivered", 0)).toBe(0)
    expect(mean(all, "nodes", "flaky", "rates", "in", 10_000)).toBeGreaterThan(30) // roughly two attempts each
  })

  it("invokes Lambda subscribers asynchronously, so a slow function never slows the publisher", () => {
    const doc = topic({}, { rps: 10 }, [{ id: "fn", type: "aws.lambda", settings: { memory: 1769, duration: { mean: 3_000, cv: 0 }, timeout: "10 seconds" } }], "us-east-1")
    return sim(doc, (s) =>
      Effect.gen(function*() {
        const all = yield* s.advanceTo(20_000)
        const state = (yield* s.probe("fn")).state as { asyncPending: number }
        expect(state.asyncPending).toBeGreaterThan(20)
        const latency = all.flatMap((f) => (f.nodes.web?.dist.latency ? [f.nodes.web.dist.latency.p50] : []))
        expect(Math.max(...latency)).toBeLessThan(60)
      }))
  })
})
