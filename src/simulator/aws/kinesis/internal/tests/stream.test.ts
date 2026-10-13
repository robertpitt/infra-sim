import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import type { Fast } from "../../../../Component.ts"
import { Tally } from "../../../../kit/Tally.ts"
import type { Message } from "../../../../Message.ts"
import * as SeededRandom from "../../../../SeededRandom.ts"
import { MiB } from "../../../internal/units.ts"
import { SLICES, Stream, type StreamConfig } from "../config.ts"
import { laneCount, type Segment } from "../log.ts"
import { StreamModel, type StreamTallies } from "../stream.ts"

/** A stream model on its own, with a clock the test moves and no timers firing. */
const model = (settings: Record<string, unknown>) => {
  let now = 0
  const config = Schema.decodeUnknownSync(Stream)(settings) as StreamConfig
  const t = Object.fromEntries(
    ["incoming", "incomingBytes", "throttled", "rejected", "getRecords", "outgoing", "outgoingBytes", "readThrottled", "pushed", "expired", "splits", "reshards"].map((k) => [k, new Tally(undefined)])
  ) as unknown as StreamTallies
  const fast = {
    settings: () => config,
    now: () => now,
    random: SeededRandom.make(1),
    after: () => ({ cancel: () => {} }),
    mint: () => ({}) as Message,
    account: () => ({ kinesisOnDemandWriteMBps: 200 })
  } as unknown as Fast<StreamConfig>
  const m = new StreamModel({ id: "s", fast, tallies: t, discard: () => {} })
  return { m, t, advance: (ms: number) => void (now += ms) }
}

const message = (count: number, bytes: number, key = 0.5): Message => ({ id: 1, bornAt: 0, origin: "web", attempt: 1, bytes, count, invocation: "sync", operation: "write", key })

describe("aws.kinesis: writes", () => {
  it("PutRecords: up to 500 records and 10 MiB, spread over the shards by key, failing record by record", () => {
    const { m, t } = model({ shards: 4 })
    expect(m.put(message(501, 501))).toMatchObject({ _tag: "Rejected" })
    expect(m.put(message(10, 11 * MiB))).toMatchObject({ _tag: "Rejected" })
    expect(m.put(message(1, 2 * MiB))).toMatchObject({ _tag: "Rejected" }) // over the 1 MiB default record size
    expect(m.put(message(500, 500 * 100))).toBeUndefined()
    expect(t.incoming.total).toBe(500)
    for (const shard of m.openShards()) expect(shard.offeredRecords).toBe(125) // a quarter each
    // Four shards take 4,000 records in a second: seven more batches fit, the ninth fits nowhere.
    for (let i = 0; i < 7; i++) expect(m.put(message(500, 500 * 100))).toBeUndefined()
    expect(m.put(message(500, 500 * 100))).toMatchObject({ _tag: "Throttled" })
    expect(t.throttled.total).toBe(500)
  })

  it("PutRecords is not atomic: a busy shard fails its records and the rest are stored", () => {
    const { m, t } = model({ shards: 2 })
    // Fill the first shard (keys below 0.5) with single writes.
    for (let i = 0; i < 1_000; i++) m.put(message(1, 100, 0.1))
    const reply = m.put(message(100, 100 * 100))
    expect(reply).toMatchObject({ _tag: "ItemFailures" })
    const failed = (reply as { failed: ReadonlyArray<number> }).failed
    expect(failed.length).toBeGreaterThan(40)
    expect(failed.length).toBeLessThan(60)
    expect(t.incoming.total).toBe(1_000 + 100 - failed.length)
  })

  it("a record up to the stream's maximum record size is taken, drawing on the shard's burst", () => {
    const { m, advance } = model({ shards: 1, maxRecordSize: 10_240 })
    expect(m.put(message(1, 10 * MiB))).toBeUndefined()
    // The burst is spent: writes are throttled until the shard has refilled, at 1 MiB a second.
    expect(m.put(message(1, 600 * 1024))).toMatchObject({ _tag: "Throttled" })
    advance(1_000)
    expect(m.put(message(1, 600 * 1024))).toBeUndefined()
    expect(m.put(message(1, 600 * 1024))).toMatchObject({ _tag: "Throttled" })
  })
})

describe("aws.kinesis: lanes", () => {
  const segment = (slices: ReadonlyArray<number>): Segment => {
    const s = new Int32Array(SLICES)
    slices.forEach((n, i) => (s[i] = n))
    return { at: 0, last: 0, readyAt: 0, count: slices.reduce((a, b) => a + b, 0), bytes: 1, born: 0, bornLast: 0, slices: s }
  }

  it("lanes split a segment's records by key and always add up to its count", () => {
    const seg = segment([7, 3, 9, 1, 0, 4, 6, 2, 8, 5])
    for (let lanes = 1; lanes <= 10; lanes++) {
      let sum = 0
      for (let lane = 0; lane < lanes; lane++) {
        const n = laneCount(seg, lane, lanes)
        expect(n).toBeGreaterThanOrEqual(0)
        sum += n
      }
      expect(sum).toBe(seg.count)
    }
  })

  it("a hot key's records stay in one lane", () => {
    const seg = segment([0, 0, 0, 120, 0, 0, 0, 0, 0, 0])
    expect(laneCount(seg, 0, 2)).toBe(120)
    expect(laneCount(seg, 1, 2)).toBe(0)
    expect(laneCount(seg, 1, 5)).toBe(120)
  })
})

describe("aws.kinesis: hardening", () => {
  it("odd messages: no records stores nothing, negative bytes count as none, a key that isn't a number lands on the first shard", () => {
    const { m, t } = model({ shards: 2 })
    expect(m.put(message(0, 100))).toBeUndefined()
    expect(m.put({ ...message(1, -5), key: Number.NaN })).toBeUndefined()
    expect(t.incoming.total).toBe(1)
    expect(t.incomingBytes.total).toBe(0)
    expect(m.openShards()[0]!.offeredRecords).toBe(1)
    expect(m.put({ ...message(1, 10), key: 1.5 })).toBeUndefined() // out of range: the last shard
    expect(m.openShards()[1]!.offeredRecords).toBe(1)
  })
})
