import { Effect, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as Builder from "./Builder.ts"
import { layer as components } from "./components/registry.ts"
import { Engine, type Event } from "./Engine.ts"

const design = () => {
  const b = Builder.make("pace", { seed: 1 })
  const web = b.add("common.client", { id: "web", settings: { rps: 50, arrival: "constant" } })
  const api = b.add("aws.lambda", { id: "api" })
  b.connect(web, api, undefined, { id: "web-api" })
  return b.build()
}

/** Run a test body with a fresh engine, a collector for everything it says, and a clock we control. */
const withEngine = <A, E>(body: (engine: Engine["Service"], events: Array<Event>) => Effect.Effect<A, E, TestClock.TestClock>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        const engine = yield* Engine
        const events: Array<Event> = []
        yield* Effect.forkChild(Stream.runForEach(engine.events, (e) => Effect.sync(() => void events.push(e))))
        yield* Effect.yieldNow
        return yield* body(engine, events)
      })
    ).pipe(Effect.provide(Engine.layer.pipe(Layer.provide(components))), Effect.provide(TestClock.layer()))
  )

const settle = Effect.yieldNow.pipe(Effect.andThen(Effect.yieldNow), Effect.andThen(Effect.yieldNow))
const tagged = <T extends Event["_tag"]>(events: ReadonlyArray<Event>, tag: T) => events.filter((e): e is Extract<Event, { _tag: T }> => e._tag === tag)
const lastStatus = (events: ReadonlyArray<Event>) => tagged(events, "status").at(-1)!.status
const framesOf = (events: ReadonlyArray<Event>) => tagged(events, "frames").flatMap((e) => e.frames)

describe("Engine", () => {
  it("tells you what components and connectors exist, how to configure edges, and which faults it can inject", () =>
    withEngine((engine) =>
      Effect.sync(() => {
        expect(engine.catalog.providers.map((p) => p.id)).toEqual(["internet", "aws"])
        // Every component is described, namespaced by provider; services come and go, so check what must be there.
        const types = engine.catalog.components.map((c) => c.type)
        expect(types).toEqual(expect.arrayContaining(["common.client", "common.http-endpoint", "aws.region", "aws.vpc", "aws.apigateway", "aws.lambda", "aws.sqs", "aws.sns", "aws.dynamodb", "aws.s3"]))
        expect(types.every((t) => /^(common|aws)\.[a-z0-9-]+$/.test(t))).toBe(true)
        expect(new Set(types).size).toBe(types.length)
        // The core connectors come first, then each provider's.
        const connectors = engine.catalog.connectors.map((c) => c.type)
        expect(connectors.slice(0, 2)).toEqual(["core.link", "core.poller"])
        expect(connectors).toContain("aws.sqs.event-source-mapping")
        expect(engine.catalog.connectors[0]!.settings.map((f) => f.key)).toEqual(["weight", "request", "timeout", "cancelOnTimeout", "retry"])
        expect(engine.catalog.transport.map((f) => f.key)).toEqual(["latency"])
        expect(engine.catalog.faults.map((f) => f.tag)).toEqual(["Outage", "Errors", "Slow", "Blackhole", "Loss"])
        // Forms are derived from the schemas, durations in milliseconds.
        const queue = engine.catalog.components.find((c) => c.type === "aws.sqs")!
        expect(queue.settings.find((f) => f.key === "visibilityTimeout")).toMatchObject({ kind: "duration", default: 30_000, unit: "ms" })
      })))

  it("loads a design paused at t=0 and says what it found", () =>
    withEngine((engine, events) =>
      Effect.gen(function*() {
        yield* engine.send({ _tag: "load", design: design() })
        yield* settle
        expect(tagged(events, "reset")).toHaveLength(1)
        expect(tagged(events, "diagnostics")[0]!.diagnostics).toEqual([])
        expect(lastStatus(events)).toMatchObject({ phase: "paused", t: 0, seed: 1 })
      })))

  it("paces virtual time by speed, and stops when paused", () =>
    withEngine((engine, events) =>
      Effect.gen(function*() {
        yield* engine.send({ _tag: "load", design: design() })
        yield* engine.send({ _tag: "setSpeed", speed: 10 })
        yield* engine.send({ _tag: "play" })
        yield* settle
        expect(lastStatus(events).phase).toBe("running")
        for (let i = 0; i < 50; i++) {
          yield* TestClock.adjust(16)
          yield* settle
        }
        // 50 ticks x 16 wall ms x speed 10 = 8 s of virtual time
        expect(lastStatus(events).t).toBeGreaterThan(5_000)
        expect(framesOf(events).length).toBeGreaterThan(10)
        yield* engine.send({ _tag: "pause" })
        yield* settle
        const t = framesOf(events).at(-1)!.t
        yield* TestClock.adjust(500)
        yield* settle
        expect(framesOf(events).at(-1)!.t).toBe(t)
        expect(lastStatus(events).phase).toBe("paused")
      })))

  it("keeps running when a new design is loaded while playing", () =>
    withEngine((engine, events) =>
      Effect.gen(function*() {
        yield* engine.send({ _tag: "load", design: design() })
        yield* engine.send({ _tag: "play" })
        yield* settle
        expect(lastStatus(events).phase).toBe("running")
        yield* engine.send({ _tag: "load", design: design() })
        yield* settle
        expect(tagged(events, "reset")).toHaveLength(2)
        expect(lastStatus(events)).toMatchObject({ phase: "running", t: 0 })
      })))

  it("reset rewinds to zero and reproduces the same frames", () =>
    withEngine((engine, events) =>
      Effect.gen(function*() {
        const run = Effect.gen(function*() {
          const before = framesOf(events).length
          yield* engine.send({ _tag: "step", ms: 5_000 })
          yield* settle
          return framesOf(events).slice(before)
        })
        yield* engine.send({ _tag: "load", design: design() })
        yield* settle
        const first = yield* run
        yield* engine.send({ _tag: "reset" })
        yield* settle
        const second = yield* run
        expect(first.length).toBeGreaterThan(10)
        expect(JSON.stringify(second)).toBe(JSON.stringify(first))
        expect(tagged(events, "reset")).toHaveLength(2)
      })))

  it("reports design errors instead of running", () =>
    withEngine((engine, events) =>
      Effect.gen(function*() {
        const bad = Builder.make("bad")
        bad.add("nonexistent")
        yield* engine.send({ _tag: "load", design: bad.build() })
        yield* engine.send({ _tag: "play" }) // nothing to run
        yield* settle
        expect(lastStatus(events).phase).toBe("error")
        expect(tagged(events, "diagnostics")[0]!.diagnostics.map((d) => d.code)).toEqual(["unknown-component"])
      })))

  it("injects faults, reports them, lifts timed ones by itself, and refuses nonsense", () =>
    withEngine((engine, events) =>
      Effect.gen(function*() {
        yield* engine.send({ _tag: "load", design: design() })
        yield* engine.send({ _tag: "inject", target: { kind: "node", id: "api" }, fault: { _tag: "Outage" } })
        yield* settle
        expect(tagged(events, "faults").at(-1)!.faults).toMatchObject([{ target: { kind: "node", id: "api" }, fault: { _tag: "Outage" } }])
        // Timed, and in JSON form: durations are plain milliseconds on the wire.
        yield* engine.send({ _tag: "inject", target: { kind: "edge", id: "web-api" }, fault: { _tag: "Slow", extra: 250 }, durationMs: 2_000 })
        yield* settle
        expect(tagged(events, "faults").at(-1)!.faults.map((f) => f.fault)).toEqual([{ _tag: "Outage" }, { _tag: "Slow", extra: 250 }])
        yield* engine.send({ _tag: "step", ms: 2_500 })
        yield* settle
        expect(tagged(events, "faults").at(-1)!.faults.map((f) => f.fault._tag)).toEqual(["Outage"])

        yield* engine.send({ _tag: "inject", target: { kind: "node", id: "api" }, fault: { _tag: "Blackhole" } })
        yield* engine.send({ _tag: "inject", target: { kind: "node", id: "nope" }, fault: { _tag: "Outage" } })
        yield* settle
        expect(tagged(events, "rejected").map((r) => r.issues.join(" "))).toEqual([
          expect.stringMatching(/cannot be applied to a node/),
          expect.stringMatching(/No node "nope"/)
        ])
        yield* engine.send({ _tag: "clearFaults" })
        yield* settle
        expect(tagged(events, "faults").at(-1)!.faults).toEqual([])
      })))

  it("applies live settings and refuses ones outside their range", () =>
    withEngine((engine, events) =>
      Effect.gen(function*() {
        yield* engine.send({ _tag: "load", design: design() })
        yield* engine.send({ _tag: "updateNode", id: "api", settings: { memory: 2048 } })
        yield* settle
        expect(tagged(events, "rejected")).toEqual([])
        yield* engine.send({ _tag: "updateNode", id: "api", settings: { memory: 0 } })
        yield* settle
        expect(tagged(events, "rejected").map((r) => r.command)).toEqual(["updateNode"])
        expect(tagged(events, "rejected")[0]!.issues.join(" ")).toMatch(/memory/)
      })))

  it("rejects malformed commands at the door, with what was wrong", () =>
    withEngine((engine, events) =>
      Effect.gen(function*() {
        yield* engine.send({ _tag: "setSpeed" } as never)
        yield* engine.send({ _tag: "dance" } as never)
        yield* settle
        expect(tagged(events, "rejected").map((r) => r.command)).toEqual(["setSpeed", "dance"])
      })))

  describe("scenarios", () => {
    const outage = {
      version: 1 as const,
      name: "API outage",
      duration: "60s",
      warmup: "5s",
      timeline: [
        { at: "10s", inject: { target: "node:api", fault: "Outage", for: "30s" }, note: "the API goes down" },
        { at: "45s", note: "well after" }
      ],
      assert: [
        { check: "web.errorRatio < 1%", to: "10s", name: "healthy before" },
        { check: "web.errorRatio > 90%", from: "12s", to: "38s", name: "down during" }
      ]
    }
    const progressOf = (events: ReadonlyArray<Event>) => tagged(events, "scenario").at(-1)?.progress

    it("plays a scenario: events land at their times, and the run stops at its end with every check decided", () =>
      withEngine((engine, events) =>
        Effect.gen(function*() {
          yield* engine.send({ _tag: "load", design: design() })
          yield* engine.send({ _tag: "scenario", scenario: outage })
          yield* settle
          expect(progressOf(events)).toMatchObject({ name: "API outage", duration: 60_000, warmup: 5_000, t: 0, finished: false })
          expect(progressOf(events)!.checks.map((c) => c.state)).toEqual(["waiting", "waiting"])

          // Halfway through the outage: the fault went in at exactly 10 s, the first check is decided, the second measuring.
          yield* engine.send({ _tag: "step", ms: 20_000 })
          yield* settle
          expect(tagged(events, "faults").at(-1)!.faults).toMatchObject([{ target: { kind: "node", id: "api" }, fault: { _tag: "Outage" }, startedAt: 10_000 }])
          const middle = progressOf(events)!
          expect(middle.timeline.map((e) => e.done)).toEqual([true, false])
          expect(middle.checks.map((c) => c.state)).toEqual(["passed", "holding"])

          // A long step stops at the end of the scenario, not after it.
          yield* engine.send({ _tag: "step", ms: 120_000 })
          yield* settle
          expect(lastStatus(events).t).toBe(60_000)
          const end = progressOf(events)!
          expect(end).toMatchObject({ finished: true, passed: true, t: 60_000 })
          expect(end.checks.map((c) => c.state)).toEqual(["passed", "passed"])
          expect(end.checks[1]!.actual).toBeGreaterThan(0.9)

          // The clients saw the outage, so the standard alarms paged.
          const alerts = tagged(events, "alerts").at(-1)!.alerts
          expect(alerts.find((a) => a.rule === "errors" && a.target.id === "web")).toMatchObject({ severity: "critical", firedAt: 30_000 })
        })))

    it("pauses a playing run at the scenario's end", () =>
      withEngine((engine, events) =>
        Effect.gen(function*() {
          yield* engine.send({ _tag: "load", design: design() })
          yield* engine.send({ _tag: "scenario", scenario: { version: 1, duration: "2s" } })
          yield* engine.send({ _tag: "setSpeed", speed: 50 })
          yield* engine.send({ _tag: "play" })
          yield* settle
          for (let i = 0; i < 20; i++) {
            yield* TestClock.adjust(16)
            yield* settle
          }
          expect(lastStatus(events)).toMatchObject({ phase: "paused", t: 2_000 })
          expect(progressOf(events)).toMatchObject({ finished: true, passed: true })
        })))

    it("starts again on reset, and lets go on clearScenario", () =>
      withEngine((engine, events) =>
        Effect.gen(function*() {
          yield* engine.send({ _tag: "load", design: design() })
          yield* engine.send({ _tag: "scenario", scenario: outage })
          yield* engine.send({ _tag: "step", ms: 120_000 })
          yield* settle
          expect(progressOf(events)).toMatchObject({ finished: true })
          yield* engine.send({ _tag: "reset" })
          yield* settle
          expect(progressOf(events)).toMatchObject({ t: 0, finished: false })
          expect(tagged(events, "alerts").at(-1)!.alerts).toEqual([])
          yield* engine.send({ _tag: "clearScenario" })
          yield* settle
          expect(tagged(events, "scenario").at(-1)).toEqual({ _tag: "scenario" })
          expect(lastStatus(events).t).toBe(0)
        })))

    it("refuses a scenario that names what the design doesn't have, and leaves the run alone", () =>
      withEngine((engine, events) =>
        Effect.gen(function*() {
          yield* engine.send({ _tag: "load", design: design() })
          yield* engine.send({ _tag: "step", ms: 5_000 })
          yield* engine.send({ _tag: "scenario", scenario: { version: 1, duration: "1m", timeline: [{ at: "1s", inject: { target: "node:nope", fault: "Outage" } }] } })
          yield* settle
          expect(tagged(events, "rejected").map((r) => r.command)).toEqual(["scenario"])
          expect(tagged(events, "rejected")[0]!.issues.join(" ")).toMatch(/no node "nope"/)
          expect(tagged(events, "scenario")).toEqual([])
          expect(lastStatus(events).t).toBe(5_000)
        })))
  })
})

void Fiber
