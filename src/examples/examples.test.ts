import { Effect, Schema } from "effect"
import YAML from "yaml"
import { describe, expect, it } from "vitest"
import { type Example, examples, parseDesign } from "./index.ts"
import * as Design from "../simulator/Design.ts"
import { diagnose, hasErrors } from "../simulator/Diagnostics.ts"
import { frames, mean, sim } from "../simulator/components/testing.ts"
import { registry } from "../simulator/components/registry.ts"

const example = (id: string) => examples.find((e) => e.id === id)!
const byType = Object.fromEntries(registry.manifests.map((m) => [m.type, m]))
const runnable = examples.filter((e) => e.id !== "blank").map((e): [string, Example] => [e.id, e])

describe("the example designs", () => {
  it("are read from the files in examples/, in filename order", () => {
    expect(examples.map((e) => e.id)).toEqual(["ingestion", "url-shortener", "orders", "retry-storm", "multi-region", "fan-out", "cluster", "order-saga", "clickstream", "product-catalog", "saas-api", "web-tier", "containers", "kubernetes", "blank"])
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

  it.each(runnable)("%s: is laid out so that no two components overlap", (_id, e) => {
    // A card is 236 wide; its height grows with its output ports, a row each when there is more than one.
    const height = (type: string) => {
      const outputs = byType[type]?.outputs.length ?? 1
      return 96 + (outputs > 1 ? outputs * 24 + 8 : 0)
    }
    const rects = Object.entries(e.design().nodes)
      .filter(([, n]) => byType[n.type]?.container === undefined)
      .map(([id, n]) => ({ id, x: n.position!.x, y: n.position!.y, w: 236, h: height(n.type) }))
    const overlaps = rects.flatMap((a, i) =>
      rects.slice(i + 1).filter((b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).map((b) => `${a.id} and ${b.id}`))
    expect(overlaps).toEqual([])
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
  it("is built without any cloud: only provider-neutral components and core controllers", () => {
    const doc = example("cluster").design()
    expect(Object.values(doc.nodes).every((n) => n.type.startsWith("common."))).toBe(true)
    expect(Object.keys(doc.controllers ?? {})).toEqual(["api-autoscaler", "recommendations-autoscaler"])
    expect(Object.values(doc.controllers ?? {}).every((c) => c.type.startsWith("core."))).toBe(true)
  })

  it("refuses requests while a surge outruns replicas that are still starting, catches up, and scales back in", () => {
    const doc = example("cluster").design()
    return sim(doc, (s) => {
      /** Every client's traffic, at a multiple of the design's. */
      const traffic = (times: number) =>
        Effect.forEach(["web", "mobile"], (id) => {
          const settings = doc.nodes[id]!.settings as { readonly rps: number }
          return s.configureNode(id, { ...settings, rps: settings.rps * times })
        })
      return Effect.gen(function*() {
        // Three times the traffic from one minute to two.
        const before = yield* s.advanceTo(60_000)
        yield* traffic(3)
        const during = yield* s.advanceTo(120_000)
        yield* traffic(1)
        const all = [...before, ...during, ...(yield* s.advanceTo(420_000))]
        const refused = (from: number, to: number) => mean(all, "nodes", "api", "rates", "fail.Unavailable", from, to)
        const ready = (from: number, to: number) => mean(all, "nodes", "api", "gauges", "ready", from, to)
        expect(refused(10_000, 60_000)).toBe(0) // before the surge
        const early = refused(60_000, 90_000)
        expect(early).toBeGreaterThan(20) // the surge, while the new replicas start
        expect(refused(105_000, 120_000)).toBeLessThan(early / 4) // later in it, with most of the replicas it needs
        expect(refused(125_000, 420_000)).toBe(0) // after it
        expect(ready(100_000, 120_000)).toBeGreaterThan(1.4 * ready(30_000, 60_000))
        // Two minutes after its last change the autoscaler takes the extra replicas away again.
        expect(ready(400_000, 420_000)).toBeLessThan(ready(140_000, 160_000))
        const scaler = yield* s.probeController("api-autoscaler")
        expect((scaler.state as { decisions: ReadonlyArray<unknown> }).decisions.length).toBeGreaterThan(2)
      })
    })
  })
})

describe("the event ingestion platform", () => {
  const ingestion = () => example("ingestion").design()

  it("keeps the forwarder, the NAT gateway, the query handler, the gateway endpoints and the search domain in the VPC", () => {
    const doc = ingestion()
    const inVpc = Object.entries(doc.nodes).filter(([, n]) => n.parent === "platform-vpc").map(([id]) => id).sort()
    expect(inVpc).toEqual(["dynamodb-endpoint", "forwarder", "nat", "profile-search", "profile-sync", "query-service", "s3-endpoint"])
    expect(Object.values(doc.nodes).filter((n) => n.type.startsWith("aws.") && n.type !== "aws.region").every((n) => n.parent !== undefined)).toBe(true)
  })

  it("streams every event to the lake, the profiles and the destinations, and nobody sees an error", async () => {
    const all = await frames(ingestion(), 90_000)
    const late = (id: string, name: string) => mean(all, "nodes", id, "rates", name, 45_000)
    const records = (edge: string) => mean(all, "edges", edge, "rates", "records", 45_000)
    const streamed = late("events-stream", "incoming")
    expect(streamed).toBeGreaterThan(400)
    // Each of the stream's three readers gets every event, at its own pace.
    expect(late("lake-delivery", "incoming") / streamed).toBeCloseTo(1, 1)
    expect(records("events-stream.consumers->enricher") / streamed).toBeCloseTo(1, 1)
    expect(late("destinations-queue", "in") / streamed).toBeCloseTo(1, 1)
    expect(late("lake", "put")).toBeGreaterThan(0)
    expect(late("profiles", "streamDelivered")).toBeGreaterThan(0)
    expect(late("profile-search", "indexed")).toBeGreaterThan(0)
    expect(late("profile-search", "searchRequests")).toBeGreaterThan(0)
    expect(late("crm-api", "in")).toBeGreaterThan(late("ads-api", "in"))
    expect(mean(all, "nodes", "export-job", "rates", "invocations")).toBeGreaterThan(0)
    for (const client of ["browser-sdk", "server-sdk", "partner-webhooks", "analysts", "sdk-page-loads"]) expect(late(client, "fail")).toBe(0)
  })

  it("serves the SDK from CloudFront's cache, and most queries from the API's", async () => {
    const all = await frames(ingestion(), 90_000)
    const late = (id: string, name: string) => mean(all, "nodes", id, "rates", name, 45_000)
    expect(late("sdk-cdn", "originRequests")).toBeLessThan(late("sdk-cdn", "requests") / 20)
    expect(late("query-service", "in")).toBeLessThan(late("query-api", "in"))
  })

  it("scales the collect function's provisioned concurrency with its load", () =>
    sim(ingestion(), (s) =>
      Effect.gen(function*() {
        yield* s.advanceTo(120_000)
        const scaler = yield* s.probeController("collect-provisioned")
        expect((scaler.state as { decisions: ReadonlyArray<unknown> }).decisions.length).toBeGreaterThan(0)
      })))

  it("carries scenarios that check something, and says what it leaves out", () => {
    const doc = ingestion()
    expect(Object.keys(doc.scenarios ?? {})).toEqual(["launch", "crm-outage", "profiles-throttled"])
    for (const s of Object.values(doc.scenarios ?? {})) expect(s.assert?.length).toBeGreaterThan(3)
    expect(doc.description).toContain("What the simulator cannot show")
  })
})

describe("the URL shortener", () => {
  const shortener = () => example("url-shortener").design()

  it("serves most redirects from CloudFront's cache, streams every click to the counter and the archive, and checks every new link", async () => {
    const all = await frames(shortener(), 90_000)
    const late = (id: string, name: string) => mean(all, "nodes", id, "rates", name, 45_000)
    const counter = (kind: "rates" | "gauges", name: string) => mean(all, "edges", "clicks.consumers->counter", kind, name, 45_000)
    expect(late("redirect-cdn", "originRequests")).toBeLessThan(late("redirect-cdn", "requests") / 2)
    expect(late("resolve", "in")).toBeCloseTo(late("redirect-cdn", "originRequests"), -1)
    // Every click goes into the Kinesis stream, and its two consumers, the counter and the raw-click archive, each read all of it.
    expect(late("clicks", "incoming") / late("click-log", "ok")).toBeCloseTo(1, 1)
    expect(counter("rates", "records") / late("clicks", "incoming")).toBeCloseTo(1, 1)
    expect(counter("gauges", "iteratorAge")).toBeLessThan(5_000)
    expect(late("click-counts", "consumedWrite") / late("click-log", "ok")).toBeCloseTo(1, 1)
    expect(late("lake-feed", "incoming") / late("clicks", "incoming")).toBeCloseTo(1, 1)
    expect(late("safe-browsing", "in") / (late("creators", "ok") + late("importer", "ok"))).toBeCloseTo(1, 1)
    expect(late("qr-codes", "put")).toBeGreaterThan(0)
    // Expired links reach the archive through the table's stream.
    expect(late("links", "ttlDeleted")).toBeGreaterThan(0)
    expect(late("archive", "in")).toBeGreaterThan(0)
    for (const client of ["creators", "importer", "visitors", "click-log", "dashboards", "web-visitors"]) expect(late(client, "fail")).toBe(0)
  })

  it("carries scenarios that check something, and says what it leaves out", () => {
    const doc = shortener()
    expect(Object.keys(doc.scenarios ?? {})).toEqual(["viral", "viral-on-demand", "bulk-import", "bad-deploy"])
    for (const s of Object.values(doc.scenarios ?? {})) expect(s.assert?.length).toBeGreaterThan(3)
    expect(doc.description).toContain("What the simulator cannot show")
  })
})
