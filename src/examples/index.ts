import { Schema } from "effect"
import YAML from "yaml"
import * as Design from "../simulator/Design.ts"
import * as Scenario from "../simulator/Scenario.ts"

/**
 * The example designs. Each is a YAML (or JSON) file in `examples/` at the repository root, in the same format
 * `Design.Doc` describes, so an example is just a design you can open, read and edit like any other. Bundled as text at
 * build time; parsed and checked against the `Doc` schema when asked for.
 *
 * A file's name sets its order and id: `03-multi-region.yaml` is the example `multi-region`, third in the list. Its
 * `name` is the title, and the first paragraph of its `description` is the blurb.
 */
export interface Example {
  readonly id: string
  /** The file it came from, which is how a scenario names the design it plays against. */
  readonly file: string
  readonly title: string
  /** The first paragraph of the design's description. */
  readonly blurb: string
  readonly design: () => Design.Doc
}

const files = import.meta.glob("../../examples/*.{yaml,yml,json}", { query: "?raw", import: "default", eager: true }) as Record<string, string>

/** Read a design from text: YAML or JSON (JSON is YAML). Throws with the reasons if it isn't a valid document. */
export const parseDesign = (text: string): Design.Doc => {
  const result = Design.parse(YAML.parse(text))
  if (!result.ok) throw new Error(result.issues.slice(0, 3).join(" "))
  return result.doc
}

const toExample = (path: string, text: string): Example => {
  const file = path.split("/").pop()!
  const id = file.replace(/\.(ya?ml|json)$/, "").replace(/^\d+-/, "")
  const doc = parseDesign(text)
  return {
    id,
    file,
    title: doc.name ?? id,
    blurb: (doc.description ?? "").split(/\n\s*\n/)[0]!.replace(/\s+/g, " ").trim(),
    design: () => parseDesign(text)
  }
}

export const examples: ReadonlyArray<Example> = Object.entries(files)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([path, text]) => toExample(path, text))

/** Read a scenario from text (YAML or JSON). Throws with the reasons if it isn't one. */
export const parseScenario = (text: string): Scenario.Scenario => Schema.decodeUnknownSync(Scenario.Scenario)(YAML.parse(text))

/** The example a scenario's `design: ../01-orders.yaml` points at, matched by file name. */
export const designOf = (scenario: Scenario.Scenario): Example | undefined => {
  if (typeof scenario.design !== "string") return undefined
  const file = scenario.design.split(/[\\/]/).pop()
  return examples.find((e) => e.file === file)
}
