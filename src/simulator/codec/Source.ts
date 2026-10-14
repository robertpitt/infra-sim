/**
 * Every file the simulator reads, through one codec. Text becomes data (`Format`), data becomes a `Loaded` by
 * whichever source it is (a design file, a CloudFormation template), and the `Doc` inside becomes a running design
 * through `Design.codec`. The app, the command line and the examples all read files through here, so they agree on
 * what a file is.
 *
 *   text ──Format──► data ──Sources──► Loaded { doc, report? } ──Design.codec──► Design
 *
 * Adding a source (Terraform, a newer design version) is adding a member to `Sources`.
 */
import { Effect, Schema, SchemaTransformation } from "effect"
import * as Design from "../Design.ts"
import type { Components } from "../Registry.ts"
import * as CloudFormation from "./CloudFormation.ts"
import * as Format from "./Format.ts"
import { dispatch, field } from "./internal/dispatch.ts"
import { Loaded } from "./Loaded.ts"

/** A design file is already a document: it loads as itself, with no report. */
export const DesignFile = Design.Doc.pipe(
  Schema.decodeTo(Schema.toType(Loaded), SchemaTransformation.transform({ decode: (doc) => ({ doc }), encode: ({ doc }) => doc }))
)

/** Every source, chosen by its shape: a template has `Resources`, a design has `nodes`. */
export const Sources = dispatch(
  [DesignFile, CloudFormation.ToLoaded],
  (data) => (field(data, "Resources") !== undefined ? CloudFormation.ToLoaded : field(data, "nodes") !== undefined ? DesignFile : undefined),
  "a design (with nodes and edges) or a CloudFormation template (with Resources)"
)

/** Any file's text to a `Loaded`. */
export const FromText = Format.yaml({ tags: CloudFormation.tags }).pipe(Schema.decodeTo(Sources))

/** Read a file's text, reporting every problem. */
export const load = (text: string) => Schema.decodeEffect(FromText)(text, { errors: "all" })

/** Read a file's text all the way to a design that can run, with its settings checked against `registry`. */
export const loadDesign = Effect.fnUntraced(function*(text: string, registry: Components) {
  const { doc } = yield* load(text)
  return yield* Schema.decodeEffect(Design.codec(registry))(doc, { errors: "all" })
})
