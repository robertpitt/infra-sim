import path from "node:path"
import { Data, Schema } from "effect"
import { Design, detectImporter, ImportError, type Importer, type ImportReport, Scenario } from "#simulator"
import { registry } from "#simulator/components"
import { parseTemplate } from "../simulator/importers/Intrinsics.ts"
import YAML from "yaml"
import type { IO } from "./io.ts"

/**
 * A problem with the input the user gave: the exit code for these is 2, and the message says what to fix. A tagged error, so it
 * travels in an Effect's error channel; the synchronous loaders below throw it and the commands turn that into a failure.
 */
export class UsageError extends Data.TaggedError("UsageError")<{ readonly message: string; readonly issues: ReadonlyArray<string> }> {
  constructor(message: string, issues: ReadonlyArray<string> = []) {
    super({ message, issues })
  }
}

export type Loaded =
  | { readonly kind: "design"; readonly file: string; readonly doc: Design.Doc; readonly imported?: { readonly importer: string; readonly report: ImportReport } }
  | { readonly kind: "scenario"; readonly file: string; readonly scenario: Scenario.Scenario; readonly design: Design.Doc | undefined; readonly designFile: string | undefined; readonly imported?: { readonly importer: string; readonly report: ImportReport } }

export interface LoadOptions {
  readonly region?: string
  readonly rps?: number
}

/** `@poshub` and `example:poshub` name an example that ships with the tool. */
export const resolveReference = (io: IO, reference: string): string => {
  const id = reference.startsWith("@") ? reference.slice(1) : reference.startsWith("example:") ? reference.slice(8) : undefined
  if (id === undefined) return path.resolve(io.cwd(), reference)
  const dir = io.assets("examples")
  const file = exampleFiles(io).find((f) => stem(f) === id)
  if (file === undefined) throw new UsageError(`no example called "${id}"`, [`examples: ${exampleFiles(io).map(stem).join(", ") || "(none found)"}`])
  return path.join(dir, file)
}

export const stem = (file: string): string => file.replace(/^\d+-/, "").replace(/\.(ya?ml|json)$/, "")

export const exampleFiles = (io: IO): ReadonlyArray<string> =>
  io.list(io.assets("examples")).filter((f) => /^\d+-.*\.(ya?ml|json)$/.test(f)).sort()

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const parse = (text: string, file: string): Record<string, unknown> => {
  try {
    return parseTemplate(text)
  } catch (error) {
    throw new UsageError(`${file}: not valid YAML or JSON (${messageOf(error).split("\n")[0]})`)
  }
}

const isDesign = (v: Record<string, unknown>): boolean => typeof v.nodes === "object" && v.nodes !== null && !Array.isArray(v.nodes) && !("Resources" in v)
const isScenario = (v: Record<string, unknown>): boolean => ["duration", "timeline", "assert", "traffic", "overrides", "warmup"].some((k) => k in v) || (typeof v.design === "string" && !isDesign(v))

/** Import with whichever importer recognises the text, or the one asked for. */
const importText = (text: string, file: string, options: LoadOptions, importer?: Importer) => {
  const chosen = importer ?? detectImporter(text)
  if (chosen === undefined) return undefined
  try {
    const { doc, report } = chosen.run(text, registry, { fileName: path.basename(file), ...(options.region === undefined ? {} : { region: options.region }), ...(options.rps === undefined ? {} : { rps: options.rps }) })
    return { doc, imported: { importer: chosen.title, report } }
  } catch (error) {
    if (error instanceof ImportError) throw new UsageError(`${file}: ${error.message}`)
    throw error
  }
}

/** Read a design, a scenario (with the design it names), or a template an importer understands. */
export const load = (io: IO, reference: string, options: LoadOptions = {}, importer?: Importer): Loaded => {
  const file = resolveReference(io, reference)
  if (!io.exists(file)) throw new UsageError(`${reference}: no such file`)
  const text = io.readFile(file)
  const value = parse(text, reference)

  const imported = importText(text, file, options, importer)
  if (imported !== undefined) return { kind: "design", file, doc: imported.doc, imported: imported.imported }

  if (isScenario(value)) {
    const decoded = decodeScenario(value, reference)
    let design: Design.Doc | undefined
    let designFile: string | undefined
    let importedFrom: { importer: string; report: ImportReport } | undefined
    if (typeof decoded.design === "string") {
      designFile = path.resolve(path.dirname(file), decoded.design)
      const inner = load(io, designFile, options)
      if (inner.kind !== "design") throw new UsageError(`${reference}: design "${decoded.design}" is itself a scenario`)
      design = inner.doc
      importedFrom = inner.imported
    } else if (decoded.design !== undefined) design = decoded.design
    return { kind: "scenario", file, scenario: decoded, design, designFile, ...(importedFrom === undefined ? {} : { imported: importedFrom }) }
  }

  if (isDesign(value)) return { kind: "design", file, doc: decodeDesign(value, reference) }
  throw new UsageError(`${reference}: not a design, a scenario or a template an importer reads`, [
    "a design has `nodes` and `edges`; a scenario has `duration`, `timeline` or `assert` (and `design:`); see `infra-sim docs`"
  ])
}

const decodeDesign = (value: unknown, reference: string): Design.Doc => {
  const parsed = Design.parse(value)
  if (!parsed.ok) throw new UsageError(`${reference}: not a valid design`, parsed.issues)
  return parsed.doc
}

const decodeScenario = (value: Record<string, unknown>, reference: string): Scenario.Scenario => {
  const result = decodeSync(value)
  if (typeof result === "string") throw new UsageError(`${reference}: not a valid scenario`, result.split("\n").map((l) => l.trim()).filter(Boolean))
  return result
}

const decodeSync = (value: unknown): Scenario.Scenario | string => {
  try {
    return Schema.decodeUnknownSync(Scenario.Scenario as unknown as Schema.Decoder<Scenario.Scenario>)({ version: 1, ...(value as object) }, { errors: "all" })
  } catch (error) {
    return messageOf(error)
  }
}

/** A design as text, in the format the file name (or `format`) asks for. YAML unless it says JSON. */
export const encodeDesign = (doc: Design.Doc, format: "yaml" | "json"): string =>
  format === "json" ? `${JSON.stringify(doc, null, 2)}\n` : YAML.stringify(doc, { lineWidth: 0 })
