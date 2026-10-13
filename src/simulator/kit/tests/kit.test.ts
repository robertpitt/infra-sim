import { describe, expect, it } from "vitest"
import { Gate } from "../Admit.ts"
import * as Limiter from "../../Limiter.ts"
import type { Message } from "../../Message.ts"
import { Outbox } from "../Outbox.ts"
import { chance, mix, passes, records } from "../Shape.ts"
import { counters, tallies, totals } from "../Tally.ts"

/** A random source that says each number in turn, and counts how many it was asked for. */
const dice = (...values: Array<number>) => {
  let i = 0
  return { drawn: () => i, nextDoubleUnsafe: () => values[i++] ?? 0 }
}

describe("Gate", () => {
  const limiter = Limiter.makeWith(() => 0)
  const wide = { rate: 10, burst: 10 }
  const narrow = { rate: 1, burst: 1 }

  it("takes from every limit when all admit, and reports nothing", () => {
    const gate = new Gate(limiter)
    expect(gate.add("a", wide, 3, "a").add("b", wide, 3, "b").take()).toBeUndefined()
    expect(limiter.levelUnsafe("a", wide)).toBe(7)
    expect(limiter.levelUnsafe("b", wide)).toBe(7)
  })

  it("takes from none when one refuses, and names the first that did", () => {
    const gate = new Gate(limiter)
    limiter.takeUnsafe("d", narrow) // d is empty now, and so is e
    limiter.takeUnsafe("e", narrow)
    expect(gate.add("c", wide, 3, "c").add("d", narrow, 2, "d-narrow").add("e", narrow, 2, "e-narrow").take()).toBe("d-narrow")
    expect(limiter.levelUnsafe("c", wide)).toBe(10) // the wide bucket was not spent
  })

  it("starts each call afresh", () => {
    const gate = new Gate(limiter)
    gate.add("f", narrow, 1, "f").take()
    expect(gate.add("g", wide, 1, "g").take()).toBeUndefined()
  })
})

describe("Shape", () => {
  it("counts a message that stands for nothing as one record", () => {
    expect(records({ count: 0 } as Message)).toBe(1)
    expect(records({ count: 5 } as Message)).toBe(5)
  })

  it("draws nothing when there is no share to draw against", () => {
    const d = dice(0.5)
    expect(passes(d, 1)).toBe(true)
    expect(chance(d, 0)).toBe(false)
    expect(mix(d, "rest", "a", 0, "b", 0)).toBe("rest")
    expect(d.drawn()).toBe(0)
  })

  it("picks by share, with the remainder going to the rest", () => {
    expect(mix(dice(0.05), "rest", "a", 0.1, "b", 0.2)).toBe("a")
    expect(mix(dice(0.2), "rest", "a", 0.1, "b", 0.2)).toBe("b")
    expect(mix(dice(0.9), "rest", "a", 0.1, "b", 0.2)).toBe("rest")
    expect(passes(dice(0.6), 0.5)).toBe(false)
  })
})

describe("Tally", () => {
  it("counts a window and a running total, and totals-only when there is no meter", () => {
    const seen: Record<string, { n: number }> = {}
    const meter = { counter: (name: string) => (seen[name] ??= { n: 0 }) } as never
    const t = tallies(meter, ["a", "b"])
    t.a.add(2)
    t.a.add(3)
    expect(seen.a!.n).toBe(5)
    expect(totals(t)).toEqual({ a: 5, b: 0 })
    const silent = tallies(undefined, ["x"])
    silent.x.add(4)
    expect(totals(silent)).toEqual({ x: 4 })
    expect(counters(meter, ["c"]).c).toBe(seen.c)
  })
})

describe("Outbox", () => {
  it("sends after the delay, counts the outcome in records, and tracks what is pending", () => {
    const timers: Array<[number, (arg: unknown) => void, unknown]> = []
    const fast = { after: (ms: number, fire: (arg: unknown) => void, arg: unknown) => void timers.push([ms, fire, arg]) } as never
    const t = tallies(undefined, ["ok", "bad"])
    const outbox = new Outbox(fast, t.ok, t.bad)
    const answers: Array<(failure: undefined | { _tag: "Failed" }) => void> = []
    const link = { send: (_m: Message, done: never) => void answers.push(done) }
    const heard: Array<unknown> = []

    outbox.send(link as never, {} as Message, 50, 3, (f) => heard.push(f))
    outbox.send(link as never, {} as Message, 0, 2)
    expect(outbox.pending).toBe(2)
    expect(answers.length).toBe(1) // no delay: sent at once
    expect(timers[0]![0]).toBe(50)
    timers[0]![1](timers[0]![2])
    expect(answers.length).toBe(2)

    answers[0]!(undefined)
    answers[1]!({ _tag: "Failed" })
    expect(outbox.pending).toBe(0)
    expect(totals(t)).toEqual({ ok: 2, bad: 3 })
    expect(heard).toEqual([{ _tag: "Failed" }])
  })
})
