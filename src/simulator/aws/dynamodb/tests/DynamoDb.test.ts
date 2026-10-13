import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../../../Builder.ts"
import { frames, mean, sim } from "../../../testing.ts"
import { read, stateAt, table, write } from "../testing.ts"

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

  it("rejects items over 400 KB, and 400 KB itself is fine", async () => {
    const over = await frames(table({}, { rps: 10, payload: 401 }, write), 5_000)
    expect(mean(over, "nodes", "web", "rates", "fail.Rejected", 1_000)).toBeGreaterThan(8)
    const exact = await frames(table({ writeCapacity: 10_000 }, { rps: 10, payload: 400 }, write), 5_000)
    expect(mean(exact, "nodes", "web", "rates", "fail", 1_000)).toBe(0)
  })

  it("banks unused capacity for bursts, then falls back to the provisioned rate", async () => {
    // 100 WCU with 30 s banked is a 3,000-unit bucket; 400 writes a second drains it at 300 a second.
    const all = await frames(table({ writeCapacity: 100, burstSeconds: 30 }, { rps: 400, payload: 1 }, write), 40_000)
    expect(mean(all, "nodes", "web", "rates", "ok", 0, 5_000)).toBeGreaterThan(380)
    expect(mean(all, "nodes", "web", "rates", "ok", 25_000)).toBeCloseTo(100, -1)
    expect(mean(all, "nodes", "web", "rates", "fail.Throttled", 25_000)).toBeGreaterThan(250)
  })

  it("reports consumed capacity units per second, the way CloudWatch does", async () => {
    const all = await frames(table({ writeCapacity: 1_000, burstSeconds: 0 }, { rps: 100, payload: 3 }, write), 20_000)
    expect(mean(all, "nodes", "t", "rates", "consumedWrite", 5_000)).toBeCloseTo(300, -1) // 100 writes of 3 KB
    expect(mean(all, "nodes", "t", "rates", "consumedRead", 5_000)).toBe(0)
  })

  it("a failed conditional write still costs the write units, changes nothing, and can't be fixed by retrying", async () => {
    const doc = table({ writeCapacity: 1_000, burstSeconds: 0, conditionFailureRate: 0.25 }, { rps: 400, payload: 1 }, { ...write, retry: { maxAttempts: 5 } })
    const all = await frames(doc, 20_000)
    expect(mean(all, "nodes", "web", "rates", "fail.Rejected", 5_000)).toBeCloseTo(100, -1) // a quarter of 400
    expect(mean(all, "nodes", "t", "rates", "consumedWrite", 5_000)).toBeCloseTo(400, -1) // all 400 paid
    const state = await stateAt(doc, 20_000)
    expect(state.conditionFailed).toBeGreaterThan(1_500)
  })

  it("does not blow up on odd inputs: a zero-byte item costs one unit, and settings at their extremes still serve", async () => {
    const empty = await frames(table({ writeCapacity: 1, burstSeconds: 0 }, { rps: 10, payload: 0.001 }, write), 10_000)
    expect(mean(empty, "nodes", "web", "rates", "ok", 3_000)).toBeLessThan(2) // one unit a call, 1 WCU
    const big = await frames(table({ mode: "on-demand", partitions: 10_000, burstSeconds: 0 }, { rps: 50 }, write), 5_000)
    expect(mean(big, "nodes", "web", "rates", "fail", 1_000)).toBe(0)
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

  it("a request the partition refuses takes nothing from the table's capacity", async () => {
    // Hot key against a 5,000 WCU table: the partition refuses all but 1,000; the other 4,000 units stay for other keys.
    const doc = table({ writeCapacity: 5_000, burstSeconds: 0 }, { rps: 2_000, payload: 1, hotKeys: 1 }, write)
    const state = await stateAt(doc, 30_000)
    expect(state.throttled.partition).toBeGreaterThan(20_000)
    expect(state.consumed.writes).toBeLessThan(31_000 * 1.05) // about 1,000 a second, not the 2,000 asked
    expect(state.writeTokens).toBeGreaterThan(4_000) // the table's own bucket is barely touched
  })

  it("reports the partitions it derived from capacity", () =>
    sim(table({ writeCapacity: 5_000, readCapacity: 3_000 }, { rps: 1 }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(1_000)
        const state = (yield* s.probe("t")).state as { partitions: number }
        expect(state.partitions).toBe(5) // 5,000 WCU at 1,000 per partition
      })))

  it("a fixed partition count spreads keys over that many partitions", async () => {
    // 4 partitions of a 4,000 WCU table: a hot key gets 1,000 whatever the count; an even load is spread and unthrottled.
    const hot = await frames(table({ writeCapacity: 4_000, partitions: 4, burstSeconds: 0 }, { rps: 2_000, hotKeys: 1 }, write), 20_000)
    expect(mean(hot, "nodes", "web", "rates", "ok", 8_000)).toBeCloseTo(1_000, -2)
    const even = await frames(table({ writeCapacity: 4_000, partitions: 4, burstSeconds: 0 }, { rps: 3_500, hotKeys: 0 }, write), 20_000)
    expect(mean(even, "nodes", "web", "rates", "fail", 8_000)).toBeLessThan(35) // uniform keys over 4 partitions of 1,000
  })
})

describe("aws.dynamodb: on-demand", () => {
  const onDemand = { mode: "on-demand", onDemand: { scaleInterval: "20 seconds" } }

  it("a new on-demand table absorbs 4,000 writes a second, then double its previous peak, then scales out", async () => {
    const all = await frames(table(onDemand, { rps: 9_000, payload: 1 }, write), 40_000)
    expect(mean(all, "nodes", "web", "rates", "fail.Throttled", 0, 1_000)).toBeGreaterThan(3_000) // beyond the baseline at first
    // Reaching its 4,000 raised the ceiling to 8,000, and 8,000 can't count as a peak until an interval has passed.
    expect(mean(all, "nodes", "web", "rates", "fail.Throttled", 5_000, 15_000)).toBeCloseTo(1_000, -2)
    expect(mean(all, "nodes", "web", "rates", "ok", 5_000, 15_000)).toBeCloseTo(8_000, -2)
    // After the interval the ceiling has doubled: 9,000 no longer throttles.
    expect(mean(all, "nodes", "web", "rates", "fail", 25_000)).toBe(0)
  })

  it("never forgets its peak: a table that scaled out absorbs the same load again at once", async () => {
    const b = Builder.make("again", { seed: 3 })
    const web = b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 9_000, payload: 1 } })
    const t = b.add("aws.dynamodb", { id: "t", settings: onDemand })
    b.connect(web, t, write)
    const all = await sim(b.build(), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(30_000) // scaled out by now
        yield* s.configureNode("web", { arrival: "constant", rps: 100, payload: 1 }) // quiet for a long while
        yield* s.advanceTo(3_600_000 / 10)
        yield* s.configureNode("web", { arrival: "constant", rps: 9_000, payload: 1 })
        return yield* s.advanceTo(3_600_000 / 10 + 5_000)
      }))
    const after = all.filter((f) => f.t > 360_000)
    expect(after.length).toBeGreaterThan(10)
    expect(mean(after, "nodes", "web", "rates", "fail", 0)).toBe(0)
  })

  it("pre-warming raises what a new table absorbs at once", async () => {
    const all = await frames(table({ mode: "on-demand", onDemand: { warmWriteUnits: 20_000 } }, { rps: 9_000, payload: 1 }, write), 10_000)
    expect(mean(all, "nodes", "web", "rates", "fail", 0)).toBe(0)
  })

  it("a maximum throughput throttles beyond it with ThrottlingException", async () => {
    const doc = table({ mode: "on-demand", onDemand: { maxWriteUnits: 1_000 } }, { rps: 3_000, payload: 1 }, write)
    const all = await frames(doc, 20_000)
    expect(mean(all, "nodes", "web", "rates", "ok", 5_000)).toBeCloseTo(1_000, -2)
    const state = await stateAt(doc, 20_000)
    expect(state.lastThrottle).toContain("ThrottlingException")
    expect(state.lastThrottle).toContain("MaxOnDemandThroughputExceeded")
  })

  it("hitting the per-table quota is RequestLimitExceeded, not a scaling throttle", async () => {
    const state = await stateAt(table({ mode: "on-demand" }, { rps: 9_000, payload: 1 }, write, { dynamodbTableWriteUnits: 5_000 }), 20_000)
    expect(state.writeCapacity).toBe(5_000)
    expect(state.lastThrottle).toContain("RequestLimitExceeded")
  })

  it("a provisioned table throttles with ProvisionedThroughputExceededException, a hot partition with the key-range reason", async () => {
    const doc = table({ writeCapacity: 100, burstSeconds: 0 }, { rps: 300, payload: 1 }, write)
    expect((await stateAt(doc, 10_000)).lastThrottle).toContain("TableWriteProvisionedThroughputExceeded")
    const hot = table({ writeCapacity: 50_000, burstSeconds: 0 }, { rps: 3_000, hotKeys: 1 }, write, { dynamodbTableWriteUnits: 200_000, dynamodbAccountWriteUnits: 200_000 })
    expect((await stateAt(hot, 10_000)).lastThrottle).toContain("TableWriteKeyRangeThroughputExceeded")
  })

  it("an on-demand table has no banked burst to spend: only a short smoothing", async () => {
    const state = await stateAt(table({ mode: "on-demand" }, { rps: 1 }), 2_000)
    expect(state.writeTokens).toBeLessThanOrEqual(state.writeCapacity / 10 + 1)
  })
})

describe("aws.dynamodb: local secondary indexes", () => {
  it("share the table's capacity: each local index adds a write unit per item", async () => {
    // 300 WCU, a 1 KB item costs 1 + 2 (two LSIs projecting the whole item) = 3 units: 100 writes a second.
    const all = await frames(table({ writeCapacity: 300, burstSeconds: 0, lsi: { count: 2 } }, { rps: 400, payload: 1 }, write), 30_000)
    expect(mean(all, "nodes", "web", "rates", "ok", 15_000)).toBeCloseTo(100, -1)
    const keysOnly = await frames(table({ writeCapacity: 300, burstSeconds: 0, lsi: { count: 2, entryBytes: 100 } }, { rps: 400, payload: 3 }, write), 30_000)
    // a 3 KB item is 3 units, each 100-byte entry is 1: 5 units, 60 writes a second
    expect(mean(keysOnly, "nodes", "web", "rates", "ok", 15_000)).toBeCloseTo(60, -1)
  })
})

describe("aws.dynamodb: account quotas", () => {
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

  const three = (settings: (id: string) => Record<string, unknown>) => {
    const b = Builder.make("three", { seed: 2 })
    for (const id of ["a", "b", "c"]) b.connect(b.add("common.client", { id: `web-${id}`, settings: { rps: 1 } }), b.add("aws.dynamodb", { id, settings: settings(id) }))
    return b.build()
  }
  const cap = (s: { probe: (id: string) => Effect.Effect<{ state: unknown }, unknown> }, id: string) =>
    Effect.map(s.probe(id), (p) => (p.state as { writeCapacity: number }).writeCapacity)

  it("tables in one region share the account's provisioned throughput, in creation order", () => {
    const units = { a: 50_000, b: 30_000, c: 30_000 } as const
    return sim(three((id) => ({ readCapacity: units[id as "a"], writeCapacity: units[id as "a"] })), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(2_000)
        expect(yield* cap(s, "a")).toBe(40_000) // capped by the per-table quota
        expect(yield* cap(s, "b")).toBe(30_000)
        expect(yield* cap(s, "c")).toBe(10_000) // what is left of the 80,000 account quota
      }))
  })

  it("on-demand tables don't count against it, and a table that switches mode keeps its place in the queue", () =>
    sim(three(() => ({ writeCapacity: 40_000, readCapacity: 40_000 })), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(2_000)
        expect(yield* cap(s, "c")).toBe(1) // a and b hold 80,000: nothing is left for c, which gets the minimum
        yield* s.configureNode("a", { mode: "on-demand" })
        yield* s.advanceTo(3_000)
        expect(yield* cap(s, "c")).toBe(40_000) // a no longer counts
        yield* s.configureNode("a", { mode: "provisioned", readCapacity: 40_000, writeCapacity: 40_000 })
        yield* s.advanceTo(4_000)
        expect(yield* cap(s, "a")).toBe(40_000) // a is back, still ahead of b and c
        expect(yield* cap(s, "c")).toBe(1)
      })))

  it("an idle table's change reaches the others without any request to it", () =>
    sim(three(() => ({ writeCapacity: 40_000, readCapacity: 40_000 })), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(1_000)
        yield* s.configureNode("a", { readCapacity: 40_000, writeCapacity: 10_000 })
        yield* s.advanceTo(2_000)
        expect(yield* cap(s, "a")).toBe(10_000)
        expect(yield* cap(s, "c")).toBe(30_000) // 80,000 - 10,000 - 40,000
      })))

  it("counts global secondary indexes in the account total", () =>
    sim(three((id) => (id === "a" ? { writeCapacity: 30_000, gsi: { count: 1 } } : { writeCapacity: 30_000 })), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(2_000)
        expect(yield* cap(s, "a")).toBe(30_000)
        expect(yield* cap(s, "b")).toBe(20_000) // 80,000 less the table and its index (60,000)
        expect(yield* cap(s, "c")).toBe(1) // nothing left; a table always gets 1
      })))
})

describe("aws.dynamodb: live edits and determinism", () => {
  it("changing a setting while running takes effect on the next call and keeps state", () =>
    sim(table({ writeCapacity: 100, burstSeconds: 0 }, { rps: 300, payload: 1 }, write), (s) =>
      Effect.gen(function*() {
        const a = yield* s.advanceTo(10_000)
        yield* s.configureNode("t", { writeCapacity: 200, burstSeconds: 0 }) // overrides replace the settings, so say it again
        const b = yield* s.advanceTo(20_000)
        expect(mean(a, "nodes", "web", "rates", "ok", 5_000)).toBeCloseTo(100, -1)
        expect(mean(b, "nodes", "web", "rates", "ok", 15_000)).toBeCloseTo(200, -1)
        const state = (yield* s.probe("t")).state as { writeCapacity: number; served: { writes: number } }
        expect(state.writeCapacity).toBe(200)
        expect(state.served.writes).toBeGreaterThan(2_000)
      })))

  it("same design and seed, same result, with indexes and a stream on", async () => {
    const doc = () => {
      const b = Builder.make("det", { seed: 9 })
      const web = b.add("common.client", { id: "web", settings: { arrival: "poisson", rps: 300, hotKeys: 0.1 } })
      const t = b.add("aws.dynamodb", { id: "t", settings: { writeCapacity: 500, gsi: { count: 2, writeCapacity: 300 }, conditionFailureRate: 0.1 } })
      const fn = b.add("common.http-endpoint", { id: "fn", settings: { errorRate: 0.2 } })
      b.connect(web, t, write)
      b.connect(t.port("stream"), fn)
      return b.build()
    }
    const run = () => frames(doc(), 15_000)
    expect(JSON.stringify(await run())).toBe(JSON.stringify(await run()))
  })
})
