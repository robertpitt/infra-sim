import { describe, expect, it } from "vitest"
import { frames, mean } from "../../../testing.ts"
import { audit } from "../Audit.ts"
import { read, stateAt, table, write } from "../testing.ts"

const big = { dynamodbTableWriteUnits: 200_000, dynamodbAccountWriteUnits: 400_000, dynamodbTableReadUnits: 200_000, dynamodbAccountReadUnits: 400_000 }

describe("aws.dynamodb: global secondary indexes", () => {
  it("every write to the table also writes to each index, and the index consumes its own capacity", async () => {
    const doc = table({ writeCapacity: 1_000, gsi: { count: 2, writeCapacity: 1_000 } }, { rps: 100, payload: 3 }, write)
    const state = await stateAt(doc, 20_000)
    // 3 KB items projected whole: 3 index units per index per write, two indexes.
    expect(state.indexes.consumedWrites / state.consumed.writes).toBeCloseTo(2, 1)
    expect(state.indexes.count).toBe(2)
    expect(state.throttled.writes).toBe(0)
  })

  it("an under-provisioned index throttles writes to a table that has capacity to spare (back-pressure)", async () => {
    const throttled = table({ writeCapacity: 5_000, burstSeconds: 0, gsi: { count: 1, writeCapacity: 200 } }, { rps: 500, payload: 1 }, write)
    const all = await frames(throttled, 30_000)
    expect(mean(all, "nodes", "web", "rates", "ok", 10_000)).toBeCloseTo(200, -1) // the index's rate, not the table's
    expect(mean(all, "nodes", "web", "rates", "fail.Throttled", 10_000)).toBeGreaterThan(250)
    const state = await stateAt(throttled, 30_000)
    expect(state.throttled.index).toBeGreaterThan(5_000)
    expect(state.lastThrottle).toContain("IndexWriteProvisionedThroughputExceeded")
    expect(state.writeTokens).toBeGreaterThan(4_000) // the table itself was never short
    // An index as wide as the table doesn't push back.
    const fine = await frames(table({ writeCapacity: 5_000, burstSeconds: 0, gsi: { count: 1 } }, { rps: 500, payload: 1 }, write), 30_000)
    expect(mean(fine, "nodes", "web", "rates", "fail", 10_000)).toBe(0)
  })

  it("a throttled write consumes nothing from the table or the other indexes", async () => {
    const doc = table({ writeCapacity: 5_000, burstSeconds: 0, gsi: { count: 2, writeCapacity: 1_000 } }, { rps: 800, payload: 1 }, write)
    // Both indexes keep up: 800/s on 1,000. Squeeze them with a second, much bigger index entry cost.
    const squeezed = table({ writeCapacity: 5_000, burstSeconds: 0, gsi: { count: 2, writeCapacity: 1_000, entryBytes: 2_048 } }, { rps: 800, payload: 1 }, write)
    expect((await stateAt(doc, 20_000)).throttled.index).toBe(0)
    const state = await stateAt(squeezed, 20_000)
    // Each write needs 2 units per index: 500 writes a second fit. What was admitted paid both indexes in full.
    expect(state.served.writes / 20).toBeCloseTo(500, -2)
    expect(state.indexes.consumedWrites).toBeCloseTo(state.served.writes * 2 * 2, -2)
  })

  it("an index key that moves costs two writes, and a sparse index costs less", async () => {
    const moving = await stateAt(table({ writeCapacity: 1_000, gsi: { count: 1, writeCapacity: 1_000, keyChangeShare: 1 } }, { rps: 100, payload: 1 }, write), 20_000)
    expect(moving.indexes.consumedWrites / moving.served.writes).toBeCloseTo(2, 1)
    const sparse = await stateAt(table({ writeCapacity: 1_000, gsi: { count: 1, writeCapacity: 1_000, writeShare: 0.25 } }, { rps: 100, payload: 1 }, write), 20_000)
    expect(sparse.indexes.consumedWrites / sparse.served.writes).toBeCloseTo(0.25, 2)
  })

  it("a low-cardinality index key concentrates writes on a few index partitions: 1,000 a second each", async () => {
    const settings = { writeCapacity: 50_000, burstSeconds: 0, gsi: { count: 1, writeCapacity: 50_000, keyValues: 1 } }
    const all = await frames(table(settings, { rps: 3_000, payload: 1, hotKeys: 0 }, write, big), 30_000)
    expect(mean(all, "nodes", "web", "rates", "ok", 10_000)).toBeCloseTo(1_000, -2) // one index partition
    const spread = await frames(table({ ...settings, gsi: { count: 1, writeCapacity: 50_000, keyValues: 0 } }, { rps: 3_000, payload: 1, hotKeys: 0 }, write, big), 30_000)
    expect(mean(spread, "nodes", "web", "rates", "fail", 10_000)).toBe(0)
    const state = await stateAt(table(settings, { rps: 3_000, payload: 1 }, write, big), 10_000)
    expect(state.lastThrottle).toContain("IndexWriteKeyRangeThroughputExceeded")
  })

  it("queries on an index use the index's read capacity, eventually consistent, and leave the table's alone", async () => {
    // 100 RCU per index, 4 KB entries at half a unit: 200 queries a second.
    const doc = table({ readCapacity: 5_000, burstSeconds: 0, readConsistency: "strong", gsi: { count: 1, readCapacity: 100, readShare: 1 } }, { rps: 500, payload: 4 }, read)
    const all = await frames(doc, 30_000)
    expect(mean(all, "nodes", "web", "rates", "ok", 10_000)).toBeCloseTo(200, -1)
    const state = await stateAt(doc, 30_000)
    expect(state.consumed.reads).toBe(0) // the table itself was not read
    expect(state.indexes.consumedReads).toBeGreaterThan(2_500) // 200 queries a second at half a unit
    expect(state.lastThrottle).toContain("IndexReadProvisionedThroughputExceeded")
  })

  it("only the share of reads that are index queries use the index", async () => {
    const state = await stateAt(table({ readCapacity: 5_000, gsi: { count: 2, readCapacity: 5_000, readShare: 0.25 } }, { rps: 400, payload: 4 }, read), 20_000)
    const total = state.served.reads
    expect(state.indexes.consumedReads / 0.5 / total).toBeCloseTo(0.25, 1) // 4 KB entries: half a unit per query
  })

  it("on-demand indexes scale on their own, each with its own maximum", async () => {
    const doc = table({ mode: "on-demand", gsi: { count: 1, maxWriteUnits: 500 } }, { rps: 1_500, payload: 1 }, write)
    const all = await frames(doc, 20_000)
    expect(mean(all, "nodes", "web", "rates", "ok", 5_000)).toBeCloseTo(500, -1)
    const state = await stateAt(doc, 20_000)
    expect(state.lastThrottle).toContain("IndexWriteMaxOnDemandThroughputExceeded")
    expect(state.writeTokens).toBeGreaterThan(0)
  })

  it("an index count above the account quota is ignored", async () => {
    const state = await stateAt(table({ gsi: { count: 30, writeCapacity: 100 } }, { rps: 1 }, write), 2_000)
    expect(state.indexes.count).toBe(20)
    const raised = await stateAt(table({ gsi: { count: 30, writeCapacity: 100 } }, { rps: 1 }, write, { dynamodbIndexesPerTable: 30 }), 2_000)
    expect(raised.indexes.count).toBe(30)
  })
})

describe("aws.dynamodb: audit", () => {
  const defaults = { dynamodbTableReadUnits: 40_000, dynamodbTableWriteUnits: 40_000, dynamodbAccountReadUnits: 80_000, dynamodbAccountWriteUnits: 80_000, dynamodbTables: 2_500, dynamodbIndexesPerTable: 20 }
  const gsi = { count: 0, readCapacity: 0, writeCapacity: 0 }
  const member = (id: string, config: Record<string, unknown>) => ({ id, name: id, type: "aws.dynamodb", config: { mode: "provisioned", readCapacity: 100, writeCapacity: 100, gsi, ...config } })

  it("adds up provisioned throughput over tables and their indexes, and ignores on-demand tables", () => {
    const members = [
      member("a", { writeCapacity: 30_000, gsi: { ...gsi, count: 1 } }),
      member("b", { writeCapacity: 30_000 }),
      member("c", { mode: "on-demand", writeCapacity: 90_000 })
    ]
    const found = audit("us-east-1", members, defaults)
    expect(found.map((d) => d.code)).toEqual(["dynamodb-account-write"])
    expect(found[0]!.message).toContain("90,000") // 30,000 + its index 30,000 + 30,000
  })

  it("clamps each table and index to the per-table quota", () => {
    const found = audit("us-east-1", [member("a", { writeCapacity: 100_000 }), member("b", { writeCapacity: 100_000 }), member("c", { writeCapacity: 100_000 })], defaults)
    expect(found[0]!.message).toContain("120,000") // 40,000 each, not 300,000
    expect(audit("us-east-1", [member("a", { writeCapacity: 40_000 }), member("b", { writeCapacity: 40_000 })], defaults)).toEqual([])
  })

  it("warns about too many tables, too many indexes, and an index narrower than its table", () => {
    const tables = Array.from({ length: 3 }, (_, i) => member(`t${i}`, {}))
    expect(audit("us-east-1", tables, { ...defaults, dynamodbTables: 2 }).map((d) => d.code)).toContain("dynamodb-tables")
    expect(audit("us-east-1", [member("a", { gsi: { ...gsi, count: 25 } })], defaults).map((d) => d.code)).toContain("dynamodb-indexes")
    const narrow = audit("us-east-1", [member("a", { writeCapacity: 1_000, gsi: { ...gsi, count: 1, writeCapacity: 200 } })], defaults)
    expect(narrow.map((d) => d.code)).toContain("dynamodb-index-underprovisioned")
    expect(narrow.find((d) => d.code === "dynamodb-index-underprovisioned")!.node).toBe("a")
  })
})
