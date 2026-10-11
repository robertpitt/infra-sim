import { describe, expect, it } from "vitest"
import { DedupWindow } from "./Dedup.ts"

describe("DedupWindow", () => {
  it("recognises an id seen within the window and forgets it after", () => {
    const window = new DedupWindow(300_000, 1_000)
    expect(window.isDuplicate(1, 0)).toBe(false)
    expect(window.isDuplicate(1, 299_999)).toBe(true)
    expect(window.isDuplicate(1, 300_000)).toBe(false) // five minutes after it was first accepted
  })

  it("expires what is old as it goes, so memory follows the window", () => {
    const window = new DedupWindow(1_000, 1_000_000)
    for (let i = 0; i < 10_000; i++) window.isDuplicate(i, i)
    expect(window.size).toBeLessThanOrEqual(1_001)
  })

  it("never remembers more than its capacity, shortening the window instead", () => {
    const window = new DedupWindow(300_000, 100)
    for (let i = 0; i < 1_000; i++) window.isDuplicate(i, 0)
    expect(window.size).toBe(100)
    expect(window.isDuplicate(999, 1)).toBe(true) // the newest are kept
    expect(window.isDuplicate(0, 1)).toBe(false) // the oldest were dropped
  })
})
