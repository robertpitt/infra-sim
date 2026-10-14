/**
 * The value forms a CloudFormation template writes, as codecs: numbers and booleans that may be strings, durations in
 * seconds, and references to other resources. `CloudFormation.ts` builds its resource schemas from these, so a property
 * is decoded straight into the form a design uses.
 */
import { Schema, SchemaTransformation } from "effect"
import type { Tags } from "yaml"

const SHORT_FORMS = [
  "Ref", "Condition", "GetAtt", "Sub", "Join", "Select", "Split", "If", "Equals", "Not", "And", "Or", "FindInMap",
  "ImportValue", "Base64", "Cidr", "GetAZs", "Transform", "Length", "ToJsonString", "ForEach"
] as const

const longName = (short: string): string => (short === "Ref" || short === "Condition" ? short : `Fn::${short}`)

/** The short forms (`!Ref x`, `!GetAtt [a, b]`) read as the long ones (`{ Ref: x }`), which every template may also use. */
export const tags: Tags = SHORT_FORMS.flatMap((short) => [
  { tag: `!${short}`, resolve: (value: string) => ({ [longName(short)]: value }) },
  { tag: `!${short}`, collection: "seq" as const, resolve: (seq: { toJSON(): unknown }) => ({ [longName(short)]: seq.toJSON() }) },
  { tag: `!${short}`, collection: "map" as const, resolve: (map: { toJSON(): unknown }) => ({ [longName(short)]: map.toJSON() }) }
]) as unknown as Tags

/** A number, which templates often quote: `30` or `"30"`. */
export const Num = Schema.Union([Schema.Finite, Schema.FiniteFromString])

/** A boolean, which templates often quote: `true` or `"true"`. */
export const Bool = Schema.Union([
  Schema.Boolean,
  Schema.Literals(["true", "false"]).pipe(
    Schema.decodeTo(Schema.Boolean, SchemaTransformation.transform({ decode: (s) => s === "true", encode: (b) => (b ? "true" : "false") }))
  )
])

/** Whole seconds in a template, as the duration a design writes: `30` becomes `"30 seconds"`. */
export const Seconds = Num.pipe(
  Schema.decodeTo(Schema.String, SchemaTransformation.transform({ decode: (n) => `${n} seconds`, encode: (s) => Number.parseFloat(s) }))
)

const RefForm = Schema.Struct({ Ref: Schema.String }).pipe(
  Schema.decodeTo(Schema.String, SchemaTransformation.transform({ decode: (r) => r.Ref, encode: (id) => ({ Ref: id }) }))
)

const GetAttForm = Schema.Struct({ "Fn::GetAtt": Schema.Union([Schema.Tuple([Schema.String, Schema.String]), Schema.String]) }).pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (g) => (typeof g["Fn::GetAtt"] === "string" ? g["Fn::GetAtt"].split(".")[0]! : g["Fn::GetAtt"][0]),
      encode: (id) => ({ "Fn::GetAtt": [id, "Arn"] as const })
    })
  )
)

/** Another resource, by its logical id: `!Ref Queue`, `!GetAtt Queue.Arn`, or the bare id. */
export const ResourceRef = Schema.Union([RefForm, GetAttForm, Schema.String])

/** `OrdersQueue` -> `orders-queue`: a logical id as a design's node id. */
export const nodeId = (logicalId: string): string =>
  logicalId.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "node"

/**
 * Copy the properties a design keeps, under the names it uses: `settingsFrom(p, { Timeout: "timeout" })`. Properties the
 * template leaves out stay out, so the component's default applies.
 */
export const settingsFrom = <P extends object>(properties: P, names: { readonly [K in keyof P]?: string }): Record<string, unknown> => {
  const settings: Record<string, unknown> = {}
  for (const [key, name] of Object.entries(names) as unknown as ReadonlyArray<[keyof P & string, string]>) {
    if (properties[key] !== undefined) settings[name] = properties[key]
  }
  return settings
}
