import { Schema } from "effect"

export const Level = Schema.Literals(["error", "warning", "info"])
export type Level = typeof Level.Type

/** Something about a design the author should know. Errors stop it from running; warnings and infos don't. */
export const Diagnostic = Schema.Struct({
  level: Level,
  /** Stable identifier, e.g. `unknown-component`, `feedback-loop`. */
  code: Schema.String,
  message: Schema.String,
  node: Schema.optionalKey(Schema.String),
  edge: Schema.optionalKey(Schema.String),
  controller: Schema.optionalKey(Schema.String)
})
export type Diagnostic = typeof Diagnostic.Type

export const hasErrors = (diagnostics: ReadonlyArray<Diagnostic>): boolean => diagnostics.some((d) => d.level === "error")
