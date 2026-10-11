import { describe, expect, it } from "vitest"
import { OnDemandScaler } from "./scaling.ts"
import { entryBytes, indexReadUnits, indexWriteUnits, readUnits, writeUnits } from "./units.ts"

const SECOND = 1_000
const INTERVAL = 30 * 60 * SECOND

/** A scaler with AWS's write baseline, driven by hand: `use(t, units)` is units consumed in the second starting at t. */
const writes = (baseline = 4_000, interval = INTERVAL) => {
  const changes = { n: 0 }
  const scaler = new OnDemandScaler(changes)
  scaler.configure(baseline, interval)
  return { scaler, changes, use: (t: number, units: number) => scaler.record(t, units) }
}

describe("on-demand scaler", () => {
  it("a new table absorbs its baseline, and double its previous peak once it has reached it", () => {
    const { scaler, use } = writes()
    expect(scaler.ceiling(0)).toBe(4_000)
    use(0, 4_000)
    expect(scaler.ceiling(SECOND)).toBe(8_000) // 4,000 is now the previous peak
  })

  it("does not take a doubled ceiling as a new peak until a scale-out interval has passed", () => {
    const { scaler, use } = writes()
    use(0, 4_000)
    use(SECOND, 8_000)
    expect(scaler.ceiling(2 * SECOND)).toBe(8_000) // 8,000 was reached, but it may not double again yet
    expect(scaler.peak).toBe(8_000)
    expect(scaler.ceiling(INTERVAL - SECOND)).toBe(8_000)
    expect(scaler.ceiling(INTERVAL + SECOND)).toBe(16_000) // 30 minutes later the peak counts
  })

  it("doubles once per interval, not once per second, however hard it is pushed", () => {
    const { scaler, use } = writes(4_000, 60 * SECOND)
    const seen: Array<number> = []
    for (let t = 0; t <= 5 * 60 * SECOND; t += SECOND) {
      use(t, scaler.ceiling(t)) // always consuming everything it is allowed
      if (t % (60 * SECOND) === 0) seen.push(scaler.ceiling(t))
    }
    // The baseline at first (nothing consumed yet), then one doubling a minute: 16,000, 32,000, ...
    expect(seen.slice(0, 5)).toEqual([4_000, 16_000, 32_000, 64_000, 128_000])
  })

  it("never forgets the previous peak: the same load comes back instantly, hours later", () => {
    const { scaler, use } = writes(4_000, 60 * SECOND)
    for (let t = 0; t <= 10 * 60 * SECOND; t += SECOND) use(t, scaler.ceiling(t))
    const scaled = scaler.ceiling(10 * 60 * SECOND)
    expect(scaled).toBeGreaterThan(8_000)
    // Hours later it is no lower (the peak is kept; the ceiling may even catch up with it, never fall behind it).
    expect(scaler.ceiling(10 * 60 * SECOND + 6 * 60 * 60 * SECOND)).toBeGreaterThanOrEqual(scaled)
  })

  it("starts from a pre-warmed baseline, and a baseline raised later takes effect at once", () => {
    const { scaler } = writes(50_000)
    expect(scaler.ceiling(0)).toBe(50_000)
    scaler.configure(100_000, INTERVAL)
    expect(scaler.ceiling(SECOND)).toBe(100_000)
  })

  it("only reports a change when the ceiling may have moved, so memoised capacity stays valid", () => {
    const { scaler, changes, use } = writes()
    scaler.configure(4_000, INTERVAL)
    const before = changes.n
    use(0, 100)
    use(0, 100)
    scaler.ceiling(500)
    expect(changes.n).toBe(before) // nothing moved: still the baseline
    use(SECOND, 4_000)
    scaler.ceiling(2 * SECOND)
    expect(changes.n).toBeGreaterThan(before)
  })

  it("keeps constant memory however long it runs", () => {
    const { scaler, use } = writes(4_000, 60 * SECOND)
    // A day of one-second samples: the scaler holds a handful of numbers, not a window of samples.
    for (let t = 0; t < 24 * 60 * 60 * SECOND; t += 60 * SECOND) use(t, 10)
    expect(Object.keys(scaler)).toHaveLength(Object.keys(writes().scaler).length)
  })
})

describe("capacity unit maths", () => {
  it("rounds each item up to 4 KB for reads and 1 KB for writes", () => {
    expect(readUnits(3_500, 1, "strong")).toBe(1)
    expect(readUnits(4_097, 1, "strong")).toBe(2)
    expect(readUnits(10 * 1024, 1, "strong")).toBe(3)
    expect(writeUnits(500, 1, false)).toBe(1)
    expect(writeUnits(1_025, 1, false)).toBe(2)
  })

  it("prices consistency: half a unit eventually consistent, one strong, two transactional", () => {
    expect(readUnits(4_096, 1, "eventual")).toBe(0.5)
    expect(readUnits(4_096, 1, "strong")).toBe(1)
    expect(readUnits(4_096, 1, "transactional")).toBe(2)
    expect(readUnits(8_192, 1, "strong")).toBe(2) // an 8 KB item needs 2 units, as AWS's own example says
  })

  it("doubles transactional writes", () => {
    expect(writeUnits(1_024, 1, true)).toBe(2)
    expect(writeUnits(2_048, 1, true)).toBe(4)
  })

  it("rounds each item of a batch, then adds: 500 B and 3.5 KB write as 1 + 4 units, not 4", () => {
    // AWS's BatchWriteItem example: items are rounded individually. Two items averaging 2,000 B are 2 + 2, the
    // average-size shortcut the simulator uses for a batch message.
    expect(writeUnits(2_000, 2, false)).toBe(4)
    expect(readUnits(4_000, 25, "eventual")).toBe(12.5)
  })

  it("charges at least one unit for an empty item, and scales with the number of items", () => {
    expect(writeUnits(0, 1, false)).toBe(1)
    expect(readUnits(0, 4, "strong")).toBe(4)
  })

  it("index writes: one per touched index entry, two when the key moves, per KB of entry", () => {
    expect(indexWriteUnits(500, 1, 1, 0)).toBe(1)
    expect(indexWriteUnits(500, 1, 1, 1)).toBe(2) // delete the old entry and put the new one
    expect(indexWriteUnits(500, 1, 0.5, 0)).toBe(0.5) // half the writes don't touch the index
    expect(indexWriteUnits(3_000, 2, 1, 0)).toBe(6) // 3 KB entries, two items
    expect(entryBytes(0, 3_000)).toBe(3_000) // ALL projection follows the item
    expect(entryBytes(200, 3_000)).toBe(200)
  })

  it("index reads are one Query: entries are added up, then rounded to 4 KB (AWS's own example: 8 x 2,000 B is 2 units)", () => {
    expect(indexReadUnits(2_000, 8)).toBe(2)
    expect(indexReadUnits(100, 1)).toBe(0.5)
  })
})
