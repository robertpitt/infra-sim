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
    expect(examples.map((e) => e.id)).toEqual(["orders", "retry-storm", "multi-region", "fan-out", "poshub", "blank"])
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

describe("the POS Hub design", () => {
  it("has all 28 tables, each with CDK provenance", () => {
    const tables = Object.entries(example("poshub").design().nodes).filter(([, n]) => n.type === "aws.dynamodb")
    expect(tables).toHaveLength(28)
    for (const [, n] of tables) expect(n.origin?.source).toContain("POSHubDatabaseStack.ts")
  })

  it("runs everything AWS inside one region box, with the S3 buckets and their notifications drawn", () => {
    const doc = example("poshub").design()
    const aws = Object.values(doc.nodes).filter((n) => n.type.startsWith("aws.") && n.type !== "aws.region")
    expect(aws.every((n) => n.parent === "aws-eu-west-1")).toBe(true)
    expect(aws.filter((n) => n.type === "aws.s3")).toHaveLength(3)
    expect(Object.values(doc.edges).some((e) => e.from.node === "assets" && e.from.port === "events" && e.to === "image-drop-handler")).toBe(true)
  })

  it("writes made through the API reach webhook receivers and the search queue", async () => {
    const all = await frames(example("poshub").design(), 60_000)
    const late = (id: string, name: string) => mean(all, "nodes", id, "rates", name, 30_000)
    expect(late("api", "ok")).toBeGreaterThan(30)
    expect(late("change-stream", "in")).toBeGreaterThan(1)
    expect(late("store-change-handler", "ok")).toBeGreaterThan(0)
    expect(late("events", "ok")).toBeGreaterThan(1)
    expect(late("webhook-dispatcher", "ok")).toBeGreaterThan(0)
    expect(late("partner-webhooks", "in")).toBeGreaterThan(0)
    expect(late("opensearch-ingress", "ok")).toBeGreaterThan(0)
  })

  it("an upload to the assets bucket invokes the image handler through S3's event notification", async () => {
    const all = await frames(example("poshub").design(), 120_000)
    expect(mean(all, "nodes", "assets", "rates", "put", 30_000)).toBeGreaterThan(0)
    expect(mean(all, "nodes", "image-drop-handler", "rates", "ok", 30_000)).toBeGreaterThan(0)
  })

  it("says what it leaves out", () => {
    const text = example("poshub").design().description ?? ""
    for (const service of ["OpenSearch", "SES", "DynamoDB Streams", "EventBridge"]) expect(text).toContain(service)
  })
})
