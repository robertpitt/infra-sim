import { Effect, Graph } from "effect"
import { describe, expect, it } from "vitest"
import { registry } from "../../components/Builtins.ts"
import * as Source from "../Source.ts"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const failure = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect)).then(String)

const template = `
AWSTemplateFormatVersion: "2010-09-09"
Description: Orders, queued and processed.
Resources:
  OrdersQueue:
    Type: AWS::SQS::Queue
    Properties:
      VisibilityTimeout: "60"
      FifoQueue: true
  Worker:
    Type: AWS::Lambda::Function
    Properties:
      MemorySize: 512
      Timeout: 30
  WorkerReadsOrders:
    Type: AWS::Lambda::EventSourceMapping
    Properties:
      EventSourceArn: !GetAtt OrdersQueue.Arn
      FunctionName: !Ref Worker
      BatchSize: 10
  Uploads:
    Type: AWS::S3::Bucket
`

describe("Source", () => {
  it("reads a design file as itself, with no report", async () => {
    const loaded = await run(Source.load("version: 1\nnodes:\n  orders: { type: aws.sqs }\nedges: {}\n"))
    expect(loaded).toEqual({ doc: { version: 1, nodes: { orders: { type: "aws.sqs" } }, edges: {} } })
  })

  it("reads a CloudFormation template into the same shape, with a report", async () => {
    const { doc, report } = await run(Source.load(template))
    expect(doc.description).toBe("Orders, queued and processed.")
    expect(doc.nodes["orders-queue"]).toMatchObject({
      type: "aws.sqs",
      settings: { kind: "fifo", visibilityTimeout: "60 seconds" },
      origin: { source: "cloudformation", ref: "OrdersQueue", type: "AWS::SQS::Queue" }
    })
    expect(doc.nodes.worker).toMatchObject({ type: "aws.lambda", settings: { memory: 512, timeout: "30 seconds" } })
    expect(doc.edges["worker-reads-orders"]).toMatchObject({
      from: { node: "orders-queue", port: "deliver" },
      to: "worker",
      settings: { batchSize: 10 }
    })
    expect(report?.converted.map((c) => c.ref)).toEqual(["OrdersQueue", "Worker", "WorkerReadsOrders"])
    expect(report?.skipped).toEqual([{ ref: "Uploads", type: "AWS::S3::Bucket", reason: "not read yet" }])
  })

  it("reports a bad template value where the author wrote it", async () => {
    const message = await failure(Source.load(template.replace(`VisibilityTimeout: "60"`, `VisibilityTimeout: soon`)))
    expect(message).toContain(`["Resources"]["OrdersQueue"]["Properties"]["VisibilityTimeout"]`)
  })

  it("skips a mapping from a source it doesn't read, and says why", async () => {
    const { report } = await run(Source.load(template.replace("!GetAtt OrdersQueue.Arn", "!GetAtt Uploads.Arn")))
    expect(report?.skipped).toContainEqual({ ref: "WorkerReadsOrders", type: "AWS::Lambda::EventSourceMapping", reason: "reads from Uploads, which isn't an SQS queue in this template" })
  })

  it("rejects text that isn't YAML, and data that is neither a design nor a template", async () => {
    expect(await failure(Source.load("just: [a, list"))).toContain("not valid YAML or JSON")
    expect(await failure(Source.load("hello: world"))).toContain("a design (with nodes and edges) or a CloudFormation template")
  })

  it("reports only the problem, not every shape the value could have had", async () => {
    const message = await failure(Source.load(template.replace(`VisibilityTimeout: "60"`, `VisibilityTimeout: soon`)))
    expect(message.split("\n").filter((l) => l.trim().startsWith("at "))).toHaveLength(1)
  })

  it("takes a template all the way to a design that runs", async () => {
    const design = await run(Source.loadDesign(template, registry))
    expect(Graph.nodeCount(design.graph)).toBe(2)
    expect(Graph.edgeCount(design.graph)).toBe(1)
  })
})
