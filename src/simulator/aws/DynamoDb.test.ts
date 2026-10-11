import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../Builder.ts"
import { frames, mean, sim } from "../components/testing.ts"

const table = (settings: Record<string, unknown>, load: Record<string, unknown>, edge?: Record<string, unknown>, account?: Record<string, unknown>) => {
  const b = Builder.make("ddb", { seed: 2 })
  const web = b.add("common.client", { id: "web", settings: { arrival: "constant", ...load } })
  const t = b.add("aws.dynamodb", { id: "t", settings })
  b.connect(web, t, edge)
  if (account !== undefined) b.account("aws:us-east-1", account)
  return b.build()
}
const write = { request: { operation: "write" } }
const read = { request: { operation: "read" } }

describe("aws.dynamodb: capacity units", () => {
  it("charges one write unit per KB, rounded up", async () => {
    const run = (kb: number) => frames(table({ writeCapacity: 100, burstSeconds: 0 }, { rps: 300, payload: kb }, write), 40_000)
    expect(mean(await run(1), "nodes", "web", "rates", "ok", 20_000)).toBeCloseTo(100, -1) // 100 WCU / 1 unit
    expect(mean(await run(2), "nodes", "web", "rates", "ok", 20_000)).toBeCloseTo(50, -1)
    expect(mean(await run(1.5), "nodes", "web", "rates", "ok", 20_000)).toBeCloseTo(50, -1) // 1.5 KB rounds up to 2
  })

  it("charges transactional writes twice", async () => {
    const all = await frames(table({ writeCapacity: 100, burstSeconds: 0, writeMode: "transactional" }, { rps: 300, payload: 1 }, write), 40_000)
    expect(mean(all, "nodes", "web", "rates", "ok", 20_000)).toBeCloseTo(50, -1)
  })

  it("charges reads per 4 KB: half a unit if eventually consistent, one if strongly consistent, two if transactional", async () => {
    const run = (readConsistency: string) => frames(table({ readCapacity: 100, burstSeconds: 0, readConsistency }, { rps: 500, payload: 4 }, read), 40_000)
    expect(mean(await run("eventual"), "nodes", "web", "rates", "ok", 20_000)).toBeCloseTo(200, -1)
    expect(mean(await run("strong"), "nodes", "web", "rates", "ok", 20_000)).toBeCloseTo(100, -1)
    expect(mean(await run("transactional"), "nodes", "web", "rates", "ok", 20_000)).toBeCloseTo(50, -1)
  })

  it("rejects items over 400 KB", async () => {
    const all = await frames(table({}, { rps: 10, payload: 401 }, write), 5_000)
    expect(mean(all, "nodes", "web", "rates", "fail.Rejected", 1_000)).toBeGreaterThan(8)
  })

  it("banks unused capacity for bursts, then falls back to the provisioned rate", async () => {
    // 100 WCU with 30 s banked is a 3,000-unit bucket; 400 writes a second drains it at 300 a second.
    const all = await frames(table({ writeCapacity: 100, burstSeconds: 30 }, { rps: 400, payload: 1 }, write), 40_000)
    expect(mean(all, "nodes", "web", "rates", "ok", 0, 5_000)).toBeGreaterThan(380)
    expect(mean(all, "nodes", "web", "rates", "ok", 25_000)).toBeCloseTo(100, -1)
    expect(mean(all, "nodes", "web", "rates", "fail.Throttled", 25_000)).toBeGreaterThan(250)
  })
})

describe("aws.dynamodb: partitions", () => {
  const big = { dynamodbTableWriteUnits: 200_000, dynamodbAccountWriteUnits: 200_000 }

  it("a hot key is limited to one partition's 1,000 writes a second however large the table", async () => {
    const settings = { writeCapacity: 50_000, burstSeconds: 0 }
    const hot = await frames(table(settings, { rps: 3_000, payload: 1, hotKeys: 1 }, write, big), 30_000)
    expect(mean(hot, "nodes", "web", "rates", "ok", 10_000)).toBeCloseTo(1_000, -2)
    expect(mean(hot, "nodes", "web", "rates", "fail.Throttled", 10_000)).toBeGreaterThan(1_800)
    const even = await frames(table(settings, { rps: 3_000, payload: 1, hotKeys: 0 }, write, big), 30_000)
    expect(mean(even, "nodes", "web", "rates", "fail", 10_000)).toBe(0) // spread over ~50 partitions
  })

  it("a partition can't serve more than 3,000 read units a second either", async () => {
    const all = await frames(table({ readCapacity: 50_000, burstSeconds: 0, readConsistency: "strong" }, { rps: 5_000, payload: 4, hotKeys: 1 }, read, { dynamodbTableReadUnits: 200_000, dynamodbAccountReadUnits: 200_000 }), 30_000)
    expect(mean(all, "nodes", "web", "rates", "ok", 10_000)).toBeCloseTo(3_000, -2)
  })

  it("reports the partitions it derived from capacity", () =>
    sim(table({ writeCapacity: 5_000, readCapacity: 3_000 }, { rps: 1 }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(1_000)
        const state = (yield* s.probe("t")).state as { partitions: number }
        expect(state.partitions).toBe(5) // 5,000 WCU at 1,000 per partition
      })))
})

describe("aws.dynamodb: on-demand and quotas", () => {
  it("a new on-demand table starts at 4,000 writes a second and absorbs up to double its previous peak", async () => {
    const all = await frames(table({ mode: "on-demand" }, { rps: 9_000, payload: 1 }, write), 40_000)
    expect(mean(all, "nodes", "web", "rates", "fail.Throttled", 0, 1_000)).toBeGreaterThan(3_000) // beyond baseline at first
    expect(mean(all, "nodes", "web", "rates", "fail", 25_000)).toBe(0) // peaks have doubled twice by now
  })

  it("is capped by the account's per-table quota, which is editable", () =>
    sim(table({ readCapacity: 100_000, writeCapacity: 100_000 }, { rps: 1 }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(2_000)
        const state = (yield* s.probe("t")).state as { readCapacity: number; writeCapacity: number }
        expect(state.readCapacity).toBe(40_000)
        expect(state.writeCapacity).toBe(40_000)
        yield* s.configureAccount("aws:us-east-1", { dynamodbTableReadUnits: 60_000, dynamodbTableWriteUnits: 60_000 })
        const raised = (yield* s.probe("t")).state as { readCapacity: number }
        expect(raised.readCapacity).toBe(60_000)
      })))

  it("tables in one region share the account's provisioned throughput, in creation order", () => {
    const b = Builder.make("three", { seed: 2 })
    for (const [id, units] of [["a", 50_000], ["b", 30_000], ["c", 30_000]] as const) {
      b.connect(b.add("common.client", { id: `web-${id}`, settings: { rps: 1 } }), b.add("aws.dynamodb", { id, settings: { readCapacity: units, writeCapacity: units } }))
    }
    return sim(b.build(), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(2_000)
        const cap = (id: string) => Effect.map(s.probe(id), (p) => (p.state as { writeCapacity: number }).writeCapacity)
        expect(yield* cap("a")).toBe(40_000) // capped by the per-table quota
        expect(yield* cap("b")).toBe(30_000)
        expect(yield* cap("c")).toBe(10_000) // what is left of the 80,000 account quota
      }))
  })
})
