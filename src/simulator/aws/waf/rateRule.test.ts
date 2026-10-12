import { describe, expect, it } from "vitest"
import { MAX_RATE_LIMITED } from "./config.ts"
import { addressOf, makeRateTracker } from "./rateRule.ts"

/** The key that lands on address `a` of `n`. */
const keyOf = (a: number, n: number): number => (a + 0.5) / n

describe("aws.waf: the rate-based rule's counting", () => {
  it("maps a key to an address, and odd keys to an end rather than nowhere", () => {
    expect(addressOf(0, 100)).toBe(0)
    expect(addressOf(0.999, 100)).toBe(99)
    expect(addressOf(1, 100)).toBe(99)
    expect(addressOf(-0.5, 100)).toBe(0)
    expect(addressOf(Number.NaN, 100)).toBe(0)
    expect(addressOf(0.1234, 1)).toBe(0)
  })

  it("counts an address over exactly the window, slice by slice, and forgets what falls out of it", () => {
    const t = makeRateTracker()
    t.configure({ limit: 10, slices: 3, addresses: 4 })
    for (let i = 0; i < 11; i++) t.see("bot", keyOf(2, 4))
    expect(t.evaluate().addresses).toEqual([2])
    expect(t.busiest()).toBe(11)
    // Two more slices and the eleven are still inside the window; the third drops them.
    t.advance()
    t.advance()
    expect(t.evaluate().addresses).toEqual([2])
    t.advance()
    expect(t.evaluate().addresses).toEqual([])
    expect(t.busiest()).toBe(0)
  })

  it("limits only past the limit, not at it", () => {
    const t = makeRateTracker()
    t.configure({ limit: 10, slices: 6, addresses: 1 })
    for (let i = 0; i < 10; i++) t.see("a", 0.5)
    expect(t.evaluate().addresses).toEqual([])
    t.see("a", 0.5)
    expect(t.evaluate().addresses).toEqual([0])
  })

  it("keeps each traffic source's addresses apart", () => {
    const t = makeRateTracker()
    t.configure({ limit: 5, slices: 6, addresses: 10 })
    for (let i = 0; i < 6; i++) t.see("bot", 0.15)
    for (let i = 0; i < 5; i++) t.see("users", 0.15)
    const d = t.evaluate()
    t.apply(d)
    expect(t.limitedCount()).toBe(1)
    expect(t.see("bot", 0.15)).toBe(true)
    expect(t.see("users", 0.15)).toBe(false)
    expect(t.sources()).toBe(2)
  })

  it("rate limits at most 10,000 addresses, the busiest first", () => {
    const t = makeRateTracker()
    const n = 12_000
    t.configure({ limit: 1, slices: 6, addresses: n })
    // Address a gets 2 requests, plus 1 more for the top 3,000: those must all be kept.
    for (let a = 0; a < n; a++) {
      t.see("botnet", keyOf(a, n))
      t.see("botnet", keyOf(a, n))
      if (a >= n - 3_000) t.see("botnet", keyOf(a, n))
    }
    const d = t.evaluate()
    expect(d.addresses.length).toBe(MAX_RATE_LIMITED)
    const kept = new Set(d.addresses)
    for (let a = n - 3_000; a < n; a++) expect(kept.has(a)).toBe(true)
    t.apply(d)
    expect(t.limitedCount()).toBe(MAX_RATE_LIMITED)
  })

  it("ignores a decision made before a reset, or older than one already applied", () => {
    const t = makeRateTracker()
    t.configure({ limit: 1, slices: 6, addresses: 1 })
    t.see("a", 0.5)
    t.see("a", 0.5)
    const early = t.evaluate()
    const later = t.evaluate()
    t.apply(later)
    expect(t.limitedCount()).toBe(1)
    t.apply(early)
    expect(t.limitedCount()).toBe(1)
    // A new limit resets the counts, and what was decided before it no longer applies.
    const before = t.evaluate()
    t.configure({ limit: 2, slices: 6, addresses: 1 })
    expect(t.limitedCount()).toBe(0)
    t.apply(before)
    expect(t.limitedCount()).toBe(0)
    expect(t.see("a", 0.5)).toBe(false)
  })

  it("keeps its counts when given the same settings, and forgets everything when turned off", () => {
    const t = makeRateTracker()
    const spec = { limit: 1, slices: 6, addresses: 1 }
    t.configure(spec)
    t.see("a", 0.5)
    t.see("a", 0.5)
    t.configure({ ...spec })
    expect(t.evaluate().addresses).toEqual([0])
    t.configure(undefined)
    expect(t.see("a", 0.5)).toBe(false)
    expect(t.sources()).toBe(0)
    expect(t.evaluate().addresses).toEqual([])
  })
})
