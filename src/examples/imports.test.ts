import { Effect } from "effect"
import YAML from "yaml"
import { describe, expect, it } from "vitest"
import * as Design from "../simulator/Design.ts"
import { diagnose, hasErrors } from "../simulator/Diagnostics.ts"
import * as Layout from "../simulator/Layout.ts"
import { registry } from "../simulator/components/registry.ts"
import { sim } from "../simulator/components/testing.ts"
import { CloudFormation, detect, ImportError } from "../simulator/importers/index.ts"
import { Evaluator, Reference, isUnresolved, parseTemplate, referencesIn } from "../simulator/importers/Intrinsics.ts"

const fixtures = import.meta.glob("../../examples/imports/*.yaml", { query: "?raw", import: "default", eager: true }) as Record<string, string>
const fixture = (name: string) => fixtures[`../../examples/imports/${name}`]!
const run = (text: string, options = {}) => CloudFormation.run(text, registry, { region: "eu-west-1", ...options })
const node = (doc: Design.Doc, id: string) => doc.nodes[id]!
const edge = (doc: Design.Doc, from: string, port: string, to: string) => Object.values(doc.edges).find((e) => e.from.node === from && Design.portOf(e) === port && e.to === to)

describe("reading templates", () => {
  it("understands the short forms of the intrinsic functions", () => {
    const t = parseTemplate("A: !Ref Thing\nB: !GetAtt Queue.Arn\nC: !Join ['-', [a, !Ref X]]\nD: !Sub 'x-${Y}'\nE: !If [Cond, 1, 2]") as Record<string, unknown>
    expect(t).toEqual({
      A: { Ref: "Thing" },
      B: { "Fn::GetAtt": "Queue.Arn" },
      C: { "Fn::Join": ["-", ["a", { Ref: "X" }]] },
      D: { "Fn::Sub": "x-${Y}" },
      E: { "Fn::If": ["Cond", 1, 2] }
    })
  })

  it("reads JSON templates too", () => {
    expect(parseTemplate('{"Resources": {"Q": {"Type": "AWS::SQS::Queue"}}}')).toEqual({ Resources: { Q: { Type: "AWS::SQS::Queue" } } })
  })

  const evaluator = (conditions: Record<string, unknown> = {}, parameters: Record<string, unknown> = {}) =>
    new Evaluator({ parameters, mappings: { M: { a: { b: 7 } } }, conditions, region: "eu-west-1", stackName: "stack" })

  it("resolves what the template alone decides: parameters, conditions, mappings, pseudo parameters, Sub and Join", () => {
    const ev = evaluator({ IsProd: { "Fn::Equals": [{ Ref: "Stage" }, "prod"] } }, { Stage: "prod" })
    expect(ev.value({ "Fn::If": ["IsProd", 400, 50] })).toBe(400)
    expect(ev.value({ "Fn::FindInMap": ["M", "a", "b"] })).toBe(7)
    expect(ev.value({ "Fn::Sub": "q-${Stage}-${AWS::Region}" })).toBe("q-prod-eu-west-1")
    expect(ev.value({ "Fn::Join": ["/", ["a", { Ref: "Stage" }]] })).toBe("a/prod")
    expect(ev.value({ Keep: 1, Drop: { Ref: "AWS::NoValue" } })).toEqual({ Keep: 1 })
  })

  it("keeps references to other resources, and finds them inside strings", () => {
    const ev = evaluator()
    const v = ev.value({ A: { "Fn::GetAtt": ["Queue", "Arn"] }, B: { "Fn::Sub": "arn:aws:lambda:${AWS::Region}:fn/${Fn.Arn}/invocations" } })
    expect((v as { A: unknown }).A).toBeInstanceOf(Reference)
    expect(referencesIn(v)).toEqual(["Queue", "Fn"])
  })

  it("says what it can't know instead of guessing", () => {
    const ev = evaluator({}, {})
    expect(isUnresolved(ev.value({ "Fn::ImportValue": "x" }))).toBe(true)
    expect(isUnresolved(ev.value({ "Fn::If": ["NoSuchCondition", 1, 2] }))).toBe(true)
  })
})

describe("schedules", () => {
  const rate = (expression: string) => {
    const { doc, report } = run(`Resources:\n  F:\n    Type: AWS::Lambda::Function\n    Properties: {Runtime: nodejs20.x}\n  R:\n    Type: AWS::Events::Rule\n    Properties:\n      ScheduleExpression: ${expression}\n      Targets: [{Arn: !GetAtt F.Arn, Id: t}]\n`)
    return { doc, report, rps: (node(doc, "schedule-r").settings as { rps: number }).rps }
  }

  it("turns rate() into events per second", () => {
    expect(rate("rate(5 minutes)").rps).toBeCloseTo(1 / 300, 8)
    expect(rate("rate(1 hour)").rps).toBeCloseTo(1 / 3600, 8)
    expect(rate("rate(2 days)").rps).toBeCloseTo(1 / 172_800, 10)
  })

  it("reads cron() as best it can", () => {
    expect(rate("cron(0 2 * * ? *)").rps).toBeCloseTo(1 / 86_400, 10) // daily
    expect(rate("cron(0/15 * * * ? *)").rps).toBeCloseTo(4 / 3600, 8) // every 15 minutes
    expect(rate("cron(0 9-17 * * ? *)").rps).toBeCloseTo(9 / 86_400, 10) // nine times a day
    const weekdays = rate("cron(0 8 ? * MON-FRI *)")
    expect(weekdays.rps).toBeCloseTo((5 / 7) / 86_400, 10) // weekdays only
    expect(weekdays.report.warnings.some((w) => w.includes("approximated"))).toBe(false)
    expect(rate("cron(0 8 1 * ? *)").report.warnings.some((w) => w.includes("approximated"))).toBe(true) // first of the month: depends on month length
  })

  it("wires the schedule to its targets as an asynchronous, evenly spaced source", () => {
    const { doc } = rate("rate(1 hour)")
    expect(node(doc, "schedule-r").settings).toMatchObject({ arrival: "constant", invocation: "async" })
    expect(edge(doc, "schedule-r", "out", "f")).toBeDefined()
  })
})

describe("the SAM orders template", () => {
  const { doc, report } = run(fixture("orders-sam.yaml"), { fileName: "orders-sam.yaml" })

  it("becomes a design the simulator accepts", () => {
    expect(hasErrors(diagnose(doc, registry))).toBe(false)
    expect(Object.values(doc.nodes).every((n) => n.position !== undefined)).toBe(true)
  })

  it("puts everything AWS inside a region box and the callers outside it", () => {
    expect(node(doc, "aws-eu-west-1")).toMatchObject({ type: "aws.region", settings: { region: "eu-west-1" } })
    expect(node(doc, "orders-queue").parent).toBe("aws-eu-west-1")
    expect(node(doc, "callers-of-serverless-rest-api")).toMatchObject({ type: "common.client" })
    expect(node(doc, "callers-of-serverless-rest-api").parent).toBeUndefined()
  })

  it("carries over what the template says, resolving parameters and conditions", () => {
    expect(node(doc, "orders-table").settings).toEqual({ mode: "provisioned", readCapacity: 200, writeCapacity: 400 })
    expect(node(doc, "orders-queue").settings).toEqual({ visibilityTimeout: "180 seconds", retention: "86400 seconds", maxReceives: 3 })
    expect(node(doc, "place-order-function").settings).toEqual({ memory: 512, timeout: "10 seconds" })
    expect(node(doc, "process-order-function").settings).toMatchObject({ memory: 1024, timeout: "60 seconds", reserved: { enabled: true, concurrency: 50 } })
  })

  it("draws the wiring the template states", () => {
    expect(edge(doc, "orders-queue", "dlq", "orders-dead-letters")).toBeDefined()
    expect(edge(doc, "orders-queue", "deliver", "process-order-function")?.settings).toEqual({ batchSize: 10, batchWindow: "5 seconds", maxConcurrency: 20 })
    expect(edge(doc, "serverless-rest-api", "out", "place-order-function")).toBeDefined()
  })

  it("infers what functions use from environment variables and policies, with reads and writes told apart", () => {
    expect(edge(doc, "place-order-function", "out", "orders-queue")).toBeDefined()
    expect(edge(doc, "place-order-function", "out", "orders-table")?.settings).toEqual({ request: { operation: "write" } })
    expect(edge(doc, "nightly-report-function", "out", "orders-table")?.settings).toEqual({ request: { operation: "read" } })
    expect(edge(doc, "orders-table", "out", "place-order-function")).toBeUndefined()
  })

  it("turns a schedule event into a traffic source", () => {
    expect((node(doc, "schedule-nightly-report-function").settings as { rps: number }).rps).toBeCloseTo(1 / 86_400, 10)
  })

  it("keeps its provenance and says what it did", () => {
    expect(node(doc, "orders-queue").origin).toEqual({ source: "cloudformation", ref: "OrdersQueue", type: "AWS::SQS::Queue" })
    expect(report.converted.map((c) => c.id)).toEqual(expect.arrayContaining(["OrdersTable", "OrdersQueue", "PlaceOrderFunction"]))
    expect(report.skipped).toEqual([{ id: "ProcessOrderLogs", type: "AWS::Logs::LogGroup", reason: expect.any(String), quiet: true }])
    expect(report.connections.declared).toBe(4)
    expect(report.connections.inferred).toBe(5)
    expect(report.settings.preserved).toBeGreaterThan(15)
    expect(report.added.some((a) => a.includes("traffic source"))).toBe(true)
    expect(doc.description).toContain("Orders API")
  })

  it("runs: orders come in, are queued, processed and written", () =>
    sim(doc, (s) =>
      Effect.gen(function*() {
        const frames = yield* s.advanceTo(60_000)
        expect(yield* s.defects).toEqual([])
        const late = frames.filter((f) => f.t > 30_000)
        const mean = (id: string, rate: string) => late.reduce((n, f) => n + (f.nodes[id]?.rates[rate] ?? 0), 0) / late.length
        expect(mean("place-order-function", "ok")).toBeGreaterThan(10)
        expect(mean("process-order-function", "in")).toBeGreaterThan(0)
        expect(mean("orders-table", "in")).toBeGreaterThan(10)
      })))

  it("survives being saved as YAML and read back", () => {
    expect(YAML.parse(YAML.stringify(doc))).toEqual(JSON.parse(JSON.stringify(doc)))
  })
})

describe("the CloudFormation fan-out template", () => {
  const { doc, report } = run(fixture("fanout-cfn.yaml"), { fileName: "fanout-cfn.yaml" })

  it("becomes a design the simulator accepts, and runs", () =>
    sim(doc, (s) =>
      Effect.gen(function*() {
        expect(hasErrors(diagnose(doc, registry))).toBe(false)
        yield* s.advanceTo(60_000)
        expect(yield* s.defects).toEqual([])
      })))

  it("resolves mappings and carries over async invocation, throttle and timeout settings", () => {
    expect(node(doc, "thumbnail-function").settings).toEqual({ memory: 256, timeout: "120 seconds" })
    expect(node(doc, "audit-function").settings).toMatchObject({ async: { maxRetries: 1, maxEventAge: "3600 seconds" } })
    expect(node(doc, "public-api").settings).toEqual({ apiType: "http", integrationTimeout: "10000 millis", stageThrottle: { rate: 500, burst: 1000 } })
  })

  it("draws notifications, subscriptions, event sources and integrations", () => {
    expect(edge(doc, "uploads-bucket", "events", "thumbnail-function")).toBeDefined()
    expect(edge(doc, "order-events", "out", "audit-queue")).toBeDefined()
    expect(edge(doc, "audit-queue", "deliver", "audit-function")?.settings).toEqual({ batchSize: 25, batchWindow: "10 seconds" })
    expect(edge(doc, "public-api", "out", "publish-function")).toBeDefined()
    expect(edge(doc, "publish-function", "out", "order-events")).toBeDefined()
  })

  it("represents an HTTPS subscriber as an external service named by its host", () => {
    expect(node(doc, "hooks-partner-example-com")).toMatchObject({ type: "common.http-endpoint" })
    expect(edge(doc, "order-events", "out", "hooks-partner-example-com")).toBeDefined()
  })

  it("doesn't read a shared role's permissions as each function's behaviour", () => {
    expect(report.warnings.some((w) => w.includes("ThumbnailRole is shared by 3 functions"))).toBe(true)
    expect(edge(doc, "audit-function", "out", "uploads-bucket")).toBeUndefined()
    // and doesn't draw a loop back into the bucket that triggers the function
    expect(edge(doc, "thumbnail-function", "out", "uploads-bucket")).toBeUndefined()
  })

  it("adds a writer for a bucket nothing in the template writes to", () => {
    expect(edge(doc, "writers-to-uploads-bucket", "out", "uploads-bucket")).toBeDefined()
  })

  it("lists what it left out: quietly for permissions and conditions, loudly for services with no component", () => {
    const byId = Object.fromEntries(report.skipped.map((s) => [s.id, s]))
    expect(byId.ThumbnailRole?.quiet).toBe(true)
    expect(byId.ProdOnlyAlarm?.reason).toContain("condition IsProdOnly is false")
    expect(byId.SearchDomain).toMatchObject({ quiet: false, reason: "OpenSearchService has no simulator component yet" })
  })
})

describe("what a template can't say", () => {
  it("keeps a component's default for values computed at deploy time, and reports them", () => {
    const { doc, report } = run("Resources:\n  F:\n    Type: AWS::Lambda::Function\n    Properties:\n      MemorySize: !ImportValue SharedMemory\n      Timeout: 20\n")
    expect(node(doc, "f").settings).toEqual({ timeout: "20 seconds" })
    expect(report.settings.unresolved).toEqual([expect.stringContaining("MemorySize")])
  })

  it("brings values the simulator doesn't allow into range, and says so", () => {
    const { doc, report } = run("Resources:\n  F:\n    Type: AWS::Lambda::Function\n    Properties:\n      MemorySize: 100000\n      Timeout: 5000\n")
    expect(node(doc, "f").settings).toEqual({ memory: 10_240, timeout: "900000 millis" })
    expect(report.settings.adjusted).toHaveLength(2)
  })

  it("leaves out a disabled rule and an event-pattern rule, saying why", () => {
    const { report } = run("Resources:\n  A:\n    Type: AWS::Events::Rule\n    Properties: {State: DISABLED, ScheduleExpression: rate(1 minute)}\n  B:\n    Type: AWS::Events::Rule\n    Properties: {EventPattern: {source: [aws.ec2]}}\n  Q:\n    Type: AWS::SQS::Queue\n")
    expect(report.skipped.map((s) => s.id).sort()).toEqual(["A", "B"])
  })
})

describe("names", () => {
  it("uses the CDK construct path when there is one, and drops CDK's hash suffix otherwise", () => {
    const { doc } = run(`Resources:
  OrdersQueue9A8B7C6D:
    Type: AWS::SQS::Queue
    Metadata: {"aws:cdk:path": "Shop/Orders/Queue/Resource"}
  AuditTable1F2E3D4C:
    Type: AWS::DynamoDB::Table
`)
    expect(Object.values(doc.nodes).map((n) => n.name)).toEqual(expect.arrayContaining(["Orders / Queue", "AuditTable"]))
  })
})

describe("recognising and refusing", () => {
  it("detects CloudFormation, and nothing else", () => {
    expect(detect(fixture("orders-sam.yaml"))?.id).toBe("cloudformation")
    expect(detect('{"Resources": {"Q": {"Type": "AWS::SQS::Queue"}}}')?.id).toBe("cloudformation")
    expect(detect("version: 1\nnodes: {}\nedges: {}")).toBeUndefined()
    expect(detect("just text")).toBeUndefined()
  })

  it("refuses text that isn't a template, saying so", () => {
    expect(() => run("nope: [")).toThrow(ImportError)
    expect(() => run("Parameters: {}")).toThrow(/no Resources/)
    expect(() => run("Resources: {}")).toThrow(/no Resources/)
  })

  it("falls back to us-east-1 for a region it doesn't know", () => {
    const { doc, report } = run("Resources:\n  Q:\n    Type: AWS::SQS::Queue\n", { region: "mars-1" })
    expect(node(doc, "aws-us-east-1").settings).toEqual({ region: "us-east-1" })
    expect(report.warnings[0]).toContain("mars-1")
  })
})

// ---------------------------------------------------------------------------------------------------------
// The reworked services. Each section imports a fixture or a few lines of template and asserts the exact
// settings and edges, and that what can't be represented is in the report.
// ---------------------------------------------------------------------------------------------------------

const settings = (doc: Design.Doc, id: string) => node(doc, id).settings ?? {}
const edgeSettings = (doc: Design.Doc, from: string, port: string, to: string) => {
  const e = edge(doc, from, port, to)
  return e === undefined ? undefined : (e.settings ?? {})
}
const warned = (report: { warnings: ReadonlyArray<string> }, text: string) => report.warnings.some((w) => w.includes(text))
const skippedOf = (report: { skipped: ReadonlyArray<{ id: string; reason: string; quiet: boolean }> }, id: string) => report.skipped.find((s) => s.id === id)

/** Imports a few resources written as the body of a `Resources:` section. */
const resources = (body: string, options = {}) => run(`Resources:\n${body}`, options)

describe("every fixture", () => {
  for (const name of ["data-pipeline.yaml", "global-table.yaml", "web-delivery.yaml", "email.yaml", "vpc.yaml"]) {
    it(`${name} imports to a design with no errors, and runs for a simulated minute without defects`, () => {
      const { doc } = run(fixture(name), { fileName: name })
      expect(hasErrors(diagnose(doc, registry))).toBe(false)
      expect(Object.values(doc.nodes).every((n) => n.position !== undefined)).toBe(true)
      return sim(doc, (s) =>
        Effect.gen(function*() {
          yield* s.advanceTo(60_000)
          expect(yield* s.defects).toEqual([])
        }))
    })
  }
})

describe("the serverless data pipeline", () => {
  const { doc, report } = run(fixture("data-pipeline.yaml"), { fileName: "data-pipeline.yaml" })

  it("sets a table's on-demand limits and warm throughput, reading -1 as no limit", () => {
    expect(settings(doc, "readings-table")).toEqual({
      mode: "on-demand",
      onDemand: { maxReadUnits: 4000, maxWriteUnits: 0, warmReadUnits: 12000, warmWriteUnits: 8000 },
      gsi: { count: 2 },
      lsi: { count: 1 },
      stream: { view: "new" }
    })
  })

  it("counts the indexes, sizes every global index like the widest, and prices keys-only entries", () => {
    expect(settings(doc, "rollups-table")).toEqual({ mode: "provisioned", readCapacity: 50, writeCapacity: 80, gsi: { count: 2, readCapacity: 40, writeCapacity: 60, entryBytes: 128 } })
    // ALL projections leave the entry size at the component's "whole item".
    expect((settings(doc, "readings-table") as { gsi: Record<string, unknown> }).gsi.entryBytes).toBeUndefined()
    expect(warned(report, "RollupsTable: its 2 global secondary indexes differ")).toBe(true)
  })

  it("draws every stream consumer from the table's stream port, with the mapping's settings", () => {
    expect(edgeSettings(doc, "readings-table", "stream", "projector-function")).toEqual({
      batchSize: 200,
      batchWindow: "5 seconds",
      parallelization: 4,
      maxRecordAge: 3600,
      maxRetries: 5,
      bisectOnError: true
    })
    // The SAM `DynamoDB` event and a bare mapping become edges too.
    expect(edgeSettings(doc, "readings-table", "stream", "audit-function")).toEqual({ batchSize: 50, maxRetries: 2 })
    expect(edgeSettings(doc, "readings-table", "stream", "notify-function")).toEqual({})
  })

  it("sends a mapping's on-failure destination from the table's discarded port", () => {
    expect(edge(doc, "readings-table", "discarded", "projection-failures")).toBeDefined()
  })

  it("no longer says streams and indexes aren't modelled, but reports what a template can't give: TTL, filters", () => {
    expect(report.warnings.some((w) => /not modelled|aren't modelled/.test(w))).toBe(false)
    expect(warned(report, "ReadingsTable: TTL is on (expires)")).toBe(true)
    expect(warned(report, "ProjectorFunction: FilterCriteria")).toBe(true)
    // TableClass has no behaviour, and is ignored.
    expect((settings(doc, "readings-table") as Record<string, unknown>).ttl).toBeUndefined()
  })

  it("maps a FIFO queue's content-based deduplication, high throughput and redrive", () => {
    expect(settings(doc, "readings-queue")).toEqual({ kind: "fifo", visibilityTimeout: "60 seconds", highThroughput: true, deduplication: true, maxReceives: 4 })
  })

  it("maps provisioned pollers and partial batch responses on a queue's consumer edge", () => {
    expect(edgeSettings(doc, "readings-queue", "deliver", "ingest-function")).toEqual({ batchSize: 10, provisionedMinPollers: 4, provisionedMaxPollers: 20, reportBatchItemFailures: true })
    expect(warned(report, "IngestFunction: ReportBatchItemFailures isn't simulated")).toBe(false)
  })

  it("maps a FIFO topic's throughput scope, deduplication and size (bytes to KB)", () => {
    expect(settings(doc, "alerts-topic")).toEqual({ kind: "fifo", fifoThroughput: "messageGroup", deduplication: true, maxMessageSize: 512 })
  })

  it("maps a subscription's raw delivery and redrive to a dead-letter queue on the topic's dlq port", () => {
    expect(edgeSettings(doc, "alerts-topic", "out", "alerts-queue")).toEqual({ rawMessageDelivery: true, deadLetterQueue: true })
    expect(edge(doc, "alerts-topic", "dlq", "alerts-dead-letters")).toBeDefined()
  })

  it("reports a filter policy as not simulated and leaves the match rate alone", () => {
    expect(warned(report, "AlertsTopic → AlertsQueue: the FilterPolicy isn't simulated")).toBe(true)
    expect((edgeSettings(doc, "alerts-topic", "out", "alerts-queue") as Record<string, unknown>).filterMatch).toBeUndefined()
  })

  it("maps an HTTP subscription's delivery policy to the edge's retry and throttle (retries plus one)", () => {
    expect(edgeSettings(doc, "partner-topic", "out", "alerts-partner-example-com")).toEqual({
      rawMessageDelivery: false,
      retry: { maxAttempts: 10, backoff: "2 seconds", maxBackoff: "60 seconds" },
      maxReceivesPerSecond: 5
    })
  })

  it("maps SnapStart, and the success and failure destinations of a function", () => {
    // The function reads its queue with partial batch responses, so it is taken to report the records that fail.
    expect(settings(doc, "ingest-function")).toEqual({ memory: 1024, timeout: "20 seconds", coldStart: { snapStart: true }, async: { maxRetries: 1 }, batch: { errors: "report" } })
    expect(edge(doc, "ingest-function", "onSuccess", "ingest-audit")).toBeDefined()
    expect(edge(doc, "ingest-function", "onFailure", "ingest-failures")).toBeDefined()
  })

  it("adds a writer to the table, whose stream would otherwise never carry anything", () => {
    expect(node(doc, "writers-to-readings-queue")).toBeDefined()
    expect(report.converted.map((c) => c.id)).toEqual(expect.arrayContaining(["ReadingsTable", "RollupsTable", "ProjectorMapping"]))
  })
})

describe("DynamoDB", () => {
  it("reads a table's streams only as the view the template names, and leaves a table without one alone", () => {
    for (const [type, view] of [["KEYS_ONLY", "keys"], ["NEW_IMAGE", "new"], ["OLD_IMAGE", "old"], ["NEW_AND_OLD_IMAGES", "new-and-old"]] as const) {
      const { doc } = resources(`  T:\n    Type: AWS::DynamoDB::Table\n    Properties: {StreamSpecification: {StreamViewType: ${type}}}\n`)
      expect(settings(doc, "t")).toEqual({ stream: { view } })
    }
    expect(settings(resources("  T:\n    Type: AWS::DynamoDB::Table\n").doc, "t")).toEqual({})
  })

  it("warns about a stream nothing in the template reads, since none is produced", () => {
    const { report } = resources("  T:\n    Type: AWS::DynamoDB::Table\n    Properties: {StreamSpecification: {StreamViewType: NEW_IMAGE}}\n")
    expect(warned(report, "T has a stream that nothing in this template reads")).toBe(true)
  })

  it("takes the capacity of the widest index when a provisioned table's indexes differ, and says so", () => {
    const { doc, report } = resources(`  T:
    Type: AWS::DynamoDB::Table
    Properties:
      ProvisionedThroughput: {ReadCapacityUnits: 10, WriteCapacityUnits: 10}
      GlobalSecondaryIndexes:
        - {IndexName: a, ProvisionedThroughput: {ReadCapacityUnits: 5, WriteCapacityUnits: 7}, Projection: {ProjectionType: ALL}}
        - {IndexName: b, ProvisionedThroughput: {ReadCapacityUnits: 9, WriteCapacityUnits: 3}, Projection: {ProjectionType: INCLUDE, NonKeyAttributes: [x]}}
`)
    expect(settings(doc, "t")).toMatchObject({ gsi: { count: 2, readCapacity: 9, writeCapacity: 7 } })
    expect(warned(report, "differ in capacity or projection")).toBe(true)
    expect(warned(report, "INCLUDE copies attributes the template doesn't size")).toBe(true)
  })

  it("gives on-demand indexes their maximum throughput, and no provisioned capacity", () => {
    const { doc } = resources(`  T:
    Type: AWS::DynamoDB::Table
    Properties:
      BillingMode: PAY_PER_REQUEST
      GlobalSecondaryIndexes:
        - {IndexName: a, OnDemandThroughput: {MaxReadRequestUnits: 100, MaxWriteRequestUnits: 50}}
`)
    expect(settings(doc, "t")).toEqual({ mode: "on-demand", gsi: { count: 1, maxReadUnits: 100, maxWriteUnits: 50 } })
  })

  it("keeps a SAM SimpleTable's default capacity, and reads its stream through a SAM event", () => {
    const { doc } = run(`Transform: AWS::Serverless-2016-10-31
Resources:
  T:
    Type: AWS::Serverless::SimpleTable
  F:
    Type: AWS::Serverless::Function
    Properties:
      Runtime: x
      Handler: h
      Events:
        S: {Type: DynamoDB, Properties: {Stream: !GetAtt T.StreamArn, StartingPosition: LATEST, MaximumRecordAgeInSeconds: 120, BisectBatchOnFunctionError: true}}
`)
    expect(settings(doc, "t")).toEqual({ mode: "provisioned", readCapacity: 5, writeCapacity: 5 })
    expect(edgeSettings(doc, "t", "stream", "f")).toEqual({ maxRecordAge: 120, bisectOnError: true })
  })

  it("brings a record age or retry count outside the component's range into it, and says so", () => {
    const { doc, report } = resources(`  T:
    Type: AWS::DynamoDB::Table
  F:
    Type: AWS::Lambda::Function
    Properties: {Runtime: x}
  M:
    Type: AWS::Lambda::EventSourceMapping
    Properties: {EventSourceArn: !GetAtt T.StreamArn, FunctionName: !Ref F, MaximumRecordAgeInSeconds: 1000000, ParallelizationFactor: 50}
`)
    expect(edgeSettings(doc, "t", "stream", "f")).toEqual({ maxRecordAge: 604800, parallelization: 10 })
    expect(report.settings.adjusted).toEqual(expect.arrayContaining([expect.stringContaining("maxRecordAge 1000000"), expect.stringContaining("parallelization 50")]))
  })

  it("reports a destination that can't take discarded batches, or isn't in the template", () => {
    const { doc, report } = resources(`  T:
    Type: AWS::DynamoDB::Table
  F:
    Type: AWS::Lambda::Function
    Properties: {Runtime: x}
  B:
    Type: AWS::S3::Bucket
  M:
    Type: AWS::Lambda::EventSourceMapping
    Properties:
      EventSourceArn: !GetAtt T.StreamArn
      FunctionName: !Ref F
      DestinationConfig: {OnFailure: {Destination: !GetAtt B.Arn}}
  M2:
    Type: AWS::Lambda::EventSourceMapping
    Properties:
      EventSourceArn: !GetAtt T.StreamArn
      FunctionName: !Ref F
      DestinationConfig: {OnFailure: {Destination: "arn:aws:sqs:eu-west-1:123456789012:elsewhere"}}
`)
    expect(edge(doc, "t", "discarded", "b")).toBeUndefined()
    expect(warned(report, "can't receive it here")).toBe(true)
    expect(warned(report, "arn:aws:sqs:eu-west-1:123456789012:elsewhere, which isn't in this template")).toBe(true)
  })

  it("does not read a mapping to a Kinesis stream as one the simulator can model", () => {
    const { report } = resources(`  K:
    Type: AWS::Kinesis::Stream
    Properties: {ShardCount: 1}
  F:
    Type: AWS::Lambda::Function
    Properties: {Runtime: x}
  M:
    Type: AWS::Lambda::EventSourceMapping
    Properties: {EventSourceArn: !GetAtt K.Arn, FunctionName: !Ref F, StartingPosition: LATEST}
`)
    expect(skippedOf(report, "M")).toMatchObject({ quiet: false, reason: "only SQS queues and DynamoDB streams are modelled as event sources" })
  })
})

describe("a global table", () => {
  const { doc, report } = run(fixture("global-table.yaml"), { fileName: "global-table.yaml" })

  it("becomes one table per replica region, each in that region's box", () => {
    expect(node(doc, "sessions-table").parent).toBe("aws-eu-west-1")
    expect(node(doc, "sessions-table-us-east-1").parent).toBe("aws-us-east-1")
    expect(node(doc, "sessions-table-ap-southeast-2").parent).toBe("aws-ap-southeast-2")
    expect(node(doc, "aws-us-east-1")).toMatchObject({ type: "aws.region", settings: { region: "us-east-1" } })
    expect(node(doc, "aws-ap-southeast-2")).toMatchObject({ type: "aws.region", settings: { region: "ap-southeast-2" } })
  })

  it("wires every table to every other on the replicas port", () => {
    const tables = ["sessions-table", "sessions-table-us-east-1", "sessions-table-ap-southeast-2"]
    for (const from of tables) for (const to of tables) if (from !== to) expect(edge(doc, from, "replicas", to)).toBeDefined()
    expect(Object.values(doc.edges).filter((e) => Design.portOf(e) === "replicas")).toHaveLength(6)
  })

  it("gives each replica the read capacity the template names for its region, and the write capacity its autoscaling can reach", () => {
    expect(settings(doc, "sessions-table")).toEqual({ mode: "provisioned", readCapacity: 600, writeCapacity: 400, stream: { view: "new-and-old" } })
    expect(settings(doc, "sessions-table-us-east-1")).toMatchObject({ readCapacity: 300, writeCapacity: 400 })
    expect(settings(doc, "sessions-table-ap-southeast-2")).toMatchObject({ readCapacity: 150, writeCapacity: 400 })
    expect(warned(report, "SessionsTable: autoscaling isn't simulated")).toBe(true)
  })

  it("reads the stream of the table in the stack's region, and writes to it from outside", () => {
    expect(edge(doc, "sessions-table", "stream", "session-reaper")).toBeDefined()
    expect(node(doc, "writers-to-sessions-table")).toBeDefined()
    expect(Object.keys(doc.nodes).filter((id) => id.startsWith("writers-to-"))).toHaveLength(1)
  })

  it("says which replica it couldn't place", () => {
    expect(warned(report, "mars-1, which isn't an AWS region the simulator knows")).toBe(true)
    expect(report.converted.filter((c) => c.id === "SessionsTable").map((c) => c.node)).toEqual(["sessions-table", "sessions-table-us-east-1", "sessions-table-ap-southeast-2"])
  })

  it("keeps the table at home even when the template doesn't list the stack's own region", () => {
    const { doc: elsewhere, report: r } = run(fixture("global-table.yaml"), { region: "eu-central-1" })
    expect(node(elsewhere, "sessions-table").parent).toBe("aws-eu-west-1")
    expect(warned(r, "the stack's region (eu-central-1) isn't one of the table's replicas")).toBe(true)
  })
})

describe("SQS", () => {
  it("maps content-based deduplication on a FIFO queue only", () => {
    const { doc } = resources("  F:\n    Type: AWS::SQS::Queue\n    Properties: {FifoQueue: true, ContentBasedDeduplication: true}\n  S:\n    Type: AWS::SQS::Queue\n    Properties: {ContentBasedDeduplication: true}\n")
    expect(settings(doc, "f")).toEqual({ kind: "fifo", deduplication: true })
    expect(settings(doc, "s")).toEqual({})
  })

  it("brings the poller counts a template gives into the ranges the component accepts", () => {
    const { doc, report } = resources(`  Q:
    Type: AWS::SQS::Queue
  F:
    Type: AWS::Lambda::Function
    Properties: {Runtime: x}
  M:
    Type: AWS::Lambda::EventSourceMapping
    Properties: {EventSourceArn: !GetAtt Q.Arn, FunctionName: !Ref F, ProvisionedPollerConfig: {MinimumPollers: 500, MaximumPollers: 1000}}
`)
    expect(edgeSettings(doc, "q", "deliver", "f")).toEqual({ provisionedMinPollers: 200, provisionedMaxPollers: 1000 })
    expect(report.settings.adjusted).toEqual([expect.stringContaining("provisionedMinPollers 500")])
  })

  it("maps ReportBatchItemFailures onto the mapping and the function, and reports filter criteria as not simulated", () => {
    const { doc, report } = resources(`  Q:
    Type: AWS::SQS::Queue
  F:
    Type: AWS::Lambda::Function
    Properties: {Runtime: x}
  M:
    Type: AWS::Lambda::EventSourceMapping
    Properties:
      EventSourceArn: !GetAtt Q.Arn
      FunctionName: !Ref F
      FunctionResponseTypes: [ReportBatchItemFailures]
      FilterCriteria: {Filters: [{Pattern: "{}"}]}
`)
    expect(edgeSettings(doc, "q", "deliver", "f")).toMatchObject({ reportBatchItemFailures: true })
    expect(settings(doc, "f")).toMatchObject({ batch: { errors: "report" } })
    expect(report.warnings.filter((w) => w.includes("ReportBatchItemFailures"))).toHaveLength(0)
    expect(warned(report, "F: FilterCriteria")).toBe(true)
  })

  it("still reports ReportBatchItemFailures as not simulated on a DynamoDB stream", () => {
    const { report } = resources(`  T:
    Type: AWS::DynamoDB::Table
    Properties: {StreamSpecification: {StreamViewType: NEW_IMAGE}}
  F:
    Type: AWS::Lambda::Function
    Properties: {Runtime: x}
  M:
    Type: AWS::Lambda::EventSourceMapping
    Properties:
      EventSourceArn: !GetAtt T.StreamArn
      FunctionName: !Ref F
      StartingPosition: LATEST
      FunctionResponseTypes: [ReportBatchItemFailures]
`)
    expect(report.warnings.filter((w) => w.includes("ReportBatchItemFailures"))).toHaveLength(1)
  })
})

describe("SNS", () => {
  const sns = (subscription: string, extra = "") =>
    resources(`  T:
    Type: AWS::SNS::Topic
${extra}  Q:
    Type: AWS::SQS::Queue
  F:
    Type: AWS::Lambda::Function
    Properties: {Runtime: x}
  S:
    Type: AWS::SNS::Subscription
    Properties:
      TopicArn: !Ref T
${subscription}`)

  it("rounds a maximum message size in bytes up to kilobytes", () => {
    expect(settings(resources("  T:\n    Type: AWS::SNS::Topic\n    Properties: {MaximumMessageSize: 1500}\n").doc, "t")).toEqual({ maxMessageSize: 2 })
  })

  it("leaves a standard topic's FIFO-only properties alone", () => {
    expect(settings(resources("  T:\n    Type: AWS::SNS::Topic\n    Properties: {FifoThroughputScope: MessageGroup, ContentBasedDeduplication: true}\n").doc, "t")).toEqual({})
  })

  it("says raw delivery is off unless the template turns it on (AWS's default), and that a function always gets the envelope", () => {
    expect(edgeSettings(sns("      Protocol: sqs\n      Endpoint: !GetAtt Q.Arn\n").doc, "t", "out", "q")).toEqual({ rawMessageDelivery: false })
    expect(edgeSettings(sns("      Protocol: sqs\n      Endpoint: !GetAtt Q.Arn\n      RawMessageDelivery: true\n").doc, "t", "out", "q")).toEqual({ rawMessageDelivery: true })
    expect(edgeSettings(sns("      Protocol: lambda\n      Endpoint: !GetAtt F.Arn\n").doc, "t", "out", "f")).toEqual({ rawMessageDelivery: false })
  })

  it("gives an HTTP subscription AWS's default delivery policy (3 retries, 20 s apart) when the template has none", () => {
    const { doc } = sns("      Protocol: https\n      Endpoint: https://hooks.example.com/x\n")
    expect(edgeSettings(doc, "t", "out", "hooks-example-com")).toEqual({ rawMessageDelivery: false, retry: { maxAttempts: 4, backoff: "20 seconds", maxBackoff: "20 seconds", backoffFactor: 1 } })
  })

  it("takes retries from a healthy retry policy, clamping to the component's ranges and reporting it", () => {
    const { doc, report } = sns(`      Protocol: https
      Endpoint: https://hooks.example.com/x
      DeliveryPolicy: {healthyRetryPolicy: {numRetries: 500, minDelayTarget: 5, maxDelayTarget: 900, backoffFunction: linear}}
`)
    expect(edgeSettings(doc, "t", "out", "hooks-example-com")).toEqual({ rawMessageDelivery: false, retry: { maxAttempts: 100, backoff: "5 seconds", maxBackoff: "600000 millis" } })
    expect(report.settings.adjusted).toEqual(expect.arrayContaining([expect.stringContaining("retry.maxAttempts 501"), expect.stringContaining("retry.maxBackoff 900 seconds")]))
    expect(warned(report, 'backoffFunction "linear" isn\'t simulated')).toBe(true)
  })

  it("ignores a delivery policy on a subscription it doesn't apply to, and says so", () => {
    const { doc, report } = sns("      Protocol: sqs\n      Endpoint: !GetAtt Q.Arn\n      DeliveryPolicy: {healthyRetryPolicy: {numRetries: 3}}\n")
    expect(edgeSettings(doc, "t", "out", "q")).toEqual({ rawMessageDelivery: false })
    expect(warned(report, "a DeliveryPolicy only applies to HTTP/S endpoints")).toBe(true)
  })

  it("has one dead-letter port for the topic: a second queue is reported, and its subscription doesn't claim a redrive", () => {
    const { doc, report } = resources(`  T:
    Type: AWS::SNS::Topic
  Q1:
    Type: AWS::SQS::Queue
  Q2:
    Type: AWS::SQS::Queue
  D1:
    Type: AWS::SQS::Queue
  D2:
    Type: AWS::SQS::Queue
  S1:
    Type: AWS::SNS::Subscription
    Properties: {TopicArn: !Ref T, Protocol: sqs, Endpoint: !GetAtt Q1.Arn, RedrivePolicy: {deadLetterTargetArn: !GetAtt D1.Arn}}
  S2:
    Type: AWS::SNS::Subscription
    Properties: {TopicArn: !Ref T, Protocol: sqs, Endpoint: !GetAtt Q2.Arn, RedrivePolicy: {deadLetterTargetArn: !GetAtt D2.Arn}}
`)
    expect(edge(doc, "t", "dlq", "d1")).toBeDefined()
    expect(edge(doc, "t", "dlq", "d2")).toBeUndefined()
    expect(edgeSettings(doc, "t", "out", "q1")).toMatchObject({ deadLetterQueue: true })
    expect(edgeSettings(doc, "t", "out", "q2")).toEqual({ rawMessageDelivery: false })
    expect(warned(report, "one dead-letter port")).toBe(true)
  })

  it("takes the SAM SNS event's filter policy as unsimulated too, and inline subscriptions as subscriptions", () => {
    const { doc, report } = run(`Transform: AWS::Serverless-2016-10-31
Resources:
  T:
    Type: AWS::SNS::Topic
    Properties:
      Subscription: [{Protocol: sqs, Endpoint: !GetAtt Q.Arn}]
  Q:
    Type: AWS::SQS::Queue
  F:
    Type: AWS::Serverless::Function
    Properties:
      Runtime: x
      Handler: h
      Events:
        Topic: {Type: SNS, Properties: {Topic: !Ref T, FilterPolicy: {a: [b]}}}
`)
    expect(edge(doc, "t", "out", "q")).toBeDefined()
    expect(edgeSettings(doc, "t", "out", "f")).toEqual({ rawMessageDelivery: false })
    expect(warned(report, "T → F: the FilterPolicy isn't simulated")).toBe(true)
  })
})

describe("Lambda", () => {
  const withInvoke = (config: string) =>
    resources(`  F:
    Type: AWS::Lambda::Function
    Properties: {Runtime: x}
  Q:
    Type: AWS::SQS::Queue
  T:
    Type: AWS::SNS::Topic
  Next:
    Type: AWS::Lambda::Function
    Properties: {Runtime: x}
  C:
    Type: AWS::Lambda::EventInvokeConfig
    Properties:
      FunctionName: !Ref F
      Qualifier: $LATEST
${config}`)

  it("draws success and failure destinations from the function's onSuccess and onFailure ports", () => {
    const { doc } = withInvoke("      DestinationConfig:\n        OnSuccess: {Destination: !GetAtt Q.Arn}\n        OnFailure: {Destination: !Ref T}\n")
    expect(edge(doc, "f", "onSuccess", "q")).toBeDefined()
    expect(edge(doc, "f", "onFailure", "t")).toBeDefined()
  })

  it("lets a function be the destination of a success", () => {
    expect(edge(withInvoke("      DestinationConfig: {OnSuccess: {Destination: !GetAtt Next.Arn}}\n").doc, "f", "onSuccess", "next")).toBeDefined()
  })

  it("reports a destination that isn't in the template, such as an EventBridge bus", () => {
    const { doc, report } = withInvoke("      DestinationConfig: {OnSuccess: {Destination: 'arn:aws:events:eu-west-1:123456789012:event-bus/default'}}\n")
    expect(edge(doc, "f", "onSuccess", "q")).toBeUndefined()
    expect(warned(report, "F: its on success destination goes to arn:aws:events")).toBe(true)
  })

  it("reads the SAM inline form, and says when SAM creates the destination itself", () => {
    const { doc, report } = run(`Transform: AWS::Serverless-2016-10-31
Resources:
  Q:
    Type: AWS::SQS::Queue
  F:
    Type: AWS::Serverless::Function
    Properties:
      Runtime: x
      Handler: h
      EventInvokeConfig:
        MaximumEventAgeInSeconds: 600
        DestinationConfig:
          OnSuccess: {Type: SQS, Destination: !GetAtt Q.Arn}
          OnFailure: {Type: SNS}
`)
    expect(edge(doc, "f", "onSuccess", "q")).toBeDefined()
    expect(settings(doc, "f")).toEqual({ async: { maxEventAge: "600 seconds" } })
    expect(warned(report, "OnFailure is a SNS that SAM creates for you")).toBe(true)
  })

  it("enables SnapStart only for published versions", () => {
    expect(settings(resources("  F:\n    Type: AWS::Lambda::Function\n    Properties: {Runtime: java21, SnapStart: {ApplyOn: PublishedVersions}}\n").doc, "f")).toEqual({ coldStart: { snapStart: true } })
    expect(settings(resources("  F:\n    Type: AWS::Lambda::Function\n    Properties: {Runtime: java21, SnapStart: {ApplyOn: None}}\n").doc, "f")).toEqual({})
  })

  it("gives a function the provisioned concurrency of its version or alias, and lets an alias stand for the function", () => {
    const { doc, report } = resources(`  F:
    Type: AWS::Lambda::Function
    Properties: {Runtime: x}
  V:
    Type: AWS::Lambda::Version
    Properties: {FunctionName: !Ref F, ProvisionedConcurrencyConfig: {ProvisionedConcurrentExecutions: 7}}
  A:
    Type: AWS::Lambda::Alias
    Properties: {FunctionName: !Ref F, FunctionVersion: !GetAtt V.Version, Name: live, ProvisionedConcurrencyConfig: {ProvisionedConcurrentExecutions: 12}}
  Q:
    Type: AWS::SQS::Queue
  M:
    Type: AWS::Lambda::EventSourceMapping
    Properties: {EventSourceArn: !GetAtt Q.Arn, FunctionName: !Ref A}
`)
    // Whichever is read last wins, and both are in the report.
    expect(settings(doc, "f")).toEqual({ provisioned: 12 })
    expect(edge(doc, "q", "deliver", "f")).toBeDefined()
    expect(report.converted.map((c) => c.id)).toEqual(expect.arrayContaining(["V", "A"]))
  })

  it("lets something that comes before an alias in the template trigger it", () => {
    const { doc } = resources(`  M:
    Type: AWS::Lambda::EventSourceMapping
    Properties: {EventSourceArn: !GetAtt Q.Arn, FunctionName: !Ref A}
  A:
    Type: AWS::Lambda::Alias
    Properties: {FunctionName: !Ref F, FunctionVersion: "1", Name: live}
  F:
    Type: AWS::Lambda::Function
    Properties: {Runtime: x}
  Q:
    Type: AWS::SQS::Queue
`)
    expect(edge(doc, "q", "deliver", "f")).toBeDefined()
  })

  it("makes a function URL an entry point, a client calling the function", () => {
    const { doc } = resources(`  F:
    Type: AWS::Lambda::Function
    Properties: {Runtime: x}
  U:
    Type: AWS::Lambda::Url
    Properties: {TargetFunctionArn: !GetAtt F.Arn, AuthType: NONE}
`)
    expect(edge(doc, "function-url-for-f", "out", "f")).toBeDefined()
  })

  it("puts a function in the VPC that owns its subnets, and reports one it can't place", () => {
    const { doc, report } = resources(`  V:
    Type: AWS::EC2::VPC
    Properties: {CidrBlock: 10.0.0.0/16}
  S:
    Type: AWS::EC2::Subnet
    Properties: {VpcId: !Ref V, CidrBlock: 10.0.0.0/24, AvailabilityZone: eu-west-1a}
  F:
    Type: AWS::Lambda::Function
    Properties: {Runtime: x, VpcConfig: {SubnetIds: [!Ref S], SecurityGroupIds: []}}
  Out:
    Type: AWS::Lambda::Function
    Properties: {Runtime: x, VpcConfig: {SubnetIds: ["subnet-0abc"], SecurityGroupIds: []}}
`)
    expect(node(doc, "f").parent).toBe("v")
    expect(node(doc, "out").parent).toBe("aws-eu-west-1")
    expect(warned(report, "Out is attached to a VPC (VpcConfig), but its subnets aren't in this template")).toBe(true)
  })
})

describe("the web delivery template", () => {
  const { doc, report } = run(fixture("web-delivery.yaml"), { fileName: "web-delivery.yaml" })

  it("maps versioning, Replication Time Control and directory buckets, and says nothing about lifecycle or encryption", () => {
    expect(settings(doc, "assets-bucket")).toEqual({ versioning: true, replicationTimeControl: true })
    expect(settings(doc, "archive-bucket")).toEqual({ versioning: true })
    expect(settings(doc, "hot-bucket")).toEqual({ bucketType: "directory" })
    expect(report.warnings.some((w) => /Lifecycle|Encryption/i.test(w))).toBe(false)
    expect(skippedOf(report, "AssetsBucket")).toBeUndefined()
  })

  it("draws replication to the destination bucket on the replication port", () => {
    expect(edgeSettings(doc, "assets-bucket", "replication", "archive-bucket")).toEqual({})
  })

  it("maps notification event types and a key filter, which it can only assume a share for, and reports it", () => {
    expect(edgeSettings(doc, "assets-bucket", "events", "thumbnail-function")).toEqual({ eventTypes: "created", filter: 0.25 })
    expect(edgeSettings(doc, "assets-bucket", "events", "removals-topic")).toEqual({ eventTypes: "removed" })
    expect(report.settings.unresolved).toEqual([expect.stringMatching(/AssetsBucket → ThumbnailFunction: key filter on prefix "images\/" and suffix "\.png".*assumed to let 25% of objects through/)])
  })

  it("reports an event type the simulator doesn't produce instead of delivering everything", () => {
    expect(warned(report, "s3:ObjectRestore:Completed isn't an event the simulator produces")).toBe(true)
  })

  it("maps a REST API's endpoint type, its cache, throttle and usage plan", () => {
    expect(settings(doc, "items-api")).toEqual({
      apiType: "rest",
      endpoint: "regional",
      integrationTimeout: "10000 millis",
      stageThrottle: { rate: 200, burst: 400 },
      // `HttpMethod: "*"` caches every method; a cache cluster of 1.6 GB, 60 seconds.
      cache: { enabled: true, size: "1.6", ttl: "60 seconds", scope: "all" },
      usagePlan: { enabled: true, rate: 50, burst: 100, quota: 100000, period: "week", clients: 2 },
      // The preflight OPTIONS method isn't a route.
      routes: 2,
      authorizer: { type: "lambda", ttl: "120 seconds" }
    })
  })

  it("wires a Lambda authorizer's function to the gateway's authorizer port, and the integrations to out", () => {
    expect(edge(doc, "items-api", "authorizer", "authorizer-function")).toBeDefined()
    expect(edge(doc, "items-api", "out", "items-function")).toBeDefined()
    expect(report.converted.map((c) => c.id)).toEqual(expect.arrayContaining(["TokenAuthorizer", "ItemsPlan", "ItemsStage", "GetItems"]))
  })

  it("answers at the gateway for an API whose every method is a MOCK, authorized with IAM, on an edge-optimized endpoint", () => {
    expect(settings(doc, "status-api")).toEqual({ apiType: "rest", endpoint: "edge", integrationType: "mock", authorizer: { type: "iam" } })
    // It still has callers.
    expect(edge(doc, "callers-of-status-api", "out", "status-api")).toBeDefined()
  })

  it("maps a distribution's cache policy, compression, methods, price class, edge functions and error caching", () => {
    expect(settings(doc, "site")).toEqual({
      cache: { defaultTtl: "86400 seconds", minTtl: "1 seconds", maxTtl: "31536000 seconds", errorMinTtl: "30 seconds" },
      compression: { enabled: true },
      allowedMethods: "read",
      functions: { viewerRequest: "lambda", viewerResponse: "function" },
      edge: { priceClass: "100" },
      failover: { clientErrors: true, status500: true, status502: false, status503: true, status504: false }
    })
  })

  it("draws an edge per origin to what its domain names, as reads, with the origin's settings", () => {
    expect(edgeSettings(doc, "site", "out", "assets-bucket")).toEqual({ originType: "s3", request: { operation: "read" }, responseCompletionTimeout: "90 seconds" })
    expect(edgeSettings(doc, "site", "out", "items-api")).toEqual({
      originType: "custom",
      request: { operation: "read" },
      shield: true,
      connectionAttempts: 2,
      responseTimeout: "40 seconds"
    })
    // A host that isn't in the template is an external service.
    expect(node(doc, "blog-example-com")).toMatchObject({ type: "common.http-endpoint" })
    expect(edgeSettings(doc, "site", "out", "blog-example-com")).toEqual({ originType: "custom", request: { operation: "read" } })
  })

  it("makes the second member of an origin group the secondary", () => {
    expect(edgeSettings(doc, "site", "out", "archive-bucket")).toEqual({ originType: "s3", request: { operation: "read" }, role: "secondary" })
  })

  it("feeds a distribution from viewers that read, because writes pass straight through a cache", () => {
    expect(edgeSettings(doc, "viewers-of-site", "out", "site")).toEqual({ request: { operation: "read" } })
    expect(edgeSettings(doc, "viewers-of-downloads", "out", "downloads")).toEqual({ request: { operation: "read" } })
  })

  it("reports cache behaviors it can't represent, and the Lambda@Edge function it doesn't wire", () => {
    expect(warned(report, "Site has 2 more cache behaviors (/api/*, /blog/*)")).toBe(true)
    expect(warned(report, "EdgeFunction runs at the edge for Site (viewer-request)")).toBe(true)
    expect(edge(doc, "edge-function", "out", "site")).toBeUndefined()
    // Not reported as idle: it is run by CloudFront.
    expect(report.warnings.some((w) => w.startsWith("EdgeFunction isn't triggered"))).toBe(false)
    expect(report.converted.map((c) => c.id)).toEqual(expect.arrayContaining(["RewriteFunction"]))
  })

  it("reads a cache policy of the template's own, an S3 domain naming no bucket of the template, and legacy TTLs", () => {
    expect(settings(doc, "downloads")).toEqual({
      cache: { defaultTtl: "3600 seconds", minTtl: "60 seconds", maxTtl: "86400 seconds" },
      // CloudFront's own defaults are no compression and GET/HEAD only; the component's are the opposite, so they are said.
      compression: { enabled: false },
      allowedMethods: "all"
    })
    expect(edgeSettings(doc, "downloads", "out", "downloads-example-bucket-s3-eu-west-1-amazonaws-com")).toEqual({ originType: "s3", request: { operation: "read" } })
    expect(report.converted.map((c) => c.id)).toEqual(expect.arrayContaining(["DownloadsCachePolicy"]))
  })

  it("leaves out a disabled distribution, quietly", () => {
    expect(skippedOf(report, "DisabledSite")).toMatchObject({ quiet: true, reason: expect.stringContaining("disabled") })
    expect(doc.nodes["disabled-site"]).toBeUndefined()
  })
})

describe("S3", () => {
  const bucketWith = (notification: string, extra = "") =>
    resources(`  B:
    Type: AWS::S3::Bucket
    Properties:
      NotificationConfiguration:
${notification}${extra}  F:
    Type: AWS::Lambda::Function
    Properties: {Runtime: x}
`)

  it("widens one edge to every event type when separate entries cover creation and removal", () => {
    const { doc } = bucketWith("        LambdaConfigurations:\n          - {Event: 's3:ObjectCreated:Put', Function: !GetAtt F.Arn}\n          - {Event: 's3:ObjectRemoved:Delete', Function: !GetAtt F.Arn}\n")
    expect(Object.values(doc.edges).filter((e) => e.from.node === "b" && e.to === "f")).toHaveLength(1)
    expect(edgeSettings(doc, "b", "events", "f")).toEqual({ eventTypes: "all" })
  })

  it("adds up alternative key filters for one event type", () => {
    const { doc } = bucketWith(`        LambdaConfigurations:
          - {Event: 's3:ObjectCreated:*', Function: !GetAtt F.Arn, Filter: {S3Key: {Rules: [{Name: prefix, Value: a/}]}}}
          - {Event: 's3:ObjectCreated:*', Function: !GetAtt F.Arn, Filter: {S3Key: {Rules: [{Name: prefix, Value: b/}]}}}
`)
    expect(edgeSettings(doc, "b", "events", "f")).toEqual({ eventTypes: "created" })
  })

  it("drops a notification that is only for events the simulator doesn't produce, and says so", () => {
    const { doc, report } = bucketWith("        LambdaConfigurations:\n          - {Event: 's3:ObjectRestore:Post', Function: !GetAtt F.Arn}\n")
    expect(edge(doc, "b", "events", "f")).toBeUndefined()
    expect(warned(report, "the notification isn't connected")).toBe(true)
  })

  it("reports an EventBridge notification, which has no component", () => {
    const { report } = bucketWith("        EventBridgeConfiguration: {EventBridgeEnabled: true}\n")
    expect(warned(report, "B sends its events to EventBridge")).toBe(true)
  })

  it("reads the notifications CDK writes as a custom resource", () => {
    const { doc, report } = resources(`  B:
    Type: AWS::S3::Bucket
  F:
    Type: AWS::Lambda::Function
    Properties: {Runtime: x}
  Q:
    Type: AWS::SQS::Queue
  Notifications:
    Type: Custom::S3BucketNotifications
    Properties:
      ServiceToken: arn:aws:lambda:eu-west-1:123456789012:function:notifier
      BucketName: !Ref B
      NotificationConfiguration:
        LambdaFunctionConfigurations:
          - {Events: ['s3:ObjectCreated:*'], LambdaFunctionArn: !GetAtt F.Arn, Filter: {Key: {FilterRules: [{Name: suffix, Value: .jpg}]}}}
        QueueConfigurations:
          - {Events: ['s3:ObjectRemoved:*'], QueueArn: !GetAtt Q.Arn}
`)
    expect(edgeSettings(doc, "b", "events", "f")).toEqual({ eventTypes: "created", filter: 0.5 })
    expect(edgeSettings(doc, "b", "events", "q")).toEqual({ eventTypes: "removed" })
    expect(report.converted.map((c) => c.id)).toContain("Notifications")
  })

  it("takes the SAM S3 event's event list and filter", () => {
    const { doc } = run(`Transform: AWS::Serverless-2016-10-31
Resources:
  B:
    Type: AWS::S3::Bucket
  F:
    Type: AWS::Serverless::Function
    Properties:
      Runtime: x
      Handler: h
      Events:
        Up:
          Type: S3
          Properties:
            Bucket: !Ref B
            Events: [s3:ObjectCreated:*, s3:ObjectRemoved:*]
            Filter: {S3Key: {Rules: [{Name: prefix, Value: in/}]}}
`)
    expect(edgeSettings(doc, "b", "events", "f")).toEqual({ eventTypes: "all", filter: 0.5 })
  })

  it("replicates to a bucket named by ARN, with a filter assumed, and reports a destination outside the template", () => {
    const { doc, report } = resources(`  Src:
    Type: AWS::S3::Bucket
    Properties:
      ReplicationConfiguration:
        Role: arn:aws:iam::123456789012:role/r
        Rules:
          - {Status: Enabled, Filter: {Prefix: logs/}, Destination: {Bucket: "arn:aws:s3:::the-copy"}}
          - {Status: Enabled, Destination: {Bucket: "arn:aws:s3:::somewhere-else"}}
          - {Status: Disabled, Destination: {Bucket: "arn:aws:s3:::the-copy"}}
  Copy:
    Type: AWS::S3::Bucket
    Properties: {BucketName: the-copy}
`)
    expect(edgeSettings(doc, "src", "replication", "copy")).toEqual({ filter: 0.5 })
    expect(settings(doc, "src")).toEqual({})
    expect(warned(report, "replicates to a bucket that isn't in this template (arn:aws:s3:::somewhere-else)")).toBe(true)
    expect(report.settings.unresolved).toEqual([expect.stringContaining("replication filter")])
  })
})

describe("API Gateway", () => {
  it("maps an HTTP API's JWT authorizer, its routes, and says how many are authorized", () => {
    const { doc, report } = resources(`  Api:
    Type: AWS::ApiGatewayV2::Api
    Properties: {Name: a, ProtocolType: HTTP}
  Auth:
    Type: AWS::ApiGatewayV2::Authorizer
    Properties: {ApiId: !Ref Api, AuthorizerType: JWT, IdentitySource: ["$request.header.Authorization"], JwtConfiguration: {Audience: [x], Issuer: "https://issuer.example.com"}}
  R1:
    Type: AWS::ApiGatewayV2::Route
    Properties: {ApiId: !Ref Api, RouteKey: "GET /a", AuthorizationType: JWT, AuthorizerId: !Ref Auth, Target: !Sub "integrations/\${I}"}
  R2:
    Type: AWS::ApiGatewayV2::Route
    Properties: {ApiId: !Ref Api, RouteKey: "GET /b", AuthorizationType: NONE, Target: !Sub "integrations/\${I}"}
  R3:
    Type: AWS::ApiGatewayV2::Route
    Properties: {ApiId: !Ref Api, RouteKey: "GET /c", AuthorizationType: NONE, Target: !Sub "integrations/\${I}"}
  I:
    Type: AWS::ApiGatewayV2::Integration
    Properties: {ApiId: !Ref Api, IntegrationType: AWS_PROXY, IntegrationUri: !GetAtt F.Arn, TimeoutInMillis: 5000}
  F:
    Type: AWS::Lambda::Function
    Properties: {Runtime: x}
`)
    expect(settings(doc, "api")).toEqual({ apiType: "http", integrationTimeout: "5000 millis", routes: 3, authorizer: { type: "jwt" } })
    expect(warned(report, "Api: 1 of 3 routes are authorized, but the component applies its authorizer to every call")).toBe(true)
  })

  it("maps a Lambda REQUEST authorizer on an HTTP API, with its cache time, to the authorizer port", () => {
    const { doc } = resources(`  Api:
    Type: AWS::ApiGatewayV2::Api
    Properties: {Name: a, ProtocolType: HTTP}
  Auth:
    Type: AWS::ApiGatewayV2::Authorizer
    Properties: {ApiId: !Ref Api, AuthorizerType: REQUEST, AuthorizerUri: !Sub "arn:aws:apigateway:eu-west-1:lambda:path/2015-03-31/functions/\${F.Arn}/invocations", AuthorizerResultTtlInSeconds: 30}
  F:
    Type: AWS::Lambda::Function
    Properties: {Runtime: x}
`)
    expect(settings(doc, "api")).toEqual({ apiType: "http", authorizer: { type: "lambda", ttl: "30 seconds" } })
    expect(edge(doc, "api", "authorizer", "f")).toBeDefined()
  })

  it("maps IAM authorization on a method, and Cognito on another API", () => {
    const { doc } = resources(`  Iam:
    Type: AWS::ApiGateway::RestApi
  IamMethod:
    Type: AWS::ApiGateway::Method
    Properties: {RestApiId: !Ref Iam, HttpMethod: GET, AuthorizationType: AWS_IAM, Integration: {Type: HTTP_PROXY, Uri: "https://backend.example.com/x"}}
  Pool:
    Type: AWS::ApiGateway::RestApi
  PoolAuth:
    Type: AWS::ApiGateway::Authorizer
    Properties: {RestApiId: !Ref Pool, Type: COGNITO_USER_POOLS, ProviderARNs: ["arn:aws:cognito-idp:eu-west-1:123456789012:userpool/x"]}
`)
    expect(settings(doc, "iam")).toEqual({ apiType: "rest", authorizer: { type: "iam" } })
    expect(settings(doc, "pool")).toEqual({ apiType: "rest", authorizer: { type: "cognito" } })
  })

  it("warns when an API mixes an authorizer with IAM, or names an authorizer the template doesn't have", () => {
    const { report } = resources(`  A:
    Type: AWS::ApiGateway::RestApi
  Auth:
    Type: AWS::ApiGateway::Authorizer
    Properties: {RestApiId: !Ref A, Type: COGNITO_USER_POOLS}
  M1:
    Type: AWS::ApiGateway::Method
    Properties: {RestApiId: !Ref A, HttpMethod: GET, AuthorizationType: AWS_IAM, Integration: {Type: MOCK}}
  B:
    Type: AWS::ApiGateway::RestApi
  M2:
    Type: AWS::ApiGateway::Method
    Properties: {RestApiId: !Ref B, HttpMethod: GET, AuthorizationType: CUSTOM, AuthorizerId: abc123, Integration: {Type: MOCK}}
`)
    expect(warned(report, "A uses both an authorizer and IAM authorization")).toBe(true)
    expect(warned(report, "B: a method names an authorizer that isn't in this template")).toBe(true)
  })

  it("answers at the gateway only when every integration is a MOCK, and says when some aren't", () => {
    const { doc, report } = resources(`  A:
    Type: AWS::ApiGateway::RestApi
  M1:
    Type: AWS::ApiGateway::Method
    Properties: {RestApiId: !Ref A, HttpMethod: GET, Integration: {Type: MOCK}}
  M2:
    Type: AWS::ApiGateway::Method
    Properties: {RestApiId: !Ref A, HttpMethod: POST, Integration: {Type: HTTP_PROXY, Uri: "https://x.example.com/"}}
`)
    expect((settings(doc, "a") as Record<string, unknown>).integrationType).toBeUndefined()
    expect(warned(report, "A: 1 of 2 routes are MOCK integrations")).toBe(true)
  })

  it("caches only GETs unless the method setting is *, and says when a method caches without a cache cluster", () => {
    const { doc, report } = resources(`  A:
    Type: AWS::ApiGateway::RestApi
  S:
    Type: AWS::ApiGateway::Stage
    Properties:
      RestApiId: !Ref A
      StageName: p
      CacheClusterEnabled: true
      CacheClusterSize: 6.1
      MethodSettings: [{HttpMethod: GET, ResourcePath: /items, CachingEnabled: true, CacheTtlInSeconds: 20}]
  B:
    Type: AWS::ApiGateway::RestApi
  S2:
    Type: AWS::ApiGateway::Stage
    Properties:
      RestApiId: !Ref B
      StageName: p
      MethodSettings: [{HttpMethod: "*", ResourcePath: "/*", CachingEnabled: true, CacheTtlInSeconds: 20}]
`)
    expect(settings(doc, "a")).toEqual({ apiType: "rest", cache: { enabled: true, size: "6.1", ttl: "20 seconds" } })
    expect(warned(report, "B: methods have CachingEnabled but the stage has no cache cluster")).toBe(true)
  })

  it("reads the endpoint type SAM writes as a word or as an object, and refuses one it doesn't know", () => {
    const sam = (config: string) => run(`Transform: AWS::Serverless-2016-10-31\nResources:\n  A:\n    Type: AWS::Serverless::Api\n    Properties: {StageName: p, EndpointConfiguration: ${config}}\n`)
    expect(settings(sam("PRIVATE").doc, "a")).toEqual({ apiType: "rest", endpoint: "private" })
    expect(settings(sam("{Type: EDGE}").doc, "a")).toEqual({ apiType: "rest", endpoint: "edge" })
    expect(warned(sam("{Type: WAT}").report, "the endpoint type WAT isn't one the simulator knows")).toBe(true)
  })

  it("counts SAM events as routes, and uses SAM's default authorizer and usage plan", () => {
    const { doc, report } = run(`Transform: AWS::Serverless-2016-10-31
Resources:
  Api:
    Type: AWS::Serverless::Api
    Properties:
      StageName: p
      Auth:
        DefaultAuthorizer: Checker
        Authorizers:
          Checker: {FunctionArn: !GetAtt Guard.Arn, Identity: {ReauthorizeEvery: 45}}
        UsagePlan: {CreateUsagePlan: PER_API, Quota: {Limit: 500, Period: MONTH}}
  Guard:
    Type: AWS::Serverless::Function
    Properties: {Runtime: x, Handler: g}
  Fn:
    Type: AWS::Serverless::Function
    Properties:
      Runtime: x
      Handler: h
      Events:
        A: {Type: Api, Properties: {Path: /a, Method: get, RestApiId: !Ref Api}}
        B: {Type: Api, Properties: {Path: /b, Method: get, RestApiId: !Ref Api}}
        C: {Type: Api, Properties: {Path: /c, Method: get, RestApiId: !Ref Api, Auth: {Authorizer: NONE}}}
`)
    expect(settings(doc, "api")).toEqual({
      apiType: "rest",
      routes: 3,
      authorizer: { type: "lambda", ttl: "45 seconds" },
      // A quota with no throttle doesn't limit the rate, whereas the component's default plan does.
      usagePlan: { enabled: true, rate: 0, quota: 500, period: "month" }
    })
    expect(edge(doc, "api", "authorizer", "guard")).toBeDefined()
    expect(warned(report, "Api: 2 of 3 routes are authorized")).toBe(true)
  })

  it("counts the operations of an inline OpenAPI body as routes", () => {
    const { doc } = resources(`  A:
    Type: AWS::ApiGateway::RestApi
    Properties:
      Body:
        openapi: "3.0.1"
        paths:
          /a: {get: {}, post: {}}
          /b: {get: {}, options: {}}
`)
    expect(settings(doc, "a")).toEqual({ apiType: "rest", routes: 3 })
  })
})

describe("CloudFront", () => {
  const distribution = (config: string, more = "") =>
    resources(`  B:
    Type: AWS::S3::Bucket
  D:
    Type: AWS::CloudFront::Distribution
    Properties:
      DistributionConfig:
${config}${more}`)

  it("takes legacy TTLs from the behavior, and CloudFront's defaults for compression and methods when it says nothing", () => {
    const { doc } = distribution(`        Origins: [{Id: o, DomainName: !GetAtt B.RegionalDomainName, S3OriginConfig: {}}]
        DefaultCacheBehavior: {TargetOriginId: o, ViewerProtocolPolicy: allow-all, MinTTL: 5, DefaultTTL: 600, MaxTTL: 6000}
`)
    expect(settings(doc, "d")).toEqual({ cache: { minTtl: "5 seconds", defaultTtl: "600 seconds", maxTtl: "6000 seconds" }, compression: { enabled: false }, allowedMethods: "read" })
  })

  it("brings a TTL beyond the component's range into it, and a managed cache policy that disables caching to zeros", () => {
    const { doc } = distribution(`        Origins: [{Id: o, DomainName: !GetAtt B.RegionalDomainName, S3OriginConfig: {}}]
        DefaultCacheBehavior: {TargetOriginId: o, ViewerProtocolPolicy: allow-all, CachePolicyId: 4135ea2d-6df8-44a3-9df3-4b5a84be39ad}
`)
    expect(settings(doc, "d")).toMatchObject({ cache: { defaultTtl: "0 seconds", minTtl: "0 seconds", maxTtl: "0 seconds" } })
  })

  it("reports a cache policy it can't read, rather than guessing its TTLs", () => {
    const { report } = distribution(`        Origins: [{Id: o, DomainName: !GetAtt B.RegionalDomainName, S3OriginConfig: {}}]
        DefaultCacheBehavior: {TargetOriginId: o, ViewerProtocolPolicy: allow-all, CachePolicyId: 11111111-2222-3333-4444-555555555555}
`)
    expect(warned(report, "the cache policy 11111111-2222-3333-4444-555555555555 isn't one of the template's or a known managed policy")).toBe(true)
  })

  it("names an origin it can't resolve, and leaves it unconnected", () => {
    const { doc, report } = distribution(`        Origins: [{Id: mystery, DomainName: !ImportValue elsewhere, CustomOriginConfig: {}}]
        DefaultCacheBehavior: {TargetOriginId: mystery, ViewerProtocolPolicy: allow-all}
`)
    expect(Object.values(doc.edges).filter((e) => e.from.node === "d")).toEqual([])
    expect(warned(report, "the origin mystery (exported by another stack) can't be told from the template")).toBe(true)
  })

  it("sets failover from every origin group's status codes, and the 4xx ones as client errors", () => {
    const { doc } = distribution(`        Origins:
          - {Id: a, DomainName: a.example.com, CustomOriginConfig: {}}
          - {Id: b, DomainName: b.example.com, CustomOriginConfig: {}}
        OriginGroups:
          Quantity: 1
          Items: [{Id: g, FailoverCriteria: {StatusCodes: {Quantity: 2, Items: [504, 403]}}, Members: {Quantity: 2, Items: [{OriginId: a}, {OriginId: b}]}}]
        DefaultCacheBehavior: {TargetOriginId: g, ViewerProtocolPolicy: allow-all}
`)
    expect(settings(doc, "d")).toMatchObject({ failover: { clientErrors: true, status500: false, status502: false, status503: false, status504: true } })
    expect(edgeSettings(doc, "d", "out", "b-example-com")).toMatchObject({ role: "secondary" })
    expect(edgeSettings(doc, "d", "out", "a-example-com")).not.toHaveProperty("role")
  })

  it("maps a CloudFront Function association as a function, and Lambda@Edge on an origin event as lambda", () => {
    const { doc } = distribution(`        Origins: [{Id: o, DomainName: o.example.com, CustomOriginConfig: {}}]
        DefaultCacheBehavior:
          TargetOriginId: o
          ViewerProtocolPolicy: allow-all
          FunctionAssociations: [{EventType: viewer-request, FunctionARN: "arn:aws:cloudfront::123456789012:function/x"}]
          LambdaFunctionAssociations: [{EventType: origin-response, LambdaFunctionARN: !GetAtt E.Arn}]
  E:
    Type: AWS::Lambda::Function
    Properties: {Runtime: x}
`)
    expect(settings(doc, "d")).toMatchObject({ functions: { viewerRequest: "function", originResponse: "lambda" } })
  })

  it("reports a distribution with several price classes' worth of unknowns as unresolved, not as a guess", () => {
    const { doc, report } = distribution(`        PriceClass: !ImportValue price
        Origins: [{Id: o, DomainName: o.example.com, CustomOriginConfig: {}}]
        DefaultCacheBehavior: {TargetOriginId: o, ViewerProtocolPolicy: allow-all}
`)
    expect((settings(doc, "d") as { edge?: unknown }).edge).toBeUndefined()
    expect(report.settings.unresolved).toEqual([expect.stringContaining("PriceClass")])
  })
})

describe("SES", () => {
  const { doc, report } = run(fixture("email.yaml"), { fileName: "email.yaml" })

  it("makes the configuration set the SES node, with its suppression reasons and retry window", () => {
    expect(node(doc, "transactional-set")).toMatchObject({ type: "aws.ses", origin: { source: "cloudformation", ref: "TransactionalSet", type: "AWS::SES::ConfigurationSet" } })
    expect(settings(doc, "transactional-set")).toEqual({ suppression: { enabled: true, reasons: "bounces" }, timing: { retryWindow: "600 seconds" } })
  })

  it("brings a delivery window outside AWS's 5 minutes to 14 hours into it, and says so", () => {
    const { doc: d, report: r } = resources("  S:\n    Type: AWS::SES::ConfigurationSet\n    Properties: {DeliveryOptions: {MaxDeliverySeconds: 60}}\n")
    expect(settings(d, "s")).toEqual({ timing: { retryWindow: "300000 millis" } })
    expect(r.settings.adjusted).toEqual([expect.stringContaining("MaxDeliverySeconds")])
  })

  it("turns suppression off for an empty list of reasons, and reads both and complaints", () => {
    const set = (reasons: string) => settings(resources(`  S:\n    Type: AWS::SES::ConfigurationSet\n    Properties: {SuppressionOptions: {SuppressedReasons: ${reasons}}}\n`).doc, "s")
    expect(set("[]")).toEqual({ suppression: { enabled: false } })
    expect(set("[COMPLAINT]")).toEqual({ suppression: { enabled: true, reasons: "complaints" } })
    expect(set("[BOUNCE, COMPLAINT]")).toEqual({ suppression: { enabled: true, reasons: "both" } })
  })

  it("draws an SNS event destination from the events port, carrying exactly the event types it matches", () => {
    expect(edgeSettings(doc, "transactional-set", "events", "mail-events-topic")).toEqual({
      events: { send: false, delivery: false, bounce: true, complaint: true, reject: true, deliveryDelay: true, open: true, click: true }
    })
    expect(edge(doc, "mail-events-topic", "out", "bounce-queue")).toBeDefined()
  })

  it("reports the event types with no equivalent as dropped, and the destinations with no component as skipped", () => {
    expect(warned(report, "RENDERING_FAILURE, SUBSCRIPTION have no equivalent in the simulator")).toBe(true)
    expect(skippedOf(report, "EventsToFirehose")).toMatchObject({ quiet: false, reason: expect.stringContaining("Kinesis Firehose destinations have no simulator component") })
  })

  it("draws no edge for a disabled destination", () => {
    expect(skippedOf(report, "EventsDisabled")).toMatchObject({ quiet: true, reason: expect.stringContaining("disabled") })
    expect(Object.values(doc.edges).filter((e) => e.from.node === "transactional-set")).toHaveLength(1)
  })

  it("reports identities, templates, contact lists, pools and receipt rules as skipped, with a reason", () => {
    for (const id of ["Sender", "WelcomeTemplate", "Subscribers", "DedicatedPool", "InboundRules", "InboundRule", "InboundFilter"]) {
      expect(skippedOf(report, id), id).toMatchObject({ reason: expect.stringMatching(/./) })
    }
    expect(skippedOf(report, "DedicatedPool")?.reason).toContain("dedicated IP pools")
  })

  it("connects a function that names the configuration set, or has a SAM SES policy, to the node", () => {
    expect(edge(doc, "send-function", "out", "transactional-set")).toBeDefined()
    expect(edge(doc, "send-function", "out", "transactional-set")?.origin?.source).toBe("inferred")
  })

  it("connects a function whose own role allows ses:SendEmail, and adds a traffic source for what feeds it", () => {
    expect(edge(doc, "newsletter-function", "out", "transactional-set")).toBeDefined()
    expect(edge(doc, "callers-of-send-api", "out", "send-api")).toBeDefined()
  })

  it("does not read a role several functions share as any one's use of SES", () => {
    const { doc: d, report: r } = resources(`  S:
    Type: AWS::SES::ConfigurationSet
  Role:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument: {Version: "2012-10-17", Statement: []}
      Policies: [{PolicyName: m, PolicyDocument: {Version: "2012-10-17", Statement: [{Effect: Allow, Action: ses:SendEmail, Resource: "*"}]}}]
  A:
    Type: AWS::Lambda::Function
    Properties: {Runtime: x, Role: !GetAtt Role.Arn}
  B:
    Type: AWS::Lambda::Function
    Properties: {Runtime: x, Role: !GetAtt Role.Arn}
`)
    expect(Object.values(d.edges).filter((e) => e.to === "s" && e.from.node !== "senders-through-s")).toEqual([])
    expect(warned(r, "Role is shared by 2 functions")).toBe(true)
  })

  it("adds an SES node when a function may send mail and the template has no configuration set", () => {
    const { doc: d, report: r } = resources(`  F:
    Type: AWS::Lambda::Function
    Properties:
      Runtime: x
      Role: !GetAtt R.Arn
  R:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument: {Version: "2012-10-17", Statement: []}
      Policies: [{PolicyName: m, PolicyDocument: {Version: "2012-10-17", Statement: [{Effect: Allow, Action: [ses:SendRawEmail], Resource: "*"}]}}]
`)
    expect(node(d, "amazon-ses").type).toBe("aws.ses")
    expect(node(d, "amazon-ses").settings).toBeUndefined()
    expect(edge(d, "f", "out", "amazon-ses")).toBeDefined()
    expect(r.added.some((a) => a.includes("An Amazon SES node"))).toBe(true)
  })

  it("won't guess between several configuration sets", () => {
    const { doc: d, report: r } = resources(`  S1:
    Type: AWS::SES::ConfigurationSet
  S2:
    Type: AWS::SES::ConfigurationSet
  F:
    Type: AWS::Serverless::Function
    Properties:
      Runtime: x
      Handler: h
      Policies: [{SESCrudPolicy: {IdentityName: example.com}}]
`)
    expect(Object.values(d.edges).filter((e) => e.from.node === "f")).toEqual([])
    expect(warned(r, "the template has 2 configuration sets and doesn't say which it uses")).toBe(true)
  })

  it("follows the bulk API: a node only bulk senders use is a bulk node, and a mix is reported", () => {
    const sender = (name: string, action: string) => `  ${name}:\n    Type: AWS::Lambda::Function\n    Properties:\n      Runtime: x\n      Policies: [{Statement: [{Effect: Allow, Action: [${action}], Resource: "*"}]}]\n`
    const bulk = resources(`  S:\n    Type: AWS::SES::ConfigurationSet\n${sender("A", "ses:SendBulkEmail")}`)
    expect(settings(bulk.doc, "s")).toEqual({ call: "bulk" })
    const mixed = resources(`  S:\n    Type: AWS::SES::ConfigurationSet\n${sender("A", "ses:SendBulkEmail")}${sender("B", "ses:SendEmail")}`)
    expect(settings(mixed.doc, "s")).toEqual({})
    expect(warned(mixed.report, "S is sent through both with the bulk API and without it")).toBe(true)
  })

  it("reports an idle configuration set that nothing sends through and that reports nowhere", () => {
    expect(warned(resources("  S:\n    Type: AWS::SES::ConfigurationSet\n").report, "S isn't called by anything in the template")).toBe(true)
  })
})

describe("the VPC template", () => {
  const { doc, report } = run(fixture("vpc.yaml"), { fileName: "vpc.yaml" })

  it("makes a VPC a box in the region, with its address block's prefix and a plan from its subnets", () => {
    expect(node(doc, "network")).toMatchObject({ type: "aws.vpc", parent: "aws-eu-west-1" })
    expect(settings(doc, "network")).toEqual({ cidrPrefix: 16, subnets: { enabled: true, availabilityZones: 2, subnetsPerZone: 2, prefix: 24 } })
    expect(settings(doc, "legacy")).toEqual({ cidrPrefix: 20, subnets: { enabled: true, availabilityZones: 1, subnetsPerZone: 1, prefix: 26 } })
  })

  it("does not make a subnet a node, but a part of the plan", () => {
    expect(Object.values(doc.nodes).some((n) => n.origin?.type === "AWS::EC2::Subnet")).toBe(false)
    expect(report.converted.filter((c) => c.node === "network").map((c) => c.id)).toEqual(expect.arrayContaining(["PublicA", "PublicB", "PrivateA", "PrivateB"]))
  })

  it("puts a public NAT gateway in the VPC of its subnet, in that subnet's zone, with every address it names", () => {
    expect(node(doc, "nat")).toMatchObject({ type: "aws.nat-gateway", parent: "network", settings: { zone: "b", addresses: 2 } })
  })

  it("makes a gateway endpoint and an interface endpoint, whose zones are its subnets' zones", () => {
    expect(node(doc, "s3-endpoint")).toMatchObject({ type: "aws.vpc-endpoint", parent: "network", settings: { type: "gateway" } })
    expect(node(doc, "queue-endpoint")).toMatchObject({ type: "aws.vpc-endpoint", parent: "network", settings: { type: "interface", availabilityZones: 2 } })
  })

  it("parents a function to the VPC that owns its subnets, and leaves the others in the region", () => {
    expect(node(doc, "worker").parent).toBe("network")
    expect(node(doc, "legacy-function").parent).toBe("legacy")
    expect(node(doc, "webhook").parent).toBe("aws-eu-west-1")
  })

  it("reports a private NAT gateway, a Gateway Load Balancer endpoint and a subnet of another VPC as having no component", () => {
    expect(skippedOf(report, "PrivateNat")).toMatchObject({ quiet: false })
    expect(skippedOf(report, "LoadBalancerEndpoint")).toMatchObject({ quiet: false, reason: expect.stringContaining("Gateway Load Balancer") })
    expect(skippedOf(report, "ElsewhereSubnet")).toMatchObject({ quiet: false, reason: expect.stringContaining("its VPC isn't in this template") })
  })

  it("keeps route tables, security groups, internet gateways and addresses as quiet skips, and says nothing is routed through a NAT", () => {
    for (const id of ["Gateway", "Attachment", "Routes", "NatAddress", "FunctionSecurity"]) expect(skippedOf(report, id), id).toMatchObject({ quiet: true })
    expect(warned(report, "Nat: the template's routes aren't read")).toBe(true)
  })

  it("reads the VPC before what is in it, whatever order the template is in", () => {
    const { doc: d } = resources(`  N:
    Type: AWS::EC2::NatGateway
    Properties: {SubnetId: !Ref S, AllocationId: x}
  S:
    Type: AWS::EC2::Subnet
    Properties: {VpcId: !Ref V, CidrBlock: 10.0.0.0/24, AvailabilityZone: eu-west-1c}
  V:
    Type: AWS::EC2::VPC
    Properties: {CidrBlock: 10.0.0.0/8}
`)
    expect(node(d, "n")).toMatchObject({ parent: "v", settings: { zone: "c", addresses: 1 } })
    // /8 is outside what a VPC may be (16 to 28).
    expect(settings(d, "v")).toMatchObject({ cidrPrefix: 16 })
  })

  it("approximates subnets that differ in number or size, and says so", () => {
    const { doc: d, report: r } = resources(`  V:
    Type: AWS::EC2::VPC
    Properties: {CidrBlock: 10.0.0.0/16}
  A1:
    Type: AWS::EC2::Subnet
    Properties: {VpcId: !Ref V, CidrBlock: 10.0.0.0/24, AvailabilityZone: eu-west-1a}
  A2:
    Type: AWS::EC2::Subnet
    Properties: {VpcId: !Ref V, CidrBlock: 10.0.1.0/24, AvailabilityZone: eu-west-1a}
  B1:
    Type: AWS::EC2::Subnet
    Properties: {VpcId: !Ref V, CidrBlock: 10.0.2.0/26, AvailabilityZone: eu-west-1b}
`)
    expect(settings(d, "v")).toMatchObject({ subnets: { enabled: true, availabilityZones: 2, subnetsPerZone: 2, prefix: 24 } })
    expect(warned(r, "its subnets aren't the same number in each zone")).toBe(true)
    expect(warned(r, "its subnets differ in size")).toBe(true)
  })

  it("places a VPC that holds nothing under everything else, still inside its region", () => {
    const { doc: d } = resources("  V:\n    Type: AWS::EC2::VPC\n    Properties: {CidrBlock: 10.0.0.0/16}\n  Q:\n    Type: AWS::SQS::Queue\n")
    expect(node(d, "v").position).toBeDefined()
    expect(node(d, "v").size).toBeDefined()
    expect(hasErrors(diagnose(d, registry))).toBe(false)
  })
})

describe("layout with boxes inside boxes", () => {
  type Rect = { x: number; y: number; w: number; h: number }
  const rectOf = (doc: Design.Doc, id: string): Rect => {
    const n = node(doc, id)
    const component = registry.get(n.type)!
    return component.container !== undefined
      ? { x: n.position!.x, y: n.position!.y, w: n.size!.w, h: n.size!.h }
      : { x: n.position!.x, y: n.position!.y, w: Layout.NODE_W, h: Layout.nodeHeight(Object.keys(component.ports).length) }
  }
  const inside = (a: Rect, b: Rect) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h
  const touches = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

  for (const name of ["orders-sam.yaml", "fanout-cfn.yaml", "data-pipeline.yaml", "global-table.yaml", "web-delivery.yaml", "email.yaml", "vpc.yaml"]) {
    it(`${name}: every box holds its own nodes and no others, and boxes of one level don't overlap`, () => {
      const { doc } = run(fixture(name))
      const containers = Object.keys(doc.nodes).filter((id) => registry.get(doc.nodes[id]!.type)?.container !== undefined)
      for (const [id, n] of Object.entries(doc.nodes)) {
        if (registry.get(n.type)?.container !== undefined) continue
        for (const parent of Design.ancestors(doc, id)) expect(inside(rectOf(doc, id), rectOf(doc, parent)), `${id} inside ${parent}`).toBe(true)
        for (const box of containers) {
          if (Design.ancestors(doc, id).includes(box)) continue
          expect(touches(rectOf(doc, id), rectOf(doc, box)), `${id} overlaps ${box}`).toBe(false)
        }
      }
      for (const a of containers) {
        for (const b of containers) {
          if (a >= b || doc.nodes[a]!.parent !== doc.nodes[b]!.parent) continue
          expect(touches(rectOf(doc, a), rectOf(doc, b)), `${a} overlaps ${b}`).toBe(false)
        }
      }
    })
  }

  it("keeps a VPC's members in a box of their own inside the region's, and lays the second region out below the first", () => {
    const vpc = run(fixture("vpc.yaml")).doc
    expect(inside(rectOf(vpc, "network"), rectOf(vpc, "aws-eu-west-1"))).toBe(true)
    expect(inside(rectOf(vpc, "worker"), rectOf(vpc, "network"))).toBe(true)
    const global = run(fixture("global-table.yaml")).doc
    expect(rectOf(global, "aws-us-east-1").y).toBeGreaterThan(rectOf(global, "aws-eu-west-1").y + rectOf(global, "aws-eu-west-1").h)
  })
})
