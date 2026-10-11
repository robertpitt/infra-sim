import { parseDesign } from "#examples"
import { Design, detectImporter, type Importer, type ImportReport, Layout, Topology } from "#simulator"
import YAML from "yaml"
import type { Doc } from "./types.ts"
import type { Example } from "#examples"
import { centreOn, fit, isVisible } from "../canvas/viewport.ts"
import { rectOf } from "../canvas/groups.ts"
import { boundsOf } from "../canvas/geometry.ts"
import { createStore } from "../lib/store.ts"
import { doc, replaceDesign, select } from "./document.ts"
import { catalog, client, registry } from "./engine.ts"
import { run } from "./run.ts"

/**
 * Replace the design and frame it on screen. Asks first when there is edit history that would be lost; false if the
 * answer was no. A scenario playing against the old design stops: it was written for that one.
 */
export const openDesign = (design: Doc, confirmReplace = true): boolean => {
  if (confirmReplace && doc.get().past.length > 0 && !window.confirm("Replace the current design? Your edits will be lost.")) return false
  if (run.get().scenario !== undefined) client.send({ _tag: "clearScenario" })
  replaceDesign(design)
  requestAnimationFrame(() => fit(boundsOf(doc.get().design, catalog.get().byType)))
  return true
}

export const openExample = (example: Example): void => void openDesign(example.design())

export const fitView = (): void => fit(boundsOf(doc.get().design, catalog.get().byType))

/** Select a node and bring it into view if it is off screen. */
export const showNode = (id: string): void => {
  const node = doc.get().design.nodes[id]
  if (node === undefined) return
  select({ kind: "node", id })
  const r = rectOf(node, catalog.get().byType[node.type])
  if (!isVisible(r)) centreOn(r.x + r.w / 2, r.y + r.h / 2)
}

export type Format = "yaml" | "json"

// ---------------------------------------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------------------------------------

/**
 * Save the design as a file. YAML is the primary format: readable, diffable, and it takes comments when someone edits
 * it by hand. JSON is there for tools that want it.
 */
export const saveDesign = (format: Format = "yaml"): void => {
  const design = doc.get().design
  const text = format === "yaml" ? YAML.stringify(design, { lineWidth: 0 }) : JSON.stringify(design, null, 2)
  const blob = new Blob([text], { type: format === "yaml" ? "application/yaml" : "application/json" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `${Design.slug(design.name ?? "design")}.${format === "yaml" ? "yaml" : "json"}`
  a.click()
  URL.revokeObjectURL(url)
  say(`Saved ${a.download}`)
}

// ---------------------------------------------------------------------------------------------------------
// Opening and importing
// ---------------------------------------------------------------------------------------------------------

/** A short message shown over the canvas. */
export const toast = createStore<string | undefined>(undefined)
let toastTimer: ReturnType<typeof setTimeout> | undefined
export const say = (message: string, ms = 3000): void => {
  toast.set(message)
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.set(undefined), ms)
}

/** What an import did, shown to the user once it is done. */
export interface ImportOutcome {
  readonly importer: string
  readonly fileName: string
  readonly report: ImportReport
}
export const importOutcome = createStore<ImportOutcome | undefined>(undefined)

/** Ask for a file. Resolves with `undefined` if the dialog is cancelled. */
export const pickFile = (accept: string): Promise<File | undefined> =>
  new Promise((resolve) => {
    const input = document.createElement("input")
    input.type = "file"
    input.accept = accept
    input.onchange = () => resolve(input.files?.[0])
    input.oncancel = () => resolve(undefined)
    input.click()
  })

const DESIGN_FILES = ".yaml,.yml,.json,application/json,application/yaml"

/** Turn a file's text into a design: a design file as it is, anything an importer recognises through that importer. */
const load = (text: string, fileName: string, importer?: Importer): { doc: Doc; outcome?: ImportOutcome } => {
  const chosen = importer ?? detectImporter(text)
  if (chosen !== undefined) {
    const { doc: imported, report } = chosen.run(text, registry, { fileName })
    return { doc: imported, outcome: { importer: chosen.title, fileName, report } }
  }
  // Designs from other tools often have no positions; place whatever is missing.
  return { doc: Layout.autoLayout(parseDesign(text), registry) }
}

/** Open a design from YAML or JSON. A CloudFormation template, or anything else an importer recognises, is imported instead. */
export const openFile = async (file: File, importer?: Importer): Promise<void> => {
  try {
    const { doc: opened, outcome } = load(await file.text(), file.name, importer)
    openDesign(opened)
    if (outcome !== undefined) importOutcome.set(outcome)
    else say(`Opened ${file.name}`)
  } catch (error) {
    say(`Couldn't open ${file.name}: ${error instanceof Error ? error.message : String(error)}`, 6000)
  }
}

/** File ▸ Open. */
export const openFileDialog = async (): Promise<void> => {
  const file = await pickFile(`${DESIGN_FILES},.template`)
  if (file !== undefined) await openFile(file)
}

/** File ▸ Import ▸ (an importer). */
export const importFileDialog = async (importer: Importer): Promise<void> => {
  const file = await pickFile(importer.extensions.join(","))
  if (file !== undefined) await openFile(file, importer)
}

export const copyMermaid = async (): Promise<void> => {
  const text = Topology.toMermaid(Topology.fromDoc(doc.get().design, registry))
  await navigator.clipboard.writeText(text)
}
