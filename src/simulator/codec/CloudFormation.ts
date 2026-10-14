/**
 * CloudFormation templates as a source of designs. A template decodes in two steps:
 *
 *  1. `Template`: the template's shape, with one schema per resource type this reads. Each is written with the
 *     template's own property names, so a bad value is reported where the author wrote it
 *     (`Resources.Orders.Properties.VisibilityTimeout`), and its values decode straight into the form a design
 *     uses (`30` becomes `"30 seconds"`).
 *  2. `ToLoaded`: each resource becomes nodes and edges by its entry in `convert`, and everything else is reported
 *     as skipped, with the reason.
 *
 * Trial scope: SQS queues, Lambda functions and the event source mappings between them. The importer in
 * `importers/` still reads everything else.
 */
import { Schema, SchemaGetter, SchemaTransformation } from "effect"
import type * as Design from "../Design.ts"
import * as Format from "./Format.ts"
import { Bool, nodeId, Num, ResourceRef, Seconds, settingsFrom, tags } from "./internal/cloudformation.ts"
import { dispatch, field } from "./internal/dispatch.ts"
import { Loaded, type Report } from "./Loaded.ts"

// ---------------------------------------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------------------------------------

export const SqsQueue = Schema.Struct({
  Type: Schema.Literal("AWS::SQS::Queue"),
  Properties: Schema.optionalKey(Schema.Struct({
    FifoQueue: Schema.optionalKey(Bool),
    VisibilityTimeout: Schema.optionalKey(Seconds),
    MessageRetentionPeriod: Schema.optionalKey(Seconds),
    DelaySeconds: Schema.optionalKey(Seconds)
  }))
})

export const LambdaFunction = Schema.Struct({
  Type: Schema.Literal("AWS::Lambda::Function"),
  Properties: Schema.optionalKey(Schema.Struct({
    MemorySize: Schema.optionalKey(Num),
    Timeout: Schema.optionalKey(Seconds)
  }))
})

export const LambdaEventSourceMapping = Schema.Struct({
  Type: Schema.Literal("AWS::Lambda::EventSourceMapping"),
  Properties: Schema.Struct({
    EventSourceArn: ResourceRef,
    FunctionName: ResourceRef,
    BatchSize: Schema.optionalKey(Num),
    MaximumBatchingWindowInSeconds: Schema.optionalKey(Seconds)
  })
})

const read = [SqsQueue, LambdaFunction, LambdaEventSourceMapping] as const
const byType: ReadonlyMap<unknown, (typeof read)[number]> = new Map(read.map((s) => [s.fields.Type.literal, s]))

/** A resource of a type not read here: kept only so it can be reported as skipped. */
export const Unread = Schema.Struct({ Type: Schema.String })

/** A resource, decoded by the schema for its `Type`. */
export const Resource = dispatch([...read, Unread], (r) => byType.get(field(r, "Type")) ?? Unread, "a resource")
export type Resource = typeof Resource.Type

export const Template = Schema.Struct({
  AWSTemplateFormatVersion: Schema.optionalKey(Schema.String),
  Description: Schema.optionalKey(Schema.String),
  Resources: Schema.Record(Schema.String, Resource)
})
export type Template = typeof Template.Type

// ---------------------------------------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------------------------------------

/** What one resource adds to the design, or why it adds nothing. */
type Part = { readonly nodes?: Record<string, Design.NodeDoc>; readonly edges?: Record<string, Design.EdgeDoc> } | { readonly skip: string }

type Read = (typeof read)[number]["Type"]
type Convert = { readonly [T in Read["Type"]]: (id: string, resource: Extract<Read, { Type: T }>, all: Template["Resources"]) => Part }

const origin = (ref: string, type: string): Design.Origin => ({ source: "cloudformation", ref, type })

const node = (id: string, resource: Read, type: string, settings: Record<string, unknown>): Part => ({
  nodes: { [nodeId(id)]: { type, name: id, settings, origin: origin(id, resource.Type) } }
})

/** One entry per resource type read: the resource's decoded properties in, its part of the design out. */
const convert: Convert = {
  "AWS::SQS::Queue": (id, r) => {
    const p = r.Properties ?? {}
    return node(id, r, "aws.sqs", {
      ...(p.FifoQueue === true ? { kind: "fifo" } : {}),
      ...settingsFrom(p, { VisibilityTimeout: "visibilityTimeout", MessageRetentionPeriod: "retention", DelaySeconds: "delay" })
    })
  },

  "AWS::Lambda::Function": (id, r) => node(id, r, "aws.lambda", settingsFrom(r.Properties ?? {}, { MemorySize: "memory", Timeout: "timeout" })),

  "AWS::Lambda::EventSourceMapping": (id, { Type, Properties: p }, all) => {
    if (all[p.EventSourceArn]?.Type !== "AWS::SQS::Queue") return { skip: `reads from ${p.EventSourceArn}, which isn't an SQS queue in this template` }
    if (all[p.FunctionName]?.Type !== "AWS::Lambda::Function") return { skip: `invokes ${p.FunctionName}, which isn't a function in this template` }
    return {
      edges: {
        [nodeId(id)]: {
          from: { node: nodeId(p.EventSourceArn), port: "deliver" },
          to: nodeId(p.FunctionName),
          settings: settingsFrom(p, { BatchSize: "batchSize", MaximumBatchingWindowInSeconds: "batchWindow" }),
          origin: origin(id, Type)
        }
      }
    }
  }
}

const toLoaded = (template: Template): Loaded => {
  const nodes: Record<string, Design.NodeDoc> = {}
  const edges: Record<string, Design.EdgeDoc> = {}
  const converted: Array<Report["converted"][number]> = []
  const skipped: Array<Report["skipped"][number]> = []
  for (const [id, resource] of Object.entries(template.Resources)) {
    const part: Part = byType.has(resource.Type)
      ? convert[resource.Type as Read["Type"]](id, resource as never, template.Resources)
      : { skip: "not read yet" }
    if ("skip" in part) {
      skipped.push({ ref: id, type: resource.Type, reason: part.skip })
      continue
    }
    Object.assign(nodes, part.nodes)
    Object.assign(edges, part.edges)
    converted.push({ ref: id, type: resource.Type, to: nodeId(id) })
  }
  const description = template.Description === undefined ? {} : { description: template.Description }
  return { doc: { version: 1, ...description, nodes, edges }, report: { source: "cloudformation", converted, skipped } }
}

/** A template to the design it describes and the report of what was read. One way: a design doesn't become a template. */
export const ToLoaded = Template.pipe(
  Schema.decodeTo(
    Schema.toType(Loaded),
    new SchemaTransformation.Transformation(
      SchemaGetter.transform(toLoaded),
      SchemaGetter.forbidden(() => "a design can't be written back as a CloudFormation template")
    )
  )
)

/** The YAML tags a template may use (`!Ref`, `!GetAtt`...), for a reader that accepts templates among other files. */
export { tags }

/** Template text (YAML or JSON) to a `Loaded`. */
export const FromText = Format.yaml({ tags }).pipe(Schema.decodeTo(ToLoaded))
