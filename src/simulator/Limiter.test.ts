import { Effect, Fiber } from "effect"
import { describe, expect, it } from "vitest"
import * as Limiter from "./Limiter.ts"
import * as VirtualTime from "./VirtualTime.ts"

const inWorld = async <A>(body: (limiter: Limiter.Limiter, advance: (ms: number) => Effect.Effect<void>) => Effect.Effect<A>) => {
  const world = VirtualTime.make()
  const program = Effect.gen(function*() {
    const limiter = yield* Limiter.make
    return yield* body(limiter, (ms) => world.advanceTo(world.nowUnsafe() + ms))
  })
  return Effect.runPromise(Effect.flatMap(world.fork(program), Fiber.join))
}

describe("Limiter", () => {
  const bucket = { rate: 10, burst: 5 }

  it("lets a full bucket be spent at once, then refuses", () =>
    inWorld((l) =>
      Effect.gen(function*() {
        const results = []
        for (let i = 0; i < 7; i++) results.push(yield* l.take("k", bucket))
        expect(results).toEqual([true, true, true, true, true, false, false])
      })
    ))

  it("refills at the steady rate", () =>
    inWorld((l, advance) =>
      Effect.gen(function*() {
        for (let i = 0; i < 5; i++) yield* l.take("k", bucket)
        expect(yield* l.take("k", bucket)).toBe(false)
        yield* advance(300) // 10/s x 0.3 s = 3 tokens
        const after = []
        for (let i = 0; i < 4; i++) after.push(yield* l.take("k", bucket))
        expect(after).toEqual([true, true, true, false])
      })
    ))

  it("reads the level without spending, and keeps separate buckets per key", () =>
    inWorld((l) =>
      Effect.gen(function*() {
        yield* l.take("a", bucket, 3)
        expect(Math.round(yield* l.level("a", bucket))).toBe(2)
        expect(Math.round(yield* l.level("a", bucket))).toBe(2)
        expect(Math.round(yield* l.level("b", bucket))).toBe(5)
      })
    ))

  it("follows a changed quota immediately", () =>
    inWorld((l) =>
      Effect.gen(function*() {
        yield* l.take("k", bucket, 5)
        expect(yield* l.take("k", bucket)).toBe(false)
        // A bigger burst is only more headroom: the tokens already spent stay spent.
        expect(yield* l.take("k", { rate: 10, burst: 50 })).toBe(false)
      })
    ))

  it("forgets buckets that have refilled completely, so per-key buckets don't grow without bound", () =>
    inWorld((l, advance) =>
      Effect.gen(function*() {
        const small = { rate: 100, burst: 10 }
        // A great many keys, each touched once (per group, per prefix, per caller).
        for (let i = 0; i < 3_000; i++) yield* l.take(`key-${i}`, small)
        expect(l.size()).toBeGreaterThan(2_000)
        yield* advance(60_000) // every one of them has long since refilled
        yield* l.take("fresh", small)
        yield* advance(11_000)
        yield* l.take("fresh-2", small) // a new key after the sweep interval triggers the sweep
        expect(l.size()).toBeLessThan(50)
      })
    ))

  it("never forgets a bucket that still has something to remember", () =>
    inWorld((l, advance) =>
      Effect.gen(function*() {
        const slow = { rate: 1, burst: 100 }
        for (let i = 0; i < 2_000; i++) yield* l.take(`k-${i}`, slow, 60) // each spent 60 of 100 tokens and needs a minute to refill
        yield* advance(11_000)
        yield* l.take("trigger", slow)
        expect(l.size()).toBeGreaterThan(2_000)
        // and the ones kept are still exact
        expect(Math.round(yield* l.level("k-5", slow))).toBe(51)
      })
    ))
})
