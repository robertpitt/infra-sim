import { Effect, Graph } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "./Builder.ts"
import { frames, mean, sim } from "./components/testing.ts"
import { registry } from "./components/registry.ts"
import * as Connector from "./Connector.ts"
import * as Design from "./Design.ts"

const typeOf = (from: { type: string; port: string }, to: string, explicit?: string) => {
  const picked = registry.connectorFor(from, to, explicit)
  return picked.ok ? picked.connector.type : `error: ${picked.reason}`
}

describe("Connector.pick: the most specific connector that fits", () => {
  const fits = (type: string, from: Connector.FromEnd, to: Connector.ToEnd = { protocol: "invoke" }): Connector.Fits => ({ type, from, to })
  const q: Connector.Query = { from: { component: "queue", port: "out", protocol: "pull" }, to: { component: "fn", protocol: "invoke" } }

  it("prefers naming the component and port, then the component, then only the protocols", () => {
    const all = [
      fits("protocols", { protocol: "pull" }),
      fits("component", { protocol: "pull", component: "queue" }),
      fits("component-and-port", { protocol: "pull", component: "queue", port: "out" }),
      fits("both-ends", { protocol: "pull", component: "queue", port: "out" }, { protocol: "invoke", component: "fn" })
    ]
    const pickedType = (candidates: ReadonlyArray<Connector.Fits>) => {
      const p = Connector.pick(candidates, q)
      return p.ok ? p.connector.type : undefined
    }
    expect(pickedType(all)).toBe("both-ends")
    expect(pickedType(all.slice(0, 3))).toBe("component-and-port")
    expect(pickedType(all.slice(0, 2))).toBe("component")
    expect(pickedType(all.slice(0, 1))).toBe("protocols")
    expect(Connector.candidates(all, q).map((c) => c.type)).toEqual(["both-ends", "component-and-port", "component", "protocols"])
  })

  it("never fits the wrong protocol, another component, or a target that accepts nothing", () => {
    expect(Connector.pick([fits("push", { protocol: "invoke" })], q).ok).toBe(false)
    expect(Connector.pick([fits("other", { protocol: "pull", component: "topic" })], q).ok).toBe(false)
    expect(Connector.pick([fits("any", { protocol: "pull" })], { ...q, to: { component: "client", protocol: undefined } }).ok).toBe(false)
  })

  it("keeps the first registered among equally specific ones", () => {
    const p = Connector.pick([fits("first", { protocol: "pull" }), fits("second", { protocol: "pull" })], q)
    expect(p.ok && p.connector.type).toBe("first")
  })
})

describe("the registry's connectors", () => {
  it("gives every push the plain link and a queue's consumers Lambda's event source mapping", () => {
    expect(typeOf({ type: "common.client", port: "out" }, "aws.lambda")).toBe("core.link")
    expect(typeOf({ type: "aws.lambda", port: "out" }, "aws.sqs")).toBe("core.link")
    expect(typeOf({ type: "aws.sqs", port: "deliver" }, "aws.lambda")).toBe("aws.sqs.event-source-mapping")
    // A consumer that isn't a function is polled the same way unless the edge says otherwise.
    expect(typeOf({ type: "aws.sqs", port: "deliver" }, "common.http-endpoint")).toBe("aws.sqs.event-source-mapping")
  })

  it("takes a connector the document names, if it fits", () => {
    expect(typeOf({ type: "aws.sqs", port: "deliver" }, "common.http-endpoint", "core.poller")).toBe("core.poller")
    expect(typeOf({ type: "common.client", port: "out" }, "aws.lambda", "core.poller")).toMatch(/doesn't fit/)
    expect(typeOf({ type: "common.client", port: "out" }, "aws.lambda", "core.nothing")).toMatch(/unknown connector/)
  })

  it("builds an edge's settings from its port, its connector and transport", () => {
    const fields = (from: { type: string; port: string }, to: string) => {
      const picked = registry.connectorFor(from, to)
      if (!picked.ok) throw new Error(picked.reason)
      const port = registry.get(from.type)!.ports[from.port]
      return Object.keys(Connector.edgeSchema(picked.connector, port).fields)
    }
    expect(fields({ type: "common.client", port: "out" }, "aws.lambda")).toEqual(["weight", "request", "timeout", "cancelOnTimeout", "retry", "latency"])
    const mapping = fields({ type: "aws.sqs", port: "deliver" }, "aws.lambda")
    expect(mapping).toEqual(expect.arrayContaining(["batchSize", "batchWindow", "maxConcurrency", "latency"]))
    // The mapping waits for the function, so a caller's timeout and retries aren't its settings.
    expect(mapping).not.toContain("timeout")
    expect(mapping).not.toContain("retry")
  })
})

describe("connectors in a design", () => {
  const queued = (connector?: string, settings: Record<string, unknown> = {}) => {
    const b = Builder.make("queued", { seed: 4 })
    const web = b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 50 } })
    const q = b.add("aws.sqs", { id: "q" })
    const worker = b.add("common.http-endpoint", { id: "worker", settings: { latency: { mean: 1_000, cv: 0 } } })
    b.connect(web, q)
    b.connect(q.port("deliver"), worker, { batchSize: 1, ...settings }, connector === undefined ? {} : { connector })
    return b.build()
  }
  const edgeOf = (design: Design.Design, id: string) => [...Graph.edges(design.graph)].map(([, e]) => e.data).find((e) => e.id === id)!

  it("resolves each edge's connector, and writes it back only when the document named it", () => {
    const inferred = Design.resolve(queued(), registry).design!
    expect(edgeOf(inferred, "q.deliver->worker").connector.type).toBe("aws.sqs.event-source-mapping")
    expect(edgeOf(inferred, "web.out->q").connector.type).toBe("core.link")
    expect(Design.encode(inferred, registry).edges["q.deliver->worker"]!.connector).toBeUndefined()
    const named = Design.resolve(queued("core.poller", { workers: 3 }), registry).design!
    expect(edgeOf(named, "q.deliver->worker").connector.type).toBe("core.poller")
    expect(Design.encode(named, registry).edges["q.deliver->worker"]!.connector).toBe("core.poller")
  })

  it("reports a connector that doesn't fit", () => {
    const doc = Design.setConnector(queued(), "web.out->q", "core.poller")
    const { diagnostics } = Design.resolve(doc, registry)
    expect(diagnostics.map((d) => d.code)).toEqual(["bad-connector"])
    expect(diagnostics[0]!.edge).toBe("web.out->q")
  })

  it("probes an edge's connector: the event source mapping's pollers", () =>
    sim(queued(), (s) =>
      Effect.gen(function*() {
        // Five pollers to start with, all busy; under that pressure it adds 300 a minute, five a second.
        yield* s.advanceTo(500)
        const mapping = yield* s.probeEdge("q.deliver->worker")
        expect(mapping.connector).toBe("aws.sqs.event-source-mapping")
        expect(mapping.state).toEqual({ concurrency: 5, busy: 5 })
        yield* s.advanceTo(2_500)
        const later = yield* s.probeEdge("q.deliver->worker")
        expect(later.state).toEqual({ concurrency: 15, busy: 15 })
        const link = yield* s.probeEdge("web.out->q")
        expect(link.connector).toBe("core.link")
        const all = yield* s.inspect
        expect(all.edges["q.deliver->worker"]!.connector).toBe("aws.sqs.event-source-mapping")
        expect(all.edges["q.deliver->worker"]!.probe.state).toEqual(later.state)
      })))

  it("a fixed pool of workers holds its concurrency where the mapping would scale up", async () => {
    // 50 messages a second at a second each needs 50 at once. Three workers stay three; the mapping climbs.
    const fixed = await frames(queued("core.poller", { workers: 3 }), 40_000)
    const scaling = await frames(queued(), 40_000)
    expect(mean(fixed, "nodes", "worker", "gauges", "inflight", 20_000)).toBeCloseTo(3, 0)
    expect(mean(fixed, "nodes", "worker", "rates", "ok", 20_000)).toBeCloseTo(3, 0)
    expect(mean(fixed, "nodes", "q", "rates", "deleted", 20_000)).toBeCloseTo(3, 0)
    expect(mean(scaling, "nodes", "worker", "gauges", "inflight", 30_000)).toBeGreaterThan(20)
  })

  it("applies a change to the number of workers at once", () =>
    sim(queued("core.poller", { workers: 2 }), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(10_000)
        yield* s.configureEdge("q.deliver->worker", { workers: 8, batchSize: 1 })
        const all = yield* s.advanceTo(20_000)
        expect(mean(all, "nodes", "worker", "gauges", "inflight", 12_000)).toBeCloseTo(8, 0)
        expect((yield* s.probeEdge("q.deliver->worker")).state).toMatchObject({ workers: 8, busy: 8 })
      })))

  it("leaves a failed batch to the queue, which hands it out again when its visibility timeout ends", () =>
    sim(queued("core.poller", { workers: 2 }), (s) =>
      Effect.gen(function*() {
        yield* s.configureNode("q", { visibilityTimeout: "2 seconds" })
        const outage = yield* s.faults.inject({ kind: "node", id: "worker" }, { _tag: "Outage" }, "10 seconds")
        expect(outage.id).toBeDefined()
        const all = yield* s.advanceTo(30_000)
        expect(mean(all, "nodes", "q", "rates", "redelivered", 2_000, 10_000)).toBeGreaterThan(0)
        expect((yield* s.probeEdge("q.deliver->worker")).state).toMatchObject({ workers: 2 })
        expect(((yield* s.probeEdge("q.deliver->worker")).state as { failed: number }).failed).toBeGreaterThan(0)
      })))

  it("the event source mapping waits for a slow consumer instead of timing out at 30 seconds", async () => {
    // Each message takes 45 s. A caller's 30 s timeout would abandon every batch and the queue would redeliver it.
    const b = Builder.make("slow", { seed: 2 })
    const web = b.add("common.client", { id: "web", settings: { arrival: "constant", rps: 1 } })
    const q = b.add("aws.sqs", { id: "q", settings: { visibilityTimeout: "5 minutes" } })
    const worker = b.add("common.http-endpoint", { id: "worker", settings: { latency: { mean: 45_000, cv: 0 } } })
    b.connect(web, q)
    b.connect(q.port("deliver"), worker, { batchSize: 1 })
    const all = await frames(b.build(), 120_000)
    const edge = all.map((f) => f.edges["q.deliver->worker"]?.rates["fail.Timeout"] ?? 0)
    expect(Math.max(...edge)).toBe(0)
    expect(mean(all, "nodes", "q", "rates", "deleted", 60_000)).toBeGreaterThan(0.5)
    expect(mean(all, "nodes", "q", "rates", "redelivered")).toBe(0)
  })
})
