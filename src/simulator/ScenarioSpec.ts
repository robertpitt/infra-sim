import { Schema } from "effect"

/**
 * What a scenario says, as data: how long to run, with what traffic, which settings changed, what breaks and when, and
 * what must hold. It is written in two places with the same fields: inside a design, under `scenarios` (a design
 * carries the scenarios written for it), and as a scenario file of its own, which adds `version` and the design it is
 * for (`Scenario.Scenario`). Running one is `Scenario.ts`; this module is only the shape, so the design schema can
 * hold scenarios without depending on the machinery that plays them.
 */

const DurationInput = Schema.Union([Schema.Number, Schema.String])

const Settings = Schema.Record(Schema.String, Schema.Unknown)

/** A fault given as `Outage`, `Slow(250ms)`, `Errors(20%)`, or as an object `{ type: Slow, extra: 250ms }`. */
const FaultInput = Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Unknown)])

export const TimelineEvent = Schema.Struct({
  /** When it happens, from the start of the run. */
  at: DurationInput,
  /** Say what this event is, in the result's log. */
  note: Schema.optionalKey(Schema.String),
  /**
   * Break something: `target` is `node:<id>`, `edge:<id>`, `region:<placement>` (`region:aws:us-east-1`) or
   * `zone:<placement>:<zone>` (`zone:aws:us-east-1:us-east-1a`).
   */
  inject: Schema.optionalKey(
    Schema.Struct({
      target: Schema.String,
      fault: FaultInput,
      /** How long it lasts. Without it the fault lasts until cleared. */
      for: Schema.optionalKey(DurationInput),
      /** A name to clear it by later. */
      id: Schema.optionalKey(Schema.String)
    })
  ),
  /** Lift a named fault, or `all` of them. */
  clear: Schema.optionalKey(Schema.String),
  /** Change settings of a node (`node`) or an edge (`edge`) while running. Merged over what it already has. */
  set: Schema.optionalKey(
    Schema.Struct({ node: Schema.optionalKey(Schema.String), edge: Schema.optionalKey(Schema.String), settings: Settings })
  ),
  /** Change account-level quotas of a placement such as `aws:us-east-1` while running. */
  account: Schema.optionalKey(Schema.Struct({ placement: Schema.String, settings: Settings }))
})
export type TimelineEvent = typeof TimelineEvent.Type

const AssertionInput = Schema.Union([
  Schema.String,
  Schema.Struct({
    check: Schema.String,
    name: Schema.optionalKey(Schema.String),
    /** Measure only from here (default: the end of the warm-up). */
    from: Schema.optionalKey(DurationInput),
    /** ... to here (default: the end of the run). */
    to: Schema.optionalKey(DurationInput)
  })
])

/** The fields of a scenario, wherever it is written. */
export const fields = {
  name: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  seed: Schema.optionalKey(Schema.Int),
  duration: Schema.optionalKey(DurationInput),
  /** Time to let the system settle before measuring. Assertions and summaries start after it. */
  warmup: Schema.optionalKey(DurationInput),
  /** Multiply every client's request rate. */
  traffic: Schema.optionalKey(Schema.Struct({ scale: Schema.Number })),
  /** Settings applied at the start, merged over the design's own, by node id, edge id and placement. */
  overrides: Schema.optionalKey(
    Schema.Struct({
      nodes: Schema.optionalKey(Schema.Record(Schema.String, Settings)),
      edges: Schema.optionalKey(Schema.Record(Schema.String, Settings)),
      accounts: Schema.optionalKey(Schema.Record(Schema.String, Settings))
    })
  ),
  timeline: Schema.optionalKey(Schema.Array(TimelineEvent)),
  assert: Schema.optionalKey(Schema.Array(AssertionInput))
}

/** A scenario as a design carries it, under `scenarios.<id>`: the design it is for is the one it is in. */
export const Spec = Schema.Struct(fields)
export type Spec = typeof Spec.Type
