import { describe, expect, it } from "vitest"
import { Family, keyOf } from "./Family.ts"
import { Slots } from "./kit/Slots.ts"

describe("Family: instances by key, made on first use, evicted when idle", () => {
  const make = (idle = 1_000) => {
    let now = 0
    const evicted: Array<string> = []
    const family = new Family({ now: () => now, idleMs: () => idle, create: (key) => ({ key }), evicted: (key) => evicted.push(key) })
    return { family, evicted, at: (t: number) => void (now = t) }
  }

  it("makes an instance the first time a key is used, and reuses it while it is warm", () => {
    const { family, at } = make()
    const first = family.enter("a")
    expect(first.cold).toBe(true)
    family.leave("a")
    at(500)
    const again = family.enter("a")
    expect(again.cold).toBe(false)
    expect(again.instance).toBe(first.instance)
    expect(family.created).toBe(1)
  })

  it("evicts an instance idle past its lifetime: the next use is cold", () => {
    const { family, evicted, at } = make()
    family.enter("a")
    family.leave("a")
    at(1_000)
    expect(family.enter("a").cold).toBe(true)
    expect(evicted).toEqual(["a"])
    expect(family.evictions).toBe(1)
  })

  it("never evicts an instance with work in progress, however long it runs", () => {
    const { family, at } = make()
    family.enter("a")
    at(10_000)
    expect(family.size).toBe(1)
    expect(family.enter("a").cold).toBe(false)
  })

  it("forgets every idle instance at once when asked how many there are", () => {
    const { family, at } = make()
    for (const key of ["a", "b", "c"]) {
      family.enter(key)
      family.leave(key)
    }
    family.enter("d")
    at(2_000)
    expect(family.size).toBe(1) // only the busy one
    expect(family.peek("a")).toBeUndefined()
  })

  it("maps a partition key hash onto a fixed number of keys", () => {
    expect(keyOf(0, 10)).toBe("0")
    expect(keyOf(0.999, 10)).toBe("9")
    expect(keyOf(1, 10)).toBe("9")
    expect(keyOf(0.55, 10)).toBe("5")
  })
})

describe("Slots: a number of workers and a line waiting for them", () => {
  it("starts work while there are free slots, queues the rest in order, refuses past the limit", () => {
    const started: Array<number> = []
    const slots = new Slots(() => 2, () => 2)
    for (let i = 0; i < 5; i++) {
      const placed = slots.acquire(() => started.push(i))
      if (i === 4) expect(placed).toBeUndefined()
    }
    expect(started).toEqual([0, 1])
    expect(slots.queued).toBe(2)
    slots.release()
    expect(started).toEqual([0, 1, 2])
    slots.release()
    slots.release()
    expect(started).toEqual([0, 1, 2, 3])
    expect(slots.queued).toBe(0)
  })

  it("skips work that gave up its place in line", () => {
    const started: Array<string> = []
    const slots = new Slots(() => 1, () => 10)
    slots.acquire(() => started.push("a"))
    const leave = slots.acquire(() => started.push("b"))!
    slots.acquire(() => started.push("c"))
    leave()
    expect(slots.queued).toBe(1)
    slots.release()
    expect(started).toEqual(["a", "c"])
  })

  it("starts waiting work at once when it gets more slots", () => {
    let capacity = 1
    const started: Array<number> = []
    const slots = new Slots(() => capacity, () => 10)
    for (let i = 0; i < 4; i++) slots.acquire(() => started.push(i))
    capacity = 3
    slots.kick()
    expect(started).toEqual([0, 1, 2])
    expect(slots.running).toBe(3)
  })
})
