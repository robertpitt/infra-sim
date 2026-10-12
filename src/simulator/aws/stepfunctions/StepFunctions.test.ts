import { Duration, Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "../../Builder.ts"
import { dist, frames, mean, sim } from "../../components/testing.ts"
import type { Frame } from "../../Telemetry.ts"
import { audit } from "./audit.ts"
import type { Settings } from "./config.ts"

/**
 * Behaviour of `aws.stepfunctions` against AWS's published numbers. Designs are built small: a client, the state
 * machine, and HTTP endpoints with constant response times as its tasks, every wire with no network latency and no
 * transition or StartExecution time, so a run's timings are the workflow's own and can be checked to the millisecond.
 */

const NO_LATENCY = { latency: { mean: 0, cv: 0 } }
const INSTANT = { transitionLatency: { mean: 0, cv: 0 }, startLatency: { mean: 0, cv: 0 } }

interface Task {
  readonly id: string
  /** The endpoint's response time, ms. */
  readonly ms?: number
  /** The endpoint's own settings (error rate, rate limit...). */
  readonly endpoint?: Record<string, unknown>
  /** The state's settings on the edge. */
  readonly state?: Record<string, unknown>
}

interface Workflow {
  readonly machine?: Record<string, unknown>
  readonly client?: Record<string, unknown>
  readonly tasks?: ReadonlyArray<Task>
  readonly fallbacks?: ReadonlyArray<Task>
  readonly account?: Record<string, unknown>
  readonly region?: string
}

const workflow = (w: Workflow) => {
  const b = Builder.make("sfn", { seed: 3 })
  const region = w.region ?? "us-east-1"
  const web = b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 5, ...w.client } })
  const sfn = b.add("aws.stepfunctions", { id: "sfn", region, settings: { ...INSTANT, ...w.machine } })
  b.connect(web, sfn, { ...NO_LATENCY, timeout: "10 minutes" })
  const endpoint = (t: Task) => b.add("common.http-endpoint", { id: t.id, settings: { latency: { mean: t.ms ?? 100, cv: 0 }, ...t.endpoint } })
  for (const t of w.tasks ?? []) b.connect(sfn, endpoint(t), { ...NO_LATENCY, ...t.state })
  for (const t of w.fallbacks ?? []) b.connect(sfn.port("catch"), endpoint(t), { ...NO_LATENCY, ...t.state })
  if (w.account !== undefined) b.account(`aws:${region}`, w.account)
  return b.build()
}

const tasks = (...ms: ReadonlyArray<number>): ReadonlyArray<Task> => ms.map((m, i) => ({ id: `t${i + 1}`, ms: m }))

const runDoc = (doc: ReturnType<typeof workflow>, ms: number) =>
  sim(doc, (s) =>
    Effect.gen(function*() {
      const all = yield* s.advanceTo(ms)
      const probe = yield* s.probe("sfn")
      return { all, state: probe.state as Record<string, number> }
    }))

const run = (w: Workflow, ms: number) => runDoc(workflow(w), ms)

const rate = (all: ReadonlyArray<Frame>, node: string, name: string, from = 0, to = Infinity) => mean(all, "nodes", node, "rates", name, from, to)
const p50 = (all: ReadonlyArray<Frame>, node: string, name: string, from = 0) => dist(all, node, name, from).p50

describe("aws.stepfunctions: a workflow is a sequence of states", () => {
  it("runs the out edges in order: a synchronous Express caller waits for all of them", async () => {
    const all = await frames(workflow({ machine: { workflowType: "express" }, tasks: tasks(100, 200, 300) }), 20_000)
    expect(p50(all, "web", "latency", 2_000)).toBeCloseTo(600, -1)
    for (const t of ["t1", "t2", "t3"]) expect(rate(all, t, "in", 2_000)).toBeCloseTo(5, 0)
  })

  it("states marked parallel run at once as one Parallel state, which waits for its slowest branch", async () => {
    const parallel = { state: { parallel: true } }
    const pair = workflow({ machine: { workflowType: "express" }, tasks: [{ id: "t1", ms: 100 }, { id: "t2", ms: 300 }, { id: "t3", ms: 200, ...parallel }, { id: "t4", ms: 50 }] })
    // t1, then t2 and t3 together (300), then t4.
    expect(p50(await frames(pair, 20_000), "web", "latency", 2_000)).toBeCloseTo(450, -1)
    // Marking t2 too joins it to t1: one Parallel state of three branches, then t4.
    const three = workflow({ machine: { workflowType: "express" }, tasks: [{ id: "t1", ms: 100 }, { id: "t2", ms: 300, ...parallel }, { id: "t3", ms: 200, ...parallel }, { id: "t4", ms: 50 }] })
    expect(p50(await frames(three, 20_000), "web", "latency", 2_000)).toBeCloseTo(350, -1)
  })

  it("a failing branch fails the Parallel state at once, and the execution with it", async () => {
    const doc = workflow({
      machine: { workflowType: "express" },
      tasks: [{ id: "t1", ms: 1_000 }, { id: "t2", ms: 50, endpoint: { errorRate: 1 }, state: { parallel: true } }, { id: "t3", ms: 100 }]
    })
    const { all, state } = await runDoc(doc, 20_000)
    expect(rate(all, "web", "fail.Failed", 2_000)).toBeCloseTo(5, 0)
    expect(rate(all, "t3", "in")).toBe(0)
    // The client hears the failure after t2's 50 ms, not t1's second.
    expect(p50(all, "sfn", "executionTime", 2_000)).toBeLessThan(100)
    expect(state.failed).toBeGreaterThan(90)
  })

  it("a Wait state pauses the execution before its state", async () => {
    const all = await frames(workflow({ machine: { workflowType: "express" }, tasks: [{ id: "t1", ms: 100 }, { id: "t2", ms: 100, state: { wait: "2 seconds" } }] }), 30_000)
    expect(p50(all, "web", "latency", 5_000)).toBeCloseTo(2_200, -1)
  })

  it("every state entered, retry and Wait is a state transition", async () => {
    const { all } = await run({ tasks: [{ id: "t1" }, { id: "t2", state: { wait: "1 second" } }, { id: "t3" }] }, 20_000)
    // Three tasks and a Wait state: four transitions an execution, five executions a second.
    expect(rate(all, "sfn", "transitions", 5_000)).toBeCloseTo(20, 0)
  })

  it("an execution with no states succeeds at once", async () => {
    const { state } = await run({ machine: { workflowType: "express" } }, 5_000)
    expect(state.succeeded).toBeGreaterThan(20)
    expect(state.running).toBe(0)
  })
})

describe("aws.stepfunctions: Map states", () => {
  const map = (settings: Record<string, unknown>, workflowType = "express") =>
    workflow({ machine: { workflowType }, client: { rps: 1 }, tasks: [{ id: "item", ms: 100, state: { state: "map", map: { items: 100, ...settings } } }] })

  it("calls the task once per item", async () => {
    const all = await frames(map({}), 20_000)
    expect(rate(all, "item", "in", 2_000)).toBeCloseTo(100, -1)
    expect(rate(all, "sfn", "iterations", 2_000)).toBeCloseTo(100, -1)
  })

  it("Inline mode runs at most 40 iterations at once, whatever MaxConcurrency says", async () => {
    // 100 items of 100 ms, 40 at a time: three rounds.
    expect(p50(await frames(map({}), 20_000), "web", "latency", 2_000)).toBeCloseTo(300, -1)
    expect(p50(await frames(map({ maxConcurrency: 1_000 }), 20_000), "web", "latency", 2_000)).toBeCloseTo(300, -1)
    // MaxConcurrency 10: ten rounds.
    expect(p50(await frames(map({ maxConcurrency: 10 }), 20_000), "web", "latency", 2_000)).toBeCloseTo(1_000, -1)
  })

  it("Distributed mode starts child executions at 1,000 a second (Express) or 100 (Standard)", async () => {
    const express = await frames(map({ mode: "distributed", items: 500 }, "standard"), 30_000)
    const standard = await frames(map({ mode: "distributed", items: 500, childType: "standard" }, "standard"), 30_000)
    expect(p50(express, "sfn", "executionTime", 5_000)).toBeCloseTo(600, -2) // 500 starts over 0.5 s, the last takes 100 ms
    expect(p50(standard, "sfn", "executionTime", 10_000)).toBeCloseTo(5_100, -2)
    expect(rate(standard, "sfn", "childExecutions", 10_000)).toBeCloseTo(500, -1)
  })

  it("Distributed mode runs more than 40 at once, up to MaxConcurrency", async () => {
    const all = await frames(map({ mode: "distributed", items: 500, maxConcurrency: 10 }, "standard"), 30_000)
    // 500 items, 10 at a time, 100 ms each.
    expect(p50(all, "sfn", "executionTime", 10_000)).toBeCloseTo(5_000, -2)
  })

  it("an Express workflow can't use Distributed mode: its Map runs Inline", async () => {
    const all = await frames(map({ mode: "distributed" }, "express"), 20_000)
    expect(p50(all, "web", "latency", 2_000)).toBeCloseTo(300, -1)
    expect(rate(all, "sfn", "childExecutions")).toBe(0)
  })

  it("Inline mode fails on the first failed iteration; Distributed tolerates the share it is told to", async () => {
    const failing = (settings: Record<string, unknown>) =>
      workflow({
        machine: { workflowType: "standard" },
        client: { rps: 1 },
        tasks: [{ id: "item", ms: 100, endpoint: { errorRate: 0.02 }, state: { state: "map", map: { items: 100, ...settings } } }]
      })
    const inline = await runDoc(failing({}), 30_000)
    expect(inline.state.failed).toBeGreaterThan(20) // 1 - 0.98^100: nearly every execution has a failed item
    const tolerant = await runDoc(failing({ mode: "distributed", toleratedFailure: 0.1 }), 30_000)
    expect(tolerant.state.failed).toBe(0)
    expect(tolerant.state.succeeded).toBeGreaterThan(25)
  })

  it("takes its items from the input's records when Items is 0: a batch from a queue", async () => {
    const b = Builder.make("batch", { seed: 3 })
    const web = b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 50 } })
    const queue = b.add("aws.sqs", { id: "queue" })
    const sfn = b.add("aws.stepfunctions", { id: "sfn", settings: INSTANT })
    const item = b.add("common.http-endpoint", { id: "item", settings: { latency: { mean: 10, cv: 0 } } })
    b.connect(web, queue)
    b.connect(queue.port("deliver"), sfn, { batchSize: 10, batchWindow: "1 second" })
    b.connect(sfn, item, { ...NO_LATENCY, state: "map" })
    const all = await frames(b.build(), 30_000)
    expect(rate(all, "item", "in", 10_000)).toBeCloseTo(50, -1)
    expect(rate(all, "sfn", "started", 10_000)).toBeCloseTo(5, 0)
  })
})

describe("aws.stepfunctions: Retry", () => {
  const failing = (retrier: Record<string, unknown>, endpoint: Record<string, unknown> = { errorRate: 1 }, state: Record<string, unknown> = {}) =>
    run({ client: { rps: 2 }, tasks: [{ id: "t1", ms: 100, endpoint, state: { retrier: { enabled: true, ...retrier }, ...state } }] }, 60_000)

  it("the States Language's defaults: 3 retries, 1 s doubling, so a task that always fails gives up after 1 + 2 + 4 s", async () => {
    const { all } = await failing({})
    expect(rate(all, "t1", "in", 20_000)).toBeCloseTo(8, 0) // four tries an execution
    expect(rate(all, "sfn", "retries", 20_000)).toBeCloseTo(6, 0)
    expect(rate(all, "sfn", "failed", 20_000)).toBeCloseTo(2, 0)
    expect(p50(all, "sfn", "executionTime", 20_000)).toBeCloseTo(7_400, -1) // 7 s of waits and four 100 ms tries
  })

  it("retries are state transitions", async () => {
    const { all } = await failing({})
    expect(rate(all, "sfn", "transitions", 20_000)).toBeCloseTo(8, 0)
  })

  it("MaxDelaySeconds caps the growing wait, and BackoffRate shapes it", async () => {
    const { all } = await failing({ maxAttempts: 5, maxDelay: "3 seconds" })
    expect(p50(all, "sfn", "executionTime", 30_000)).toBeCloseTo(12_600, -1) // 1 + 2 + 3 + 3 + 3 s, six tries
    const flat = await failing({ maxAttempts: 2, interval: "3 seconds", backoffRate: 1 })
    expect(p50(flat.all, "sfn", "executionTime", 20_000)).toBeCloseTo(6_300, -1)
  })

  it("FULL jitter draws each wait between zero and its full length: half the time on average", async () => {
    const { all } = await failing({ jitter: "FULL" })
    expect(dist(all, "sfn", "executionTime", 20_000).mean).toBeGreaterThan(3_000)
    expect(dist(all, "sfn", "executionTime", 20_000).mean).toBeLessThan(4_800) // 3.5 s of waits on average, plus 400 ms
  })

  it("MaxAttempts 0 never retries; a state without a retrier isn't retried", async () => {
    const zero = await failing({ maxAttempts: 0 })
    expect(rate(zero.all, "t1", "in", 10_000)).toBeCloseTo(2, 0)
    const none = await failing({ enabled: false })
    expect(rate(none.all, "t1", "in", 10_000)).toBeCloseTo(2, 0)
  })

  it("retries only the errors its ErrorEquals names", async () => {
    // A function error isn't States.Timeout, and a 5xx isn't throttling.
    expect(rate((await failing({ errorEquals: "States.Timeout" })).all, "t1", "in", 10_000)).toBeCloseTo(2, 0)
    expect(rate((await failing({ errorEquals: "throttling" })).all, "t1", "in", 10_000)).toBeCloseTo(2, 0)
    // A task that runs past its TimeoutSeconds is States.Timeout, which States.TaskFailed doesn't match but States.Timeout does.
    const slow = { latency: { mean: 2_000, cv: 0 } }
    expect(rate((await failing({ errorEquals: "States.TaskFailed" }, slow, { timeout: "1 second" })).all, "t1", "in", 10_000)).toBeCloseTo(2, 0)
    expect(rate((await failing({ errorEquals: "States.Timeout" }, slow, { timeout: "1 second" })).all, "t1", "in", 20_000)).toBeCloseTo(8, 0)
    // Throttling from a rate-limited resource is a service error.
    const limited = await failing({ errorEquals: "service", maxAttempts: 10, jitter: "FULL" }, { rateLimit: 1, burst: 1 })
    expect(rate(limited.all, "sfn", "retries", 20_000)).toBeGreaterThan(0.5)
  })
})

describe("aws.stepfunctions: Catch and the saga pattern", () => {
  const saga = (machine: Record<string, unknown> = {}, catcher: Record<string, unknown> = { enabled: true }) =>
    workflow({
      machine: { workflowType: "express", ...machine },
      client: { rps: 2 },
      tasks: [{ id: "reserve" }, { id: "charge" }, { id: "ship", endpoint: { errorRate: 1 }, state: { catcher } }, { id: "notify" }],
      fallbacks: [
        { id: "cancel-shipment", state: { undoes: "ship" } },
        { id: "refund", state: { undoes: "charge" } },
        { id: "release", state: { undoes: "reserve" } },
        { id: "unnotify", state: { undoes: "notify" } },
        { id: "alert" }
      ]
    })

  it("a caught failure runs the compensations of the states the execution reached, in order, then fails", async () => {
    const { all, state } = await runDoc(saga(), 30_000)
    for (const id of ["cancel-shipment", "refund", "release", "alert"]) expect(rate(all, id, "in", 5_000)).toBeCloseTo(2, 0)
    // Notify was never reached, so it isn't undone.
    expect(rate(all, "unnotify", "in")).toBe(0)
    expect(rate(all, "notify", "in")).toBe(0)
    expect(rate(all, "sfn", "caught", 5_000)).toBeCloseTo(2, 0)
    expect(rate(all, "sfn", "compensations", 5_000)).toBeCloseTo(8, 0)
    // The saga ends in a Fail state: the synchronous caller hears a failure, after three states and four compensations.
    expect(rate(all, "web", "fail.Failed", 5_000)).toBeCloseTo(2, 0)
    expect(p50(all, "sfn", "executionTime", 5_000)).toBeCloseTo(700, -1)
    expect(state.failed).toBeGreaterThan(50)
  })

  it("a fallback path ending in a Succeed state answers success", async () => {
    const { all, state } = await runDoc(saga({ afterCatch: "succeed" }), 30_000)
    expect(rate(all, "web", "fail", 5_000)).toBe(0)
    expect(state.succeeded).toBeGreaterThan(50)
    // Three states, then the four on the fallback path that run: seven tries of 100 ms.
    expect(p50(all, "web", "latency", 5_000)).toBeCloseTo(700, -1)
  })

  it("an error the catcher doesn't match fails the execution without compensating", async () => {
    const { all } = await runDoc(saga({}, { enabled: true, errorEquals: "States.Timeout" }), 30_000)
    expect(rate(all, "refund", "in")).toBe(0)
    expect(rate(all, "sfn", "caught")).toBe(0)
    expect(rate(all, "sfn", "failed", 5_000)).toBeCloseTo(2, 0)
  })

  it("a catcher with nothing on the catch port goes straight to the path's end", async () => {
    const doc = workflow({
      machine: { workflowType: "express", afterCatch: "succeed" },
      client: { rps: 2 },
      tasks: [{ id: "charge", endpoint: { errorRate: 1 }, state: { catcher: { enabled: true, errorEquals: "function" } } }]
    })
    const { all, state } = await runDoc(doc, 20_000)
    expect(rate(all, "web", "fail")).toBe(0)
    expect(state.caught).toBe(state.succeeded)
  })

  it("a compensation that names no state of the workflow runs whatever failed", async () => {
    const doc = workflow({
      machine: { workflowType: "express" },
      client: { rps: 2 },
      tasks: [{ id: "charge", endpoint: { errorRate: 1 }, state: { catcher: { enabled: true } } }],
      fallbacks: [{ id: "refund", state: { undoes: "no-such-node" } }]
    })
    const { all } = await runDoc(doc, 20_000)
    expect(rate(all, "refund", "in", 5_000)).toBeCloseTo(2, 0)
  })

  it("a compensation that fails for good fails the execution where it stands", async () => {
    const doc = workflow({
      machine: { workflowType: "express", afterCatch: "succeed" },
      client: { rps: 2 },
      tasks: [{ id: "charge", endpoint: { errorRate: 1 }, state: { catcher: { enabled: true } } }],
      fallbacks: [{ id: "refund", endpoint: { errorRate: 1 }, state: { retrier: { enabled: true, maxAttempts: 2 } } }, { id: "alert" }]
    })
    const { all } = await runDoc(doc, 30_000)
    expect(rate(all, "refund", "in", 10_000)).toBeCloseTo(6, 0) // three tries each
    expect(rate(all, "alert", "in")).toBe(0)
    expect(rate(all, "sfn", "failed", 10_000)).toBeCloseTo(2, 0)
  })
})

describe("aws.stepfunctions: Standard and Express", () => {
  it("Standard answers StartExecution at once: the caller doesn't wait for the workflow", async () => {
    const { all, state } = await run({ machine: { startLatency: { mean: 25, cv: 0 } }, client: { rps: 20 }, tasks: tasks(1_000) }, 20_000)
    expect(p50(all, "web", "latency", 2_000)).toBeCloseTo(25, 0)
    // Little's law: 20 a second for a second each.
    expect(mean(all, "nodes", "sfn", "gauges", "running", 5_000)).toBeCloseTo(20, -1)
    expect(state.openInRegion).toBe(state.running)
  })

  it("an asynchronous Express execution is answered at once too", async () => {
    const all = await frames(workflow({ machine: { workflowType: "express" }, client: { invocation: "async" }, tasks: tasks(1_000) }), 10_000)
    expect(p50(all, "web", "latency", 2_000)).toBe(0)
    expect(rate(all, "t1", "in", 2_000)).toBeCloseTo(5, 0)
  })

  it("an Express execution stops at five minutes with States.Timeout", async () => {
    const doc = workflow({ machine: { workflowType: "express" }, client: { rps: 0.2, invocation: "async" }, tasks: tasks(6 * 60_000) })
    const { state } = await runDoc(doc, 7 * 60_000)
    expect(state.timedOut).toBeGreaterThan(5)
    expect(state.succeeded).toBe(0)
  })

  it("a Standard execution runs past five minutes, and stops at the state machine's own TimeoutSeconds", async () => {
    const long = await run({ client: { rps: 0.2 }, tasks: tasks(6 * 60_000) }, 7 * 60_000)
    expect(long.state.timedOut).toBe(0)
    expect(long.state.succeeded).toBeGreaterThan(5)
    const short = await run({ machine: { timeout: "10 seconds" }, client: { rps: 1 }, tasks: tasks(20_000) }, 60_000)
    expect(short.state.timedOut).toBeGreaterThan(40)
    expect(short.state.succeeded).toBe(0)
  })

  it("a task past its TimeoutSeconds fails with States.Timeout, while its resource carries on", async () => {
    const { all, state } = await run({ machine: { workflowType: "express" }, client: { rps: 2 }, tasks: [{ id: "t1", ms: 2_000, state: { timeout: "1 second" } }] }, 20_000)
    expect(rate(all, "web", "fail.Failed", 5_000)).toBeCloseTo(2, 0)
    expect(p50(all, "sfn", "executionTime", 5_000)).toBeCloseTo(1_000, -1)
    expect(rate(all, "t1", "ok", 5_000)).toBeCloseTo(2, 0) // the endpoint still finishes its work
    expect(state.timedOut).toBe(0) // the task failed, not the execution's own timeout
  })

  it("asynchronous Express executions are at-least-once: some run twice", async () => {
    const { all, state } = await run({ machine: { workflowType: "express", duplicateRate: 0.5 }, client: { rps: 20, invocation: "async" }, tasks: tasks(10) }, 30_000)
    expect(rate(all, "t1", "in", 5_000) / rate(all, "web", "ok", 5_000)).toBeCloseTo(1.5, 1)
    expect(state.duplicates! / state.started!).toBeCloseTo(1 / 3, 1)
  })

  it("Standard and synchronous Express executions never run twice", async () => {
    const standard = await run({ machine: { duplicateRate: 0.5 }, client: { rps: 20 }, tasks: tasks(10) }, 10_000)
    expect(standard.state.duplicates).toBe(0)
    const sync = await run({ machine: { workflowType: "express", duplicateRate: 0.5 }, client: { rps: 20 }, tasks: tasks(10) }, 10_000)
    expect(sync.state.duplicates).toBe(0)
  })

  it("refuses an input over 256 KiB", async () => {
    const all = await frames(workflow({ client: { payload: 300 } }), 5_000)
    expect(rate(all, "web", "fail.Rejected", 1_000)).toBeCloseTo(5, 0)
    expect(rate(all, "web", "ok", 1_000)).toBe(0)
  })
})

describe("aws.stepfunctions: quotas", () => {
  it("throttles Standard StartExecution at 300 a second after a 1,300 burst in us-east-1", async () => {
    const { all } = await run({ client: { rps: 600 } }, 20_000)
    expect(rate(all, "sfn", "started", 0, 2_000)).toBeCloseTo(600, -1) // the burst of 1,300 lasts about four seconds
    expect(rate(all, "sfn", "started", 10_000)).toBeCloseTo(300, -1)
    expect(rate(all, "web", "fail.Throttled", 10_000)).toBeCloseTo(300, -1)
  })

  it("and at 150 a second in the other Regions", async () => {
    const { all } = await run({ client: { rps: 600 }, region: "eu-central-1" }, 20_000)
    expect(rate(all, "sfn", "started", 10_000)).toBeCloseTo(150, -1)
  })

  it("Express starts go far faster: 6,000 a second", async () => {
    const { all } = await run({ machine: { workflowType: "express" }, client: { rps: 600, invocation: "async" } }, 10_000)
    expect(rate(all, "sfn", "throttled")).toBe(0)
  })

  it("StartSyncExecution counts against no account limit; asynchronous Express starts do", async () => {
    const account = { sfnExpressStartRate: 50, sfnExpressStartBurst: 50 }
    const sync = await run({ machine: { workflowType: "express" }, client: { rps: 100 }, account }, 10_000)
    expect(sync.state.throttled).toBe(0)
    const async = await run({ machine: { workflowType: "express" }, client: { rps: 100, invocation: "async" }, account }, 10_000)
    expect(rate(async.all, "sfn", "started", 5_000)).toBeCloseTo(50, -1)
  })

  it("throttled state transitions slow Standard executions down rather than failing them, and a raised quota takes effect live", () => {
    const doc = workflow({ client: { rps: 50 }, tasks: tasks(10, 10, 10), account: { sfnStateTransitionRate: 100, sfnStateTransitionBurst: 100 } })
    return sim(doc, (s) =>
      Effect.gen(function*() {
        const all = yield* s.advanceTo(30_000)
        // 50 executions a second need 150 transitions; the bucket gives 100.
        expect(rate(all, "sfn", "transitions", 10_000)).toBeCloseTo(100, -1)
        expect(rate(all, "sfn", "transitionsThrottled", 10_000)).toBeGreaterThan(30)
        // Not 100 / 3 = 33 a second: new executions' first transitions queue alongside the running ones' later ones, so
        // in the line's steady state the three get 50r, 50r² and 50r³ a second with r + r² + r³ = 2 (r ≈ 0.81).
        expect(rate(all, "sfn", "succeeded", 10_000)).toBeCloseTo(26.6, 0)
        expect(rate(all, "sfn", "failed")).toBe(0)
        expect(mean(all, "nodes", "sfn", "gauges", "running", 25_000)).toBeGreaterThan(200) // the backlog grows
        yield* s.configureAccount("aws:us-east-1", { sfnStateTransitionRate: 5_000, sfnStateTransitionBurst: 5_000 })
        const after = yield* s.advanceTo(60_000)
        expect(rate(after, "sfn", "transitions", 50_000)).toBeCloseTo(150, -1)
        expect(mean(after, "nodes", "sfn", "gauges", "waitingForTransition", 50_000)).toBe(0)
      }))
  })

  it("Express workflows have no state transition quota", async () => {
    const { all } = await run({ machine: { workflowType: "express" }, client: { rps: 50 }, tasks: tasks(10, 10, 10), account: { sfnStateTransitionRate: 100, sfnStateTransitionBurst: 100 } }, 20_000)
    expect(rate(all, "sfn", "transitions", 5_000)).toBeCloseTo(150, -1)
    expect(rate(all, "sfn", "transitionsThrottled")).toBe(0)
  })

  it("past the open-executions quota, StartExecution fails with ExecutionLimitExceeded", async () => {
    const { all, state } = await run({ client: { rps: 50 }, tasks: tasks(10_000), account: { sfnOpenExecutions: 100 } }, 40_000)
    expect(state.running).toBeLessThanOrEqual(100)
    // A hundred open, each for ten seconds: ten a second get in.
    expect(rate(all, "sfn", "started", 20_000)).toBeCloseTo(10, 0)
    expect(rate(all, "web", "fail.Throttled", 20_000)).toBeCloseTo(40, 0)
  })

  it("a Standard execution fails when its history would pass 25,000 events: an Inline Map of 5,000 items does", async () => {
    const one = (items: number, mode = "inline") => run({ client: { rps: 0.1 }, tasks: [{ id: "item", ms: 1, state: { state: "map", map: { items, mode } } }] }, 60_000)
    const inline = await one(5_000)
    expect(inline.state.historyExceeded).toBeGreaterThan(3)
    expect(inline.state.succeeded).toBe(0)
    // 3,000 items write about 21,000 events, under the quota.
    expect((await one(3_000)).state.historyExceeded).toBe(0)
    // Distributed, each item is a child execution with a history of its own.
    const distributed = await one(5_000, "distributed")
    expect(distributed.state.historyExceeded).toBe(0)
    expect(distributed.state.succeeded).toBeGreaterThan(3)
  })
})

describe("aws.stepfunctions: hardening", () => {
  it("is deterministic: the same design and seed give the same counts", async () => {
    const doc = workflow({ machine: { transitionLatency: { mean: 20, cv: 0.5 } }, client: { arrival: "poisson", rps: 30 }, tasks: [{ id: "t1", endpoint: { errorRate: 0.3 }, state: { retrier: { enabled: true, jitter: "FULL" } } }] })
    const a = await runDoc(doc, 20_000)
    const b = await runDoc(doc, 20_000)
    expect(a.state).toEqual(b.state)
  })

  it("an edge edited while running changes the workflow of the next executions", () => {
    const doc = workflow({ machine: { workflowType: "express" }, tasks: tasks(100, 100) })
    return sim(doc, (s) =>
      Effect.gen(function*() {
        const before = yield* s.advanceTo(10_000)
        expect(p50(before, "web", "latency", 2_000)).toBeCloseTo(200, -1)
        yield* s.configureEdge("sfn.out->t2", { parallel: true })
        const after = yield* s.advanceTo(20_000)
        expect(p50(after, "web", "latency", 12_000)).toBeCloseTo(100, -1)
      }))
  })

  it("an execution that ends gives back everything it held", async () => {
    // Executions time out while waiting for transitions, mid-retry and mid-Map: nothing stays counted.
    const doc = workflow({
      machine: { timeout: "2 seconds" },
      client: { rps: 50 },
      tasks: [{ id: "t1", ms: 10, endpoint: { errorRate: 0.5 }, state: { retrier: { enabled: true } } }, { id: "t2", ms: 500, state: { state: "map", map: { items: 100 } } }],
      account: { sfnStateTransitionRate: 200, sfnStateTransitionBurst: 200 }
    })
    const result = await sim(doc, (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(20_000)
        yield* s.configureNode("web", { rps: 0 })
        yield* s.advanceTo(30_000)
        return (yield* s.probe("sfn")).state as Record<string, number>
      }))
    expect(result.timedOut).toBeGreaterThan(100)
    expect(result.running).toBe(0)
    expect(result.openInRegion).toBe(0)
    expect(result.waitingForTransition).toBe(0)
  })
})

describe("aws.stepfunctions: audit", () => {
  const member = (config: Partial<Settings>) => ({ id: "sfn", name: "Orders", type: "aws.stepfunctions", config: { workflowType: "standard", timeout: Duration.zero, duplicateRate: 0, ...config } })
  const codes = (config: Partial<Settings>) => audit("us-east-1", [member(config)] as never, {} as never).map((d) => d.code)

  it("warns about an Express timeout past five minutes, which never applies", () => {
    expect(codes({ workflowType: "express", timeout: Duration.minutes(10) })).toEqual(["stepfunctions-express-timeout"])
    expect(codes({ workflowType: "express", timeout: Duration.minutes(2) })).toEqual([])
    expect(codes({ workflowType: "standard", timeout: Duration.minutes(10) })).toEqual([])
  })

  it("notes a duplicate rate on a Standard workflow, which is exactly-once", () => {
    expect(codes({ duplicateRate: 0.1 })).toEqual(["stepfunctions-standard-duplicates"])
    expect(codes({ workflowType: "express", duplicateRate: 0.1 })).toEqual([])
  })
})
