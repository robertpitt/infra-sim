import { describe, expect, it } from "vitest"
import { DeduplicationWindow, GroupRates, SerialLanes } from "./fifo.ts"

describe("GroupRates", () => {
  it("lets a group publish 300 a second and refuses the 301st", () => {
    const rates = new GroupRates(300)
    expect(rates.take("g", 300, 0)).toBe(true)
    expect(rates.take("g", 1, 0)).toBe(false)
    expect(rates.take("g", 1, 1_000 / 300 + 1)).toBe(true) // refilled at 300 a second
    expect(rates.take("other", 300, 0)).toBe(true) // groups do not share a bucket
  })

  it("lets a batch bigger than the bucket have the whole bucket rather than never succeed", () => {
    const rates = new GroupRates(300)
    expect(rates.take("g", 1_000, 0)).toBe(true)
    expect(rates.take("g", 1, 0)).toBe(false)
  })

  it("forgets groups that have gone quiet, so a stream of new group ids does not grow it without bound", () => {
    const rates = new GroupRates(300)
    let now = 0
    for (let i = 0; i < 200_000; i++) {
      rates.take(`group-${i}`, 1, now)
      now += 1 // a thousand new groups a second
    }
    expect(rates.size).toBeLessThan(10_000)
  })

  it("keeps a busy group's bucket through a sweep", () => {
    const rates = new GroupRates(300)
    expect(rates.take("busy", 300, 0)).toBe(true)
    // Groups that take nothing stay full, so a sweep forgets them; the drained group must survive it.
    for (let i = 0; i < 5_000; i++) rates.take(`other-${i}`, 0, 1)
    expect(rates.size).toBeLessThan(5_000)
    expect(rates.take("busy", 1, 1)).toBe(false) // still nearly empty: it was not swept and reset to full
  })
})

describe("SerialLanes", () => {
  it("runs one task at a time per key, in order, and different keys side by side", () => {
    const lanes = new SerialLanes()
    const log: Array<string> = []
    const releases: Record<string, () => void> = {}
    const task = (name: string) => (release: () => void) => {
      log.push(`start ${name}`)
      releases[name] = release
    }
    lanes.run("a", task("a1"))
    lanes.run("a", task("a2"))
    lanes.run("b", task("b1"))
    expect(log).toEqual(["start a1", "start b1"])
    releases.a1!()
    expect(log).toEqual(["start a1", "start b1", "start a2"])
    expect(lanes.open).toBe(2)
  })

  it("leaves no lane behind once its work is done, and ignores a second release", () => {
    const lanes = new SerialLanes()
    let release: () => void = () => {}
    for (let i = 0; i < 1_000; i++) lanes.run(`g${i}`, (done) => (release = done))
    expect(lanes.open).toBe(1_000)
    const releases: Array<() => void> = []
    const fresh = new SerialLanes()
    for (let i = 0; i < 100; i++) fresh.run(`g${i}`, (done) => releases.push(done))
    for (const done of releases) {
      done()
      done() // releasing twice must not start work that is not there or corrupt the lane
    }
    expect(fresh.open).toBe(0)
    release()
  })
})

describe("DeduplicationWindow", () => {
  it("recognises an id seen within the window and forgets it after", () => {
    const window = new DeduplicationWindow(300_000, 1_000)
    expect(window.isDuplicate(1, 0)).toBe(false)
    expect(window.isDuplicate(1, 299_999)).toBe(true)
    expect(window.isDuplicate(1, 300_000)).toBe(false) // five minutes after it was first accepted
  })

  it("expires what is old as it goes, so memory follows the window", () => {
    const window = new DeduplicationWindow(1_000, 1_000_000)
    for (let i = 0; i < 10_000; i++) window.isDuplicate(i, i)
    expect(window.size).toBeLessThanOrEqual(1_001)
  })

  it("never remembers more than its capacity, shortening the window instead", () => {
    const window = new DeduplicationWindow(300_000, 100)
    for (let i = 0; i < 1_000; i++) window.isDuplicate(i, 0)
    expect(window.size).toBe(100)
    expect(window.isDuplicate(999, 1)).toBe(true) // the newest are kept
    expect(window.isDuplicate(0, 1)).toBe(false) // the oldest were dropped
  })
})
