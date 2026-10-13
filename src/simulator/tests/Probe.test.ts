import { Effect, Fiber, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../Builder.ts"
import { sim } from "../testing.ts"
import { Inspection } from "../Simulation.ts"

const backlog = () => {
  const b = Builder.make("backlog", { seed: 8 })
  const web = b.add("common.client", { id: "web", settings: { rps: 50, arrival: "constant" } })
  const q = b.add("aws.sqs", { id: "q", settings: { visibilityTimeout: "10 minutes" } })
  const worker = b.add("aws.lambda", { id: "worker", settings: { memory: 1769, reserved: { enabled: true, concurrency: 2 }, duration: { mean: 100, cv: 0 } } })
  const table = b.add("aws.dynamodb", { id: "table", settings: { writeCapacity: 10, burstSeconds: 1 } })
  b.connect(web, q)
  b.connect(q.port("deliver"), worker, { batchSize: 1, maxConcurrency: 2 })
  b.connect(worker, table)
  return b.build()
}

describe("probing a running simulation", () => {
  it("shows a queue's internal state: what is waiting, what is in flight, how old, and a sample", () =>
    sim(backlog(), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(30_000)
        const probe = yield* s.probe("q")
        const state = probe.state as {
          ready: number
          hidden: number
          oldestAge: number
          totals: { enqueued: number; deleted: number }
          sample: ReadonlyArray<{ id: number; status: string; age: number }>
        }
        // 50 in, ~10 out (the table only does 10 a second): a growing backlog, and every delivery the table
        // refused is now hidden, waiting out its 10-minute visibility timeout before it can be tried again.
        expect(state.ready).toBeGreaterThan(300)
        expect(state.hidden).toBeGreaterThan(100)
        expect(state.oldestAge).toBeGreaterThan(10_000)
        expect(state.totals.enqueued).toBeGreaterThan(1400)
        expect(state.totals.deleted).toBeGreaterThan(250)
        expect(state.sample).toHaveLength(20)
        expect(state.sample[0]!.age).toBeGreaterThan(10_000)
        expect(probe.totals.in).toBe(state.totals.enqueued)
      })))

  it("shows a function's concurrency and a table's remaining burst", () =>
    sim(backlog(), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(30_000)
        const worker = (yield* s.probe("worker")).state as { concurrent: number; limit: number; invocations: number }
        expect(worker.limit).toBe(2)
        expect(worker.concurrent).toBeGreaterThan(0)
        expect(worker.invocations).toBeGreaterThan(100)
        const table = (yield* s.probe("table")).state as { writeTokens: number; served: { writes: number }; throttled: { writes: number } }
        expect(table.served.writes).toBeGreaterThan(100)
        expect(table.throttled.writes).toBeGreaterThan(0)
        expect(table.writeTokens).toBeLessThan(10) // the one-second burst is spent
      })))

  it("inspects everything at once, as plain JSON that matches its schema", () =>
    sim(backlog(), (s) =>
      Effect.gen(function*() {
        yield* s.faults.inject({ kind: "node", id: "table" }, { _tag: "Outage" })
        yield* s.advanceTo(5_000)
        const inspection = yield* s.inspect
        expect(inspection.t).toBe(5_000)
        expect(Object.keys(inspection.nodes).sort()).toEqual(["q", "table", "web", "worker"])
        expect(inspection.faults).toHaveLength(1)
        // Configuration comes back encoded: durations as milliseconds.
        expect((inspection.nodes.q!.config as { visibilityTimeout: number }).visibilityTimeout).toBe(600_000)
        // Round-trips through JSON and validates against its own schema.
        const wire = JSON.parse(JSON.stringify(inspection))
        expect(Schema.decodeUnknownSync(Inspection)(wire)).toEqual(inspection)
      })))

  it("reflects live configuration changes in the next inspection", () =>
    sim(backlog(), (s) =>
      Effect.gen(function*() {
        yield* s.configureNode("worker", { reserved: { enabled: true, concurrency: 7 } })
        const inspected = yield* s.inspect
        expect((inspected.nodes.worker!.config as { reserved: { concurrency: number } }).reserved.concurrency).toBe(7)
        expect((inspected.nodes.worker!.config as { memory: number }).memory).toBe(128) // everything else back to its default
        // The function follows the edit straight away.
        expect(((yield* s.probe("worker")).state as { limit: number }).limit).toBe(7)
      })))

  it("refuses invalid configuration with typed errors that say what is wrong", () =>
    sim(backlog(), (s) =>
      Effect.gen(function*() {
        const invalid = yield* Effect.flip(s.configureNode("worker", { memory: 0 }))
        expect(invalid._tag).toBe("InvalidConfig")
        expect(invalid._tag === "InvalidConfig" && invalid.issues.join(" ")).toMatch(/memory/)
        expect((yield* Effect.flip(s.configureNode("nope", {})))._tag).toBe("NoSuchNode")
        expect((yield* Effect.flip(s.configureEdge("nope", {})))._tag).toBe("NoSuchEdge")
        expect((yield* Effect.flip(s.probe("nope")))._tag).toBe("NoSuchNode")
      })))

  it("streams frames as they are produced", () =>
    sim(backlog(), (s) =>
      Effect.gen(function*() {
        const collected = yield* Effect.forkChild(Stream.runCollect(Stream.take(s.frames, 8)))
        yield* Effect.yieldNow
        yield* s.advanceTo(2_000)
        const frames = yield* Fiber.join(collected)
        expect(Array.from(frames).map((f) => f.t)).toEqual([250, 500, 750, 1000, 1250, 1500, 1750, 2000])
      })))
})
