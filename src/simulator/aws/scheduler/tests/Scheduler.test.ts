import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../../../Builder.ts"
import { decode, frames, mean, sim } from "../../../testing.ts"
import * as Describe from "../../../Describe.ts"
import type { Frame } from "../../../Telemetry.ts"
import type { Outcomes } from "../../eventbridge/Delivery.ts"
import { audit } from "../Audit.ts"
import { Schedule } from "../internal/config.ts"
import { schedulerInvocationRate } from "../Quotas.ts"

interface Shape {
  readonly schedule?: Record<string, unknown>
  readonly target?: Record<string, unknown>
  readonly targetType?: string
  readonly noTarget?: boolean
  readonly dlq?: boolean
  readonly region?: string
  readonly account?: Record<string, unknown>
}

type State = Outcomes & { readonly next: number; readonly occurrences: number; readonly windows: number; readonly noTarget: number; readonly pending: number }

const quick = { latency: { mean: 10, cv: 0 } }
const MIN = 60_000

/** scheduler -> target [-> dead-letter queue], in one region */
const design = (s: Shape) => {
  const b = Builder.make("scheduler", { seed: 9 })
  const region = s.region ?? "us-east-1"
  const scheduler = b.add("aws.scheduler", { id: "schedule", region, settings: s.schedule ?? {} })
  if (s.noTarget !== true) {
    const aws = s.targetType?.startsWith("aws.") === true
    b.connect(scheduler, b.add(s.targetType ?? "common.http-endpoint", { id: "target", ...(aws ? { region } : {}), settings: s.target ?? quick }))
  }
  if (s.dlq === true) b.connect(scheduler.port("dlq"), b.add("aws.sqs", { id: "dlq", region }))
  if (s.account !== undefined) b.account(`aws:${region}`, s.account)
  return b.build()
}

const state = (s: Shape, ms: number, node = "schedule") =>
  sim(design(s), (sm) => Effect.flatMap(sm.advanceTo(ms), () => sm.probe(node))).then((p) => p.state as State)

/** The busiest `windowMs` of a node's rate, averaged over that window. */
const peak = (all: ReadonlyArray<Frame>, id: string, windowMs: number): number => {
  const per = Math.round(windowMs / 250)
  const rates = all.map((f) => f.nodes[id]?.rates.in ?? 0)
  let best = 0
  for (let i = 0; i + per <= rates.length; i++) best = Math.max(best, rates.slice(i, i + per).reduce((a, b) => a + b, 0) / per)
  return best
}

describe("aws.scheduler: when it fires", () => {
  it("invokes a rate(1 minute) schedule once a minute, from the start", async () => {
    const s = await state({ schedule: { expression: "rate(1 minute)" } }, 10 * MIN)
    expect(s.occurrences).toBe(11) // 0, 1, ... 10 minutes
    expect(s.invocations).toBeGreaterThanOrEqual(10)
    expect(s.invocations).toBeLessThanOrEqual(11)
    expect(s.delivered).toBe(s.invocations)
  })

  it("fires a cron at its wall-clock time: midnight comes five minutes in by default", async () => {
    const all = await frames(design({ schedule: { expression: "cron(0 0 * * ? *)", schedules: 600 } }), 10 * MIN)
    expect(mean(all, "nodes", "target", "rates", "in", 0, 5 * MIN)).toBe(0)
    // 600 schedules land within the minute they are due: 10 a second for a minute.
    expect(mean(all, "nodes", "target", "rates", "in", 5 * MIN + 250, 6 * MIN)).toBeCloseTo(10, 0)
    expect(mean(all, "nodes", "target", "rates", "in", 6 * MIN + 1_000)).toBe(0)
  })

  it("fires an at expression once", async () => {
    const all = await frames(design({ schedule: { expression: "at(2026-01-06T00:01:00)", schedules: 60 } }), 15 * MIN)
    expect(mean(all, "nodes", "target", "rates", "in", 0, 6 * MIN)).toBe(0)
    expect(mean(all, "nodes", "target", "rates", "in", 6 * MIN + 250, 7 * MIN)).toBeCloseTo(1, 1)
    expect(mean(all, "nodes", "target", "rates", "in", 7 * MIN + 1_000)).toBe(0)
  })

  it("does nothing while disabled, and starts when enabled", () =>
    sim(design({ schedule: { expression: "rate(1 minute)", schedules: 10, enabled: false } }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(5 * MIN)
        expect(((yield* s.probe("schedule")).state as State).invocations).toBe(0)
        // Settings are replaced as a whole, as an edit in the UI does.
        yield* s.configureNode("schedule", { expression: "rate(1 minute)", schedules: 10, enabled: true })
        yield* s.advanceTo(10 * MIN)
        expect(((yield* s.probe("schedule")).state as State).invocations).toBeGreaterThanOrEqual(40)
      })))

  it("takes a new expression within a second", () =>
    sim(design({ schedule: { expression: "rate(1 hour)" } }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(10 * MIN)
        expect(((yield* s.probe("schedule")).state as State).occurrences).toBe(1)
        yield* s.configureNode("schedule", { expression: "rate(1 minute)" })
        yield* s.advanceTo(15 * MIN)
        expect(((yield* s.probe("schedule")).state as State).occurrences).toBeGreaterThanOrEqual(5)
      })))

  it("records what it sends and how it ends, as a client does, so the system's view includes it", async () => {
    const all = await frames(design({ schedule: { expression: "rate(1 minute)", schedules: 600, retryPolicy: { maxRetries: 0 } }, target: { ...quick, errorRate: 0.25 } }), 5 * MIN)
    const sent = mean(all, "nodes", "schedule", "rates", "sent")
    expect(sent).toBeCloseTo(10, 0)
    expect(mean(all, "nodes", "schedule", "rates", "fail") / sent).toBeCloseTo(0.25, 1)
    expect(mean(all, "nodes", "schedule", "rates", "ok") / sent).toBeCloseTo(0.75, 1)
  })

  it("counts invocations with nothing wired as having no target", async () => {
    const s = await state({ schedule: { schedules: 5 }, noTarget: true }, 3 * MIN)
    expect(s.noTarget).toBeGreaterThanOrEqual(10)
    expect(s.invocations).toBe(0)
  })

  it("is deterministic", async () => {
    const shape: Shape = { schedule: { expression: "cron(0/2 * * * ? *)", schedules: 200, flexibleWindow: 1 }, target: { ...quick, errorRate: 0.2 } }
    expect(await frames(design(shape), 6 * MIN)).toEqual(await frames(design(shape), 6 * MIN))
  })
})

describe("aws.scheduler: many schedules and the flexible time window", () => {
  it("turns thousands of midnight jobs into a burst, which a flexible window spreads out", async () => {
    const herd = await frames(design({ schedule: { expression: "cron(0 0 * * ? *)", schedules: 6_000 } }), 25 * MIN)
    const spread = await frames(design({ schedule: { expression: "cron(0 0 * * ? *)", schedules: 6_000, flexibleWindow: 15 } }), 25 * MIN)
    // OFF: all 6,000 inside the minute, about 100 a second.
    expect(peak(herd, "target", 10_000)).toBeGreaterThan(80)
    expect(mean(herd, "nodes", "target", "rates", "in", 5 * MIN + 250, 6 * MIN)).toBeCloseTo(100, -1)
    // 15 minutes: the same 6,000 at about 6.7 a second.
    expect(peak(spread, "target", 10_000)).toBeLessThan(15)
    expect(mean(spread, "nodes", "target", "rates", "in", 5 * MIN + 250, 20 * MIN)).toBeCloseTo(6.67, 0)
    expect(mean(spread, "nodes", "target", "rates", "in", 20 * MIN + 1_000)).toBe(0)
  })

  it("delays invocations past the region's quota instead of failing them", () =>
    sim(design({ schedule: { expression: "cron(0 0 * * ? *)", schedules: 12_000 }, account: { schedulerInvocationRate: 100 } }), (s) =>
      Effect.gen(function*() {
        const all = yield* s.advanceTo(10 * MIN)
        // 200 a second come due for a minute; 100 a second are invoked, for two minutes.
        expect(mean(all, "nodes", "target", "rates", "in", 5 * MIN + 10_000, 6 * MIN + 50_000)).toBeCloseTo(100, -1)
        const st = (yield* s.probe("schedule")).state as State
        expect(st.delivered).toBe(12_000)
        expect(st.delayed).toBeGreaterThan(5_000)
        expect(st.failed).toBe(0)
      })))

  it("has AWS's regional invocation quotas", () => {
    expect(["us-east-1", "eu-west-2", "sa-east-1", "eu-north-1", "ca-central-1"].map(schedulerInvocationRate)).toEqual([1_000, 1_000, 1_000, 500, 500])
  })
})

describe("aws.scheduler: retries and dead-letter queues", () => {
  const failing = { ...quick, errorRate: 1 }
  const fast = { retryBackoff: { initial: 100, max: 400 } }

  it("retries a failing target, then dead-letters the invocation", async () => {
    const s = await state({ schedule: { schedules: 100, retryPolicy: { maxRetries: 2 }, ...fast }, target: failing, dlq: true }, 5 * MIN + 30_000)
    expect(s.attempts).toBe(3 * s.invocations)
    expect(s.retries).toBe(2 * s.invocations)
    expect(s.deadLettered).toBe(s.invocations)
    expect(s.dropped).toBe(0)
  })

  it("drops what it gives up on when no dead-letter queue is wired", async () => {
    const s = await state({ schedule: { schedules: 100, retryPolicy: { maxRetries: 0 } }, target: failing }, 3 * MIN)
    expect(s.retries).toBe(0)
    expect(s.dropped).toBe(s.failed)
    expect(s.failed).toBeGreaterThan(250)
  })

  it("gives up when an invocation reaches its maximum age", async () => {
    const s = await state({ schedule: { expression: "at(2026-01-05T23:55:00)", schedules: 50, retryPolicy: { maxEventAge: "2 minutes" }, retryBackoff: { initial: 1_000, max: 5_000 } }, target: failing, dlq: true }, 5 * MIN)
    expect(s.expired).toBe(50)
    expect(s.deadLettered).toBe(50)
    expect(s.retries / 50).toBeGreaterThan(20)
  })

  it("invokes a Lambda target asynchronously", () =>
    sim(design({ schedule: { schedules: 20 }, targetType: "aws.lambda", target: { memory: 1769, duration: { mean: 5_000, cv: 0 } } }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(30_000)
        const fn = (yield* s.probe("target")).state as { asyncPending: number }
        expect(fn.asyncPending).toBeGreaterThan(0)
        expect(((yield* s.probe("schedule")).state as State).failed).toBe(0)
      })))
})

describe("aws.scheduler: settings and audit", () => {
  it("rejects an expression it can't read, saying why", async () => {
    await expect(Effect.runPromise(decode(design({ schedule: { expression: "cron(0 0 * * *)" } })))).rejects.toThrow(/six fields/)
    await expect(Effect.runPromise(decode(design({ schedule: { clock: "midnight" } })))).rejects.toThrow(/date and time/)
    await expect(Effect.runPromise(decode(design({ schedule: { payload: 300 } })))).rejects.toThrow()
  })

  it("shows the expression and clock as text fields", () => {
    const fields = Describe.fields(Schedule)
    expect(fields.find((f) => f.key === "expression")).toMatchObject({ kind: "text", default: "rate(1 minute)" })
    expect(fields.find((f) => f.key === "clock")).toMatchObject({ kind: "text" })
  })

  it("warns when the schedules in a region add up to more than the account allows", () => {
    const members = [
      { id: "a", type: "aws.scheduler", config: { schedules: 6_000_000 } },
      { id: "b", type: "aws.scheduler", config: { schedules: 5_000_000 } }
    ]
    expect(audit("us-east-1", members as never, { schedulerSchedules: 10_000_000 } as never)).toHaveLength(1)
    expect(audit("us-east-1", members as never, { schedulerSchedules: 20_000_000 } as never)).toHaveLength(0)
  })
})
