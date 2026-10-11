import { Effect, Fiber, Random, Ref, SubscriptionRef, MutableRef } from "effect"
import * as VT from "../src/simulator/VirtualTime.ts"

const N = 200_000
const world = VT.make()
const run = <A>(name: string, make: () => Effect.Effect<A>, n = N) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const t0 = performance.now()
      const fiber = yield* world.fork(Effect.gen(function*() { for (let i = 0; i < n; i++) yield* make() }))
      // drive virtual time until the fiber finishes
      let t = 0
      while (fiber.pollUnsafe() === undefined) { t += 1000; yield* world.advanceTo(t) }
      const ns = ((performance.now() - t0) * 1e6) / n
      console.log(name.padEnd(44), ns.toFixed(0).padStart(7), "ns/op")
    })
  )

const ref = MutableRef.make(0)
const sref = await Effect.runPromise(SubscriptionRef.make(1))
await run("sync (baseline loop)", () => Effect.sync(() => 1))
await run("MutableRef.increment via sync", () => Effect.sync(() => MutableRef.increment(ref)))
await run("SubscriptionRef.get", () => SubscriptionRef.get(sref))
await run("gen with 5 yields of sync", () => Effect.gen(function*() { yield* Effect.sync(() => 1); yield* Effect.sync(() => 1); yield* Effect.sync(() => 1); yield* Effect.sync(() => 1); yield* Effect.sync(() => 1) }))
await run("provideService(Random)", () => Effect.sync(() => 1).pipe(Effect.provideService(Random.Random, { nextDoubleUnsafe: () => 0.5, nextIntUnsafe: () => 1 } as any)))
await run("Random.next", () => Random.next)
await run("sleep(1) (virtual timer)", () => Effect.sleep(1), 100_000)
await run("sleep(1) + 2 timers racing", () => Effect.raceFirst(Effect.sleep(1), Effect.sleep(5000)), 20_000)
await run("forkDetach+join sync", () => Effect.flatMap(Effect.forkDetach(Effect.sync(() => 1)), Fiber.join), 50_000)
await run("catchDefect+tap+tapError+ensuring", () => Effect.sync(() => 1).pipe(Effect.catchDefect(() => Effect.void), Effect.tap(() => Effect.void), Effect.tapError(() => Effect.void), Effect.ensuring(Effect.void)))
await run("Effect.callback resume sync", () => Effect.callback<number>((resume) => { resume(Effect.succeed(1)) }))
process.exit(0)
