import { Design, DesignSchema, Layout } from "#simulator"
import YAML from "yaml"
import { createStore } from "../lib/store.ts"
import { applyDesign, doc } from "./document.ts"
import { registry } from "./engine.ts"
import type { Doc } from "./types.ts"
import { ui, type UiState } from "./ui.ts"

/**
 * The design as YAML, edited as text. The document stays the source of truth: the editor shows it, and what is typed
 * is a draft until it is applied (⌘S, or going back to the canvas), when it becomes one edit, undoable like any other.
 * A draft that isn't a design can't be applied, and says why. None of this needs the editor itself, which is loaded only
 * when its tab is first opened.
 */

export type View = UiState["view"]

export interface EditorState {
  /** Text typed in the editor that isn't in the design yet; undefined when the editor shows the design as it is. */
  readonly draft: string | undefined
  /** Why the draft can't be applied, when an attempt failed. */
  readonly problems: ReadonlyArray<string>
}

export const editor = createStore<EditorState>({ draft: undefined, problems: [] })

const stringify = (value: unknown): string => YAML.stringify(value, { lineWidth: 0 })

/** The design as the editor shows it: what Save writes, with the line that points editors at the schema. */
export const designText = (design: Doc): string => DesignSchema.fileText(design, "yaml", stringify)

export type Read = { readonly ok: true; readonly doc: Doc } | { readonly ok: false; readonly problems: ReadonlyArray<string> }

/** Read text as a design: YAML first, then the design's shape. Nodes without a position are laid out. */
export const readDesign = (text: string): Read => {
  const parsed = YAML.parseDocument(text)
  if (parsed.errors.length > 0) return { ok: false, problems: parsed.errors.map((e) => `YAML: ${e.message.split("\n")[0]}`) }
  const result = Design.parse(parsed.toJS())
  if (!result.ok) return { ok: false, problems: result.issues }
  const { $schema: _schema, ...design } = result.doc
  return { ok: true, doc: Layout.autoLayout(design, registry) }
}

/** The editor's text changed by typing. */
export const setDraft = (text: string): void => editor.set({ draft: text, problems: [] })

/** Make the draft the design. False, with the reasons in `problems`, when it isn't one. */
export const applyDraft = (): boolean => {
  const { draft } = editor.get()
  if (draft === undefined) return true
  const read = readDesign(draft)
  if (!read.ok) {
    editor.set({ draft, problems: read.problems })
    return false
  }
  if (draft !== designText(doc.get().design)) applyDesign(read.doc)
  editor.set({ draft: undefined, problems: [] })
  return true
}

export const discardDraft = (): void => editor.set({ draft: undefined, problems: [] })

/**
 * Switch between the canvas and the editor. Leaving the editor applies its draft; a draft that can't be applied is
 * kept unless the person says to throw it away.
 */
export const showView = (view: View): void => {
  if (ui.get().view === view) return
  if (view === "visual" && !applyDraft()) {
    const { problems } = editor.get()
    const list = problems.slice(0, 3).join("\n")
    if (!window.confirm(`The YAML can't be applied:\n\n${list}\n\nDiscard your edits and go back to the canvas?`)) return
    discardDraft()
  }
  ui.set((s) => ({ ...s, view }))
}
