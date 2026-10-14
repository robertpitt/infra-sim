/**
 * What every source decodes to: a design document, plus, when it came from something else, the report of what was
 * carried over and what was left out. A design file decodes to a `Loaded` with no report; a CloudFormation template
 * to one with a report. Whatever reads files (the app, the command line, the examples) gets the same shape back.
 */
import { Schema } from "effect"
import * as Design from "../Design.ts"

/** What happened to each part of a source that isn't a design. Nothing is dropped without saying so. */
export const Report = Schema.Struct({
  /** The source's format: `cloudformation`. */
  source: Schema.String,
  /** Parts that became components or connections: the source's own id, its type, and the node or edge it became. */
  converted: Schema.Array(Schema.Struct({ ref: Schema.String, type: Schema.String, to: Schema.String })),
  /** Parts that didn't, and why. */
  skipped: Schema.Array(Schema.Struct({ ref: Schema.String, type: Schema.String, reason: Schema.String }))
})
export type Report = typeof Report.Type

export const Loaded = Schema.Struct({
  doc: Design.Doc,
  report: Schema.optionalKey(Report)
})
export type Loaded = typeof Loaded.Type
