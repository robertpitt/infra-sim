import { Effect, Fiber } from "effect"
import { describe, expect, it } from "vitest"
import * as VirtualTime from "../VirtualTime.ts"

const world = () => VirtualTime.make()
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

describe("VirtualTime", () => {
  it("sleeps in virtual time, in order, without touching the wall clock", () =>
    run(Effect.gen(function*() {
      const w = world()
      const log: Array<[string, number]> = []
      const task = (name: string, ms: number) => Effect.sleep(ms).pipe(Effect.andThen(Effect.sync(() => log.push([name, w.nowUnsafe()]))))
      yield* w.fork(task("b", 200))
      yield* w.fork(task("a", 100))
      yield* w.fork(task("c", 200))
      const wall = Date.now()
      yield* w.advanceTo(10 * 60 * 1000)
      expect(Date.now() - wall).toBeLessThan(250)
      expect(log).toEqual([["a", 100], ["b", 200], ["c", 200]])
      expect(yield* w.now).toBe(600_000)
    })))

  it("runs only what is due and leaves the rest armed", () =>
    run(Effect.gen(function*() {
      const w = world()
      let fired = 0
      yield* w.fork(Effect.sleep(1000).pipe(Effect.andThen(Effect.sync(() => fired++))))
      yield* w.advanceTo(999)
      expect(fired).toBe(0)
      yield* w.advanceTo(1000)
      expect(fired).toBe(1)
    })))

  it("cancels timers when a fiber is interrupted", () =>
    run(Effect.gen(function*() {
      const w = world()
      let fired = 0
      const fiber = yield* w.fork(Effect.sleep(1000).pipe(Effect.andThen(Effect.sync(() => fired++))))
      yield* w.advanceTo(10)
      fiber.interruptUnsafe()
      yield* w.advanceTo(5000)
      expect(fired).toBe(0)
    })))

  it("supports timeouts and forever-loops on virtual time", () =>
    run(Effect.gen(function*() {
      const w = world()
      let ticks = 0
      let timedOut = false
      yield* w.fork(Effect.forever(Effect.sleep(10).pipe(Effect.andThen(Effect.sync(() => ticks++)))))
      yield* w.fork(Effect.never.pipe(Effect.timeoutOption(250), Effect.andThen(Effect.sync(() => (timedOut = true)))))
      yield* w.advanceTo(1000)
      expect(ticks).toBe(100)
      expect(timedOut).toBe(true)
    })))

  it("lets the outside await a fiber that lives in the world", () =>
    run(Effect.gen(function*() {
      const w = world()
      const fiber = yield* w.fork(Effect.sleep(500).pipe(Effect.as("done")))
      yield* w.advanceTo(500)
      expect(yield* Fiber.join(fiber)).toBe("done")
    })))

  it("is deterministic across runs", async () => {
    const trace = () =>
      run(Effect.gen(function*() {
        const w = world()
        const out: Array<number> = []
        for (let i = 0; i < 50; i++) yield* w.fork(Effect.sleep((i * 37) % 11).pipe(Effect.andThen(Effect.sync(() => out.push(i)))))
        yield* w.advanceTo(100)
        return out
      }))
    expect(await trace()).toEqual(await trace())
  })
})
