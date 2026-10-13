import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../../Builder.ts"
import { frames, mean, sim } from "../../testing.ts"

interface ActorState {
  readonly instances: number
  readonly queued: number
  readonly coldStarts: number
  readonly evictions: number
  readonly served: number
  readonly overloaded: number
  readonly hottest: ReadonlyArray<{ object: string; queued: number; running: number }>
}

/** clients -> actors [-> a store each object calls] */
const actors = (load: Record<string, unknown>, settings: Record<string, unknown> = {}, store?: Record<string, unknown>) => {
  const b = Builder.make("actors", { seed: 12 })
  const web = b.add("common.client", { id: "web", settings: { arrival: "constant", ...load } })
  const objects = b.add("common.actor", { id: "objects", settings: { handlerTime: { mean: 5, cv: 0 }, coldStart: { mean: 10, cv: 0 }, fanOut: store === undefined ? "none" : "sequential", ...settings } })
  b.connect(web, objects, { timeout: "1 minute" })
  if (store !== undefined) b.connect(objects, b.add("common.http-endpoint", { id: "store", settings: store }))
  return b.build()
}
const stateOf = (s: Parameters<Parameters<typeof sim>[1]>[0]) => Effect.map(s.probe("objects"), (p) => p.state as ActorState)

describe("common.actor", () => {
  it("runs different keys side by side: spread traffic is served whatever its rate", async () => {
    const all = await frames(actors({ rps: 500 }), 20_000)
    expect(mean(all, "nodes", "objects", "rates", "ok", 5_000)).toBeCloseTo(500, -1)
    expect(mean(all, "nodes", "objects", "gauges", "queued", 5_000)).toBeLessThan(5)
  })

  it("runs one key one request at a time: a hot key is capped at one object's pace, and only its queue grows", () =>
    sim(actors({ rps: 200, hotKeys: 0.5 }, { handlerTime: { mean: 20, cv: 0 } }), (s) =>
      Effect.gen(function*() {
        const all = yield* s.advanceTo(20_000)
        // Half the traffic (100 a second) wants one object that does 50 a second at 20 ms: its queue fills, the rest is refused.
        expect(mean(all, "nodes", "objects", "rates", "fail.Unavailable", 10_000)).toBeCloseTo(50, -1)
        const state = yield* stateOf(s)
        expect(state.hottest[0]).toMatchObject({ queued: 100, running: 1 })
        expect(state.hottest[1]?.queued ?? 0).toBeLessThan(3)
      })))

  it("more threads per object raise a hot key's ceiling", async () => {
    const one = await frames(actors({ rps: 200, hotKeys: 0.5 }, { handlerTime: { mean: 20, cv: 0 } }), 20_000)
    const two = await frames(actors({ rps: 200, hotKeys: 0.5 }, { handlerTime: { mean: 20, cv: 0 }, concurrency: 2 }), 20_000)
    expect(mean(two, "nodes", "objects", "rates", "fail.Unavailable", 10_000)).toBeLessThan(mean(one, "nodes", "objects", "rates", "fail.Unavailable", 10_000) / 5)
  })

  it("cold starts follow the keys: a key touched less often than its idle lifetime is cold every time", () =>
    Effect.runPromise(
      Effect.gen(function*() {
        const run = (idle: string) =>
          Effect.promise(() => sim(actors({ rps: 20 }, { objects: 100, idle }), (s) => Effect.flatMap(s.advanceTo(60_000), () => stateOf(s))))
        // 100 objects at 20 a second: each is touched every 5 seconds on average.
        const short = yield* run("500 millis")
        const long = yield* run("1 hour")
        expect(short.coldStarts).toBeGreaterThan(1_000)
        expect(short.evictions).toBeGreaterThan(1_000)
        expect(long.coldStarts).toBeLessThanOrEqual(100)
        expect(long.evictions).toBe(0)
        expect(long.instances).toBe(100)
      })
    ))

  it("held busy while it calls its store, an object's pace is the store's; let go, it is the handler's", async () => {
    const store = { latency: { mean: 45, cv: 0 } }
    const held = await frames(actors({ rps: 100, hotKeys: 1 }, {}, store), 20_000)
    const free = await frames(actors({ rps: 100, hotKeys: 1 }, { holdDuringDownstream: false }, store), 20_000)
    // Every request is for one object. Held: about 50 ms each, 20 a second. Free: 5 ms each, all 100.
    expect(mean(held, "nodes", "objects", "rates", "ok", 10_000)).toBeLessThan(25)
    expect(mean(free, "nodes", "objects", "rates", "ok", 10_000)).toBeCloseTo(100, -1)
  })
})
