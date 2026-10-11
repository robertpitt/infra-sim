import { parseDesign } from "#examples"
import { Design, Layout, Topology } from "#simulator"
import YAML from "yaml"
import type { Doc } from "./types.ts"
import type { Example } from "#examples"
import { fit } from "../canvas/viewport.ts"
import { boundsOf } from "../canvas/geometry.ts"
import { doc, replaceDesign } from "./document.ts"
import { catalog, registry } from "./engine.ts"

/** Replace the design and frame it on screen. Asks first when there is edit history that would be lost. */
export const openDesign = (design: Doc, confirmReplace = true): void => {
  if (confirmReplace && doc.get().past.length > 0 && !window.confirm("Replace the current design? Your edits will be lost.")) return
  replaceDesign(design)
  requestAnimationFrame(() => fit(boundsOf(doc.get().design, catalog.get().byType)))
}

export const openExample = (example: Example): void => openDesign(example.design())

export const fitView = (): void => fit(boundsOf(doc.get().design, catalog.get().byType))

export type Format = "yaml" | "json"

/** Save the design as a file: YAML (readable, diffable, takes comments when edited by hand) or JSON. */
export const exportDesign = (format: Format): void => {
  const design = doc.get().design
  const text = format === "yaml" ? YAML.stringify(design, { lineWidth: 0 }) : JSON.stringify(design, null, 2)
  const blob = new Blob([text], { type: format === "yaml" ? "application/yaml" : "application/json" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `${Design.slug(design.name ?? "design")}.${format}`
  a.click()
  URL.revokeObjectURL(url)
}

/** Open a design from a YAML or JSON file. Returns what is wrong with it, if anything. */
export const importDesign = async (file: File): Promise<string | undefined> => {
  try {
    const parsed = parseDesign(await file.text())
    // Imports often have no positions; place whatever is missing.
    openDesign(Layout.autoLayout(parsed, registry))
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export const copyMermaid = async (): Promise<void> => {
  const text = Topology.toMermaid(Topology.fromDoc(doc.get().design, registry))
  await navigator.clipboard.writeText(text)
}
