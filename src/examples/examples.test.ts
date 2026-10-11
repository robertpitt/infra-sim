import { Effect, Schema } from "effect"
import YAML from "yaml"
import { describe, expect, it } from "vitest"
import { type Example, examples, parseDesign } from "./index.ts"
import * as Design from "../simulator/Design.ts"
import { diagnose, hasErrors } from "../simulator/Diagnostics.ts"
import { frames, mean, sim } from "../simulator/components/testing.ts"
import { registry } from "../simulator/components/registry.ts"

const example = (id: string) => examples.find((e) => e.id === id)!
const runnable = examples.filter((e) => e.id !== "blank").map((e): [string, Example] => [e.id, e])

describe("the example designs", () => {
  it("are read from the files in examples/, in filename order", () => {
    expect(examples.map((e) => e.id)).toEqual(["orders", "retry-storm", "multi-region", "fan-out", "poshub", "cluster", "blank"])
  })

  it.each(examples.map((e): [string, Example] => [e.id, e]))("%s: is a valid design with no errors, a title and a blurb", (_id, e) => {
    expect(hasErrors(diagnose(e.design(), registry))).toBe(false)
    expect(e.title).not.toBe("")
    if (e.id !== "blank") expect(e.blurb.length).toBeGreaterThan(20)
  })

  it.each(runnable)("%s: every node is placed, and the design survives the codec, YAML and JSON", (_id, e) => {
    const doc = e.design()
    expect(Object.values(doc.nodes).every((n) => n.position !== undefined)).toBe(true)
    const codec = Design.codec(registry)
    const design = Schema.decodeUnknownSync(codec)(doc)
    expect(Schema.decodeUnknownSync(codec)(Schema.encodeSync(codec)(design))).toBeDefined()
    expect(parseDesign(YAML.stringify(doc))).toEqual(doc)
    expect(parseDesign(JSON.stringify(doc))).toEqual(doc)
  })

  it.each(runnable)("%s: runs for a simulated minute without a component crashing", (_id, e) =>
    sim(e.design(), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(60_000)
        // A crashing component is contained and reported as a defect rather than failing the run.
        expect(yield* s.defects).toEqual([])
      })))

  it("reject a file that isn't a design, saying why", () => {
    expect(() => parseDesign("version: 2\nnodes: {}\nedges: {}")).toThrow()
    expect(() => parseDesign("just some text")).toThrow()
  })
})

describe("the autoscaled cluster", () => {
  it("is built without any cloud: only provider-neutral components and a core controller", () => {
    const doc = example("cluster").design()
    expect(Object.values(doc.nodes).every((n) => n.type.startsWith("common."))).toBe(true)
    expect(Object.values(doc.controllers ?? {}).map((c) => c.type)).toEqual(["core.target-tracking"])
  })

  it("refuses requests while the spike outruns replicas that are still starting, catches up, and scales back in", () =>
    sim(example("cluster").design(), (s) =>
      Effect.gen(function*() {
        const all = yield* s.advanceTo(420_000)
        const refused = (from: number, to: number) => mean(all, "nodes", "api", "rates", "fail.Unavailable", from, to)
        const ready = (from: number, to: number) => mean(all, "nodes", "api", "gauges", "ready", from, to)
        expect(refused(10_000, 60_000)).toBe(0) // before the spike
        const early = refused(60_000, 90_000)
        expect(early).toBeGreaterThan(20) // the spike, while the new replicas start
        expect(refused(105_000, 120_000)).toBeLessThan(early / 4) // later in it, with most of the replicas it needs
        expect(refused(125_000, 420_000)).toBe(0) // after it
        expect(ready(100_000, 120_000)).toBeGreaterThan(1.4 * ready(30_000, 60_000))
        // Two minutes after its last change the autoscaler takes the extra replicas away again.
        expect(ready(400_000, 420_000)).toBeLessThan(ready(140_000, 160_000))
        const scaler = yield* s.probeController("api-autoscaler")
        expect((scaler.state as { decisions: ReadonlyArray<unknown> }).decisions.length).toBeGreaterThan(2)
      })))
})

describe("the POS Hub design", () => {
  const poshub = () => example("poshub").design()
  const edgesFrom = (node: string, port?: string) =>
    Object.entries(poshub().edges).filter(([, e]) => e.from.node === node && e.from.port === port)

  it("has all 28 tables, each with CDK provenance", () => {
    const tables = Object.entries(poshub().nodes).filter(([, n]) => n.type === "aws.dynamodb")
    expect(tables).toHaveLength(28)
    for (const [, n] of tables) expect(n.origin?.source).toContain("POSHubDatabaseStack.ts")
  })

  it("spreads about 70 global secondary indexes over the 28 tables, an assumed 2 or 3 each", () => {
    const tables = Object.values(poshub().nodes).filter((n) => n.type === "aws.dynamodb")
    const counts = tables.map((n) => (n.settings?.gsi as { count?: number } | undefined)?.count)
    expect(counts.every((c) => c === 2 || c === 3)).toBe(true)
    expect(counts.reduce((a: number, c) => a + (c ?? 0), 0)).toBe(70)
  })

  it("runs everything AWS inside one region box, with the S3 buckets and their notifications drawn", () => {
    const doc = poshub()
    const box = doc.nodes["aws-eu-west-1"]!
    const aws = Object.values(doc.nodes).filter((n) => n.type.startsWith("aws.") && n.type !== "aws.region")
    expect(aws.every((n) => n.parent === "aws-eu-west-1")).toBe(true)
    // every AWS node sits inside the box, every client and endpoint outside it
    const inside = (n: { position?: { x: number; y: number } }) =>
      n.position!.x >= box.position!.x && n.position!.x <= box.position!.x + box.size!.w - 200 &&
      n.position!.y >= box.position!.y && n.position!.y <= box.position!.y + box.size!.h - 100
    expect(aws.every(inside)).toBe(true)
    expect(Object.values(doc.nodes).filter((n) => !n.type.startsWith("aws.")).some(inside)).toBe(false)
    // no two nodes are drawn on top of each other
    const spots = Object.values(doc.nodes).map((n) => `${n.position!.x},${n.position!.y}`)
    expect(new Set(spots).size).toBe(spots.length)
    expect(aws.filter((n) => n.type === "aws.s3")).toHaveLength(3)
    const notification = Object.values(doc.edges).find((e) => e.from.node === "assets" && e.from.port === "events" && e.to === "image-drop-handler")
    expect(notification?.settings).toEqual({ eventTypes: "created", filter: 0.9 })
  })

  it("captures table changes with DynamoDB Streams, not stand-in queues", () => {
    const doc = poshub()
    expect(doc.nodes["change-stream"]).toBeUndefined()
    expect(doc.nodes["scheduler-stream"]).toBeUndefined()
    const captured = Object.values(doc.edges).filter((e) => e.from.port === "stream")
    expect(captured).toHaveLength(19)
    const toBus = captured.filter((e) => e.to === "store-change-handler")
    expect(toBus).toHaveLength(18)
    // the event source mapping carries the settings of the retired SQS edge
    for (const e of toBus) expect(e.settings).toEqual({ timeout: "10 seconds", batchSize: 100, batchWindow: "1 second" })
    for (const e of toBus) expect(doc.nodes[e.from.node]?.type).toBe("aws.dynamodb")
    const scheduler = edgesFrom("scheduler-table", "stream")
    expect(scheduler).toHaveLength(1)
    expect(scheduler[0]![1].to).toBe("scheduler-stream-handler")
    // nothing else sends to the old queues' consumers
    expect(Object.values(doc.edges).filter((e) => e.to === "store-change-handler").every((e) => e.from.port === "stream")).toBe(true)
  })

  it("writes made through the API reach webhook receivers and the search queue, by way of the table streams", async () => {
    const all = await frames(poshub(), 60_000)
    const late = (id: string, name: string) => mean(all, "nodes", id, "rates", name, 30_000)
    expect(late("api", "ok")).toBeGreaterThan(30)
    expect(late("token-authorizer", "ok")).toBeGreaterThan(30)
    expect(late("orders", "streamAppended")).toBeGreaterThan(1)
    expect(late("orders", "streamDelivered")).toBeGreaterThan(1)
    expect(late("store-change-handler", "ok")).toBeGreaterThan(0)
    expect(late("events", "ok")).toBeGreaterThan(1)
    expect(late("webhook-dispatcher", "ok")).toBeGreaterThan(0)
    expect(late("partner-webhooks", "in")).toBeGreaterThan(0)
    expect(late("opensearch-ingress", "ok")).toBeGreaterThan(0)
    // the scheduler table's stream reaches its handler, which queues the work
    expect(late("scheduler-table", "streamAppended")).toBeGreaterThan(0)
    expect(late("scheduler-stream-handler", "ok")).toBeGreaterThan(0)
    expect(late("scheduler-queue", "in")).toBeGreaterThan(0)
  })

  it("keeps the event bus from feeding itself: the load settles instead of growing", async () => {
    const early = mean(await frames(poshub(), 120_000), "nodes", "events", "rates", "ok", 30_000)
    const later = mean(await frames(poshub(), 300_000), "nodes", "events", "rates", "ok", 30_000)
    expect(later).toBeLessThan(early * 1.5)
  })

  it("an upload to the assets bucket invokes the image handler through S3's event notification", async () => {
    const all = await frames(poshub(), 120_000)
    expect(mean(all, "nodes", "assets", "rates", "put", 30_000)).toBeGreaterThan(0)
    expect(mean(all, "nodes", "image-drop-handler", "rates", "ok", 30_000)).toBeGreaterThan(0)
  })

  it("sends invitation, invoice and performance email through SES", async () => {
    const doc = poshub()
    expect(doc.nodes.ses?.type).toBe("aws.ses")
    const senders = Object.values(doc.edges).filter((e) => e.to === "ses").map((e) => e.from.node).sort()
    expect(senders).toEqual(["api-handler", "performance-report-handler", "process-invoice-queue"])
    expect(Object.values(doc.edges).filter((e) => e.from.node === "ses")).toEqual([])
    const all = await frames(doc, 120_000)
    expect(mean(all, "nodes", "ses", "rates", "send", 60_000)).toBeGreaterThan(0)
    expect(mean(all, "nodes", "ses", "rates", "fail", 60_000)).toBe(0)
  })

  it("serves media through a CloudFront distribution that caches in front of the assets bucket", async () => {
    const doc = poshub()
    expect(doc.nodes["media-cdn"]?.type).toBe("aws.cloudfront")
    expect(doc.nodes["media-viewers"]?.origin?.source).toBe("assumed")
    const origin = Object.values(doc.edges).find((e) => e.from.node === "media-cdn")
    expect(origin?.to).toBe("assets")
    expect(origin?.settings).toMatchObject({ originType: "s3", request: { operation: "read" } })
    const all = await frames(doc, 120_000)
    const late = (name: string) => mean(all, "nodes", "media-cdn", "rates", name, 60_000)
    expect(late("requests")).toBeGreaterThan(10)
    expect(late("cacheHit")).toBeGreaterThan(0)
    expect(late("originRequests")).toBeGreaterThan(0)
    expect(late("originRequests")).toBeLessThan(late("requests"))
    expect(late("err5xx")).toBe(0)
  })

  it("says what it leaves out", () => {
    const text = poshub().description ?? ""
    for (const service of ["OpenSearch", "SES", "DynamoDB Streams", "EventBridge", "CloudFront", "SSM"]) expect(text).toContain(service)
    expect(text).toContain("What the simulator cannot show")
    // no stand-in queue is claimed any more
    expect(text).not.toContain("DynamoDB Streams stand-in")
  })
})
