import { Duration, Effect, Graph, Schema, SchemaIssue } from "effect"
import { describe, expect, it } from "vitest"
import * as Builder from "./Builder.ts"
import { registry } from "./components/registry.ts"
import * as Design from "./Design.ts"
import { diagnose } from "./Diagnostics.ts"
import { autoLayout } from "./Layout.ts"
import * as Topology from "./Topology.ts"

const codec = Design.codec(registry)
const decode = Schema.decodeUnknownSync(codec)

const pipeline = () => {
  const b = Builder.make("Orders", { seed: 7 })
  const web = b.add("common.client", { id: "web", settings: { rps: 120, spike: { multiplier: 3, start: "10 seconds" } } })
  const api = b.add("aws.lambda", { id: "api", settings: { memory: 512 } })
  const q = b.add("aws.sqs", { id: "q", settings: { visibilityTimeout: "45 seconds" } })
  const dlq = b.add("aws.sqs", { id: "dlq" })
  b.connect(web, api, { timeout: "3 seconds", retry: { maxAttempts: 3 } })
  b.connect(api, q)
  b.connect(q.port("dlq"), dlq)
  return b.build()
}

const nodeOf = (design: Design.Design, id: string) => {
  const index = design.nodeIndex.get(id)!
  return [...Graph.nodes(design.graph)].find(([i]) => i === index)![1]
}

describe("Design codec: JSON in, configured instance out", () => {
  it("decodes a document into a Graph of components with typed, fully-defaulted settings", () => {
    const design = decode(pipeline())
    expect(design.seed).toBe(7)
    expect(Graph.nodeCount(design.graph)).toBe(4)
    expect(Graph.edgeCount(design.graph)).toBe(3)
    const web = nodeOf(design, "web").config as { rps: number; arrival: string; spike: { multiplier: number; start: Duration.Duration; duration: Duration.Duration } }
    expect(web.rps).toBe(120)
    expect(web.arrival).toBe("poisson") // default, not in the document
    expect(Duration.toMillis(web.spike.start)).toBe(10_000) // "10 seconds" became a real Duration
    expect(Duration.toMillis(web.spike.duration)).toBe(30_000) // default
    expect(Duration.toMillis((nodeOf(design, "q").config as { visibilityTimeout: Duration.Duration }).visibilityTimeout)).toBe(45_000)
  })

  it("decodes edge settings too: universal policy plus the port's own", () => {
    const design = decode(pipeline())
    const edge = [...Graph.edges(design.graph)].map(([, e]) => e.data).find((e) => e.id.startsWith("web"))!
    const config = edge.config as { timeout: Duration.Duration; retry: { maxAttempts: number; jitter: boolean }; weight: number }
    expect(Duration.toMillis(config.timeout)).toBe(3000)
    expect(config.retry.maxAttempts).toBe(3)
    expect(config.retry.jitter).toBe(true) // default
    expect(config.weight).toBe(1)
  })

  it("round-trips: encoding a design and decoding it again changes nothing", () => {
    const design = decode(pipeline())
    const written = Design.encode(design, registry)
    // Written in full and in JSON-safe form (durations as milliseconds)...
    expect(JSON.parse(JSON.stringify(written))).toEqual(written)
    expect((written.nodes.q!.settings as { visibilityTimeout: number }).visibilityTimeout).toBe(45_000)
    // ...and stable.
    expect(Design.encode(decode(written), registry)).toEqual(written)
  })

  it("composes with Schema.fromJsonString: text on disk to a running-ready design", () => {
    const text = JSON.stringify(pipeline())
    const design = Schema.decodeUnknownSync(Schema.fromJsonString(codec))(text)
    expect(Graph.nodeCount(design.graph)).toBe(4)
    expect(Schema.encodeSync(Schema.fromJsonString(codec))(design)).toContain('"visibilityTimeout":45000')
  })

  it("reports every problem at once, each located by id", () => {
    const doc = Builder.make("bad")
    doc.add("aws.lambda", { id: "a", settings: { memory: 500_000 } })
    doc.add("aws.lambda", { id: "b", settings: { provisioned: 1.5 } })
    doc.add("aws.sqs", { id: "c", settings: { visibilityTimeout: "a while" } })
    doc.add("mystery", { id: "d" })
    doc.add("aws.lambda", { id: "fine" })
    const failure = Effect.runSync(Effect.flip(Schema.decodeUnknownEffect(codec)(doc.build(), { errors: "all" })))
    const issues = SchemaIssue.makeFormatterStandardSchemaV1()(failure.issue).issues
    // One issue per bad node, none for the good one, each pointing at the node by id.
    expect(issues.map((i) => i.path)).toEqual([["nodes", "a"], ["nodes", "b"], ["nodes", "c"], ["nodes", "d"]])
    const messages = issues.map((i) => i.message).join("\n")
    expect(messages).toMatch(/memory/)
    expect(messages).toMatch(/provisioned/)
    expect(messages).toMatch(/duration/)
    expect(messages).toMatch(/unknown component type "mystery"/)
  })

  it("refuses a document that isn't one", () => {
    expect(() => decode({ version: 2, nodes: {}, edges: {} })).toThrow()
    expect(() => decode({ version: 1, nodes: { a: { settings: {} } }, edges: {} })).toThrow()
  })
})

describe("Design document edits", () => {
  it("generates unique ids and removes a node together with its edges", () => {
    const a = Design.addNode(Design.empty("t"), { type: "aws.lambda", name: "Worker" })
    const b = Design.addNode(a.doc, { type: "aws.lambda", name: "Worker" })
    expect([a.id, b.id]).toEqual(["worker", "worker-2"])
    const doc = Design.connect(b.doc, { from: { node: "worker" }, to: "worker-2" }).doc
    expect(Object.keys(doc.edges)).toEqual(["worker.out->worker-2"])
    expect(Object.keys(Design.removeNode(doc, "worker-2").edges)).toEqual([])
  })

  it("sets nested setting overrides and drops them again", () => {
    let doc = Design.addNode(Design.empty(), { id: "n", type: "aws.lambda" }).doc
    doc = Design.setNodeSetting(doc, "n", ["duration", "cv"], 0.9)
    expect(doc.nodes.n!.settings).toEqual({ duration: { cv: 0.9 } })
    doc = Design.setNodeSetting(doc, "n", ["duration", "cv"], undefined)
    expect(doc.nodes.n!.settings).toEqual({})
  })

  it("parses untrusted JSON as a document", () => {
    const doc = pipeline()
    expect(Design.parse(JSON.parse(JSON.stringify(doc)))).toEqual({ ok: true, doc })
    expect(Design.parse({ version: 2 }).ok).toBe(false)
  })
})

describe("diagnostics", () => {
  const codes = (doc: Design.Doc) => diagnose(doc, registry).map((d) => d.code).sort()

  it("a sound design has no problems", () => {
    expect(codes(pipeline())).toEqual([])
  })

  it("reports unknown components, bad settings, edges to nowhere, bad ports and impossible connections", () => {
    const b = Builder.make()
    const web = b.add("common.client", { settings: { rps: 99_999_999 } })
    const api = b.add("aws.lambda")
    b.add("mystery")
    b.connect(web, api)
    b.connect(api, web) // into a source
    b.connect(api.port("nope"), web)
    expect(codes(b.build())).toEqual(["bad-settings", "no-input", "unknown-component", "unknown-port"])
    expect(codes({ ...Design.empty(), edges: { x: { from: { node: "a" }, to: "b" } } })).toEqual(["dangling-edge"])
  })

  it("enforces single-connection ports", () => {
    const b = Builder.make()
    const q = b.add("aws.sqs")
    b.connect(q.port("dlq"), b.add("aws.sqs"))
    b.connect(q.port("dlq"), b.add("aws.sqs"))
    expect(codes(b.build())).toContain("port-single")
  })

  it("flags feedback loops: the shape retry storms and redrive loops take", () => {
    const b = Builder.make()
    const web = b.add("common.client")
    const a = b.add("aws.lambda", { id: "a" })
    const c = b.add("aws.lambda", { id: "c" })
    b.connect(web, a)
    b.connect(a, c)
    b.connect(c, a)
    const found = diagnose(b.build(), registry).find((d) => d.code === "feedback-loop")
    expect(found?.level).toBe("warning")
    expect(found?.message).toMatch(/a → c/)
  })

  it("flags nodes no client can reach, and clients wired to nothing", () => {
    const b = Builder.make()
    b.add("common.client", { id: "lonely" })
    const used = b.add("common.client", { id: "used" })
    b.connect(used, b.add("aws.lambda", { id: "reached" }))
    b.add("aws.lambda", { id: "orphan" })
    const found = diagnose(b.build(), registry)
    expect(found.filter((d) => d.code === "unreachable").map((d) => d.node)).toEqual(["orphan"])
    expect(found.filter((d) => d.code === "source-unconnected").map((d) => d.node)).toEqual(["lonely"])
  })
})

describe("Topology (Graph)", () => {
  const sample = () => {
    const b = Builder.make()
    const src = b.add("common.client", { id: "src" })
    const a = b.add("aws.lambda", { id: "a" })
    const c = b.add("aws.lambda", { id: "c" })
    const d = b.add("aws.lambda", { id: "d" })
    b.add("aws.lambda", { id: "island" })
    b.connect(src, a)
    b.connect(a, c)
    b.connect(c, d)
    return Topology.fromDoc(b.build(), registry)
  }

  it("answers blast-radius and ancestry questions", () => {
    const t = sample()
    expect([...Topology.downstream(t, "a")].sort()).toEqual(["c", "d"])
    expect([...Topology.upstream(t, "d")].sort()).toEqual(["a", "c", "src"])
    expect(Topology.downstream(t, "d")).toEqual([])
    expect([...Topology.reachable(t)].sort()).toEqual(["a", "c", "d", "src"])
  })

  it("renders a Mermaid diagram", () => {
    const text = Topology.toMermaid(sample())
    expect(text).toMatch(/^flowchart LR/)
    expect(text).toContain("src · common.client")
    expect(text).toContain("-->")
  })
})

describe("autoLayout", () => {
  it("lays nodes out left to right by distance from the source, without disturbing positioned nodes", () => {
    const b = Builder.make()
    const src = b.add("common.client", { id: "src" })
    const a = b.add("aws.lambda", { id: "a" })
    const c = b.add("aws.lambda", { id: "c", at: [999, 999] })
    const d = b.add("aws.lambda", { id: "d" })
    b.connect(src, a)
    b.connect(a, c)
    b.connect(src, d)
    const laid = autoLayout(b.build(), registry)
    const x = (id: string) => laid.nodes[id]!.position!.x
    expect(x("src")).toBeLessThan(x("a"))
    expect(laid.nodes.c!.position).toEqual({ x: 999, y: 999 })
    expect(laid.nodes.a!.position!.y).not.toBe(laid.nodes.d!.position!.y)
  })

  it("survives cycles and places every node", () => {
    const b = Builder.make()
    const src = b.add("common.client", { id: "src" })
    const a = b.add("aws.lambda", { id: "a" })
    const c = b.add("aws.lambda", { id: "c" })
    b.connect(src, a)
    b.connect(a, c)
    b.connect(c, a)
    b.connect(c, c)
    const laid = autoLayout(b.build(), registry)
    for (const node of Object.values(laid.nodes)) expect(node.position).toBeDefined()
    expect(laid.nodes.c!.position!.x).toBeGreaterThan(laid.nodes.a!.position!.x)
  })
})

void Effect
