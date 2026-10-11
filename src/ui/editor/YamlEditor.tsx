import { Diagnostics, DesignSchema } from "#simulator"
import { useEffect, useRef } from "react"
import YAML from "yaml"
import { useStore } from "../lib/store.ts"
import { doc } from "../state/document.ts"
import { applyDraft, designText, discardDraft, editor, readDesign, setDraft } from "../state/editor.ts"
import { catalog, registry } from "../state/engine.ts"
import type { Diagnostic } from "../state/types.ts"
import { Icon } from "../ui/Icon.tsx"
import { DESIGN_MODEL, monaco, applySchema } from "./monaco.ts"

/**
 * The design as YAML, in Monaco. The YAML language server completes, explains and checks it against the design schema
 * (the one a design file points VS Code at); on top of that, the simulator's own checks of the design (an edge to a
 * node that doesn't exist, a node outside the region box it claims) are marked where they apply. What is typed is a
 * draft until ⌘S, or going back to the canvas, applies it.
 */
export default function YamlEditor() {
  const host = useRef<HTMLDivElement>(null)
  const manifests = useStore(catalog, (s) => s.byType)

  // The schema follows the components (they change when a component is edited during development).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `manifests` is the signal that the registry changed.
  useEffect(() => applySchema(DesignSchema.designSchema(registry), DesignSchema.DESIGN_SCHEMA_URL), [manifests])

  useEffect(() => {
    const text = editor.get().draft ?? designText(doc.get().design)
    const model = monaco.editor.getModel(DESIGN_MODEL) ?? monaco.editor.createModel(text, "yaml", DESIGN_MODEL)
    if (model.getValue() !== text) model.setValue(text)
    const view = monaco.editor.create(host.current!, {
      model,
      theme: "infra-sim",
      automaticLayout: true,
      fontFamily: getComputedStyle(document.body).getPropertyValue("--mono"),
      fontSize: 12.5,
      lineHeight: 19,
      tabSize: 2,
      insertSpaces: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      padding: { top: 44, bottom: 12 },
      quickSuggestions: { other: true, comments: false, strings: true },
      fixedOverflowWidgets: true,
      renderLineHighlight: "line",
      stickyScroll: { enabled: false }
    })

    // Show the design as it is whenever there's no draft: after applying, after an undo, after an edit made elsewhere.
    let syncing = false
    const sync = () => {
      if (editor.get().draft !== undefined) return
      const next = designText(doc.get().design)
      if (model.getValue() === next) return
      const state = view.saveViewState()
      syncing = true
      model.setValue(next)
      syncing = false
      if (state !== null) view.restoreViewState(state)
    }
    const offDoc = doc.subscribe(sync)
    const offEditor = editor.subscribe(sync)

    // The simulator's own checks, a moment after typing stops.
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = () => monaco.editor.setModelMarkers(model, "infra-sim", markersFor(model.getValue()))
    const typed = model.onDidChangeContent(() => {
      if (!syncing) setDraft(model.getValue())
      clearTimeout(timer)
      timer = setTimeout(check, 350)
    })
    check()

    view.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void applyDraft())
    view.focus()
    return () => {
      clearTimeout(timer)
      typed.dispose()
      offDoc()
      offEditor()
      view.dispose()
    }
  }, [])

  return (
    <div className="yaml-editor">
      <div ref={host} className="yaml-editor-host" />
      <Status />
    </div>
  )
}

/** Where the editor stands: in step with the design, edited, or edited into something that isn't a design. */
function Status() {
  const draft = useStore(editor, (s) => s.draft !== undefined)
  const problems = useStore(editor, (s) => s.problems)
  return (
    <div className="editor-status" data-state={problems.length > 0 ? "invalid" : draft ? "edited" : "synced"}>
      {problems.length > 0 ? (
        <span className="editor-status-text" title={problems.join("\n")}>
          <Icon name="warn" size={13} /> Can't apply: {problems[0]}
        </span>
      ) : draft ? (
        <span className="editor-status-text">
          <Icon name="dot" size={13} /> Edited. <kbd>⌘S</kbd> or going back to Visual applies it.
        </span>
      ) : (
        <span className="editor-status-text">
          <Icon name="check" size={13} /> The design as it is.
        </span>
      )}
      <span className="spacer" />
      <a className="editor-schema" href={DesignSchema.DESIGN_SCHEMA_URL} target="_blank" rel="noreferrer" title="The JSON Schema this editor (and VS Code) checks designs against">
        design.schema.json
      </a>
      {draft && (
        <>
          <button className="btn small ghost" onClick={discardDraft} title="Throw the edits away and show the design as it is">
            Revert
          </button>
          <button className="btn small primary" onClick={() => void applyDraft()} title="Apply (⌘S)">
            Apply
          </button>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------
// The simulator's checks, as markers
// ---------------------------------------------------------------------------------------------------------

/** Problems the schema already marks, more precisely, where the value is. */
const SCHEMA_CHECKED = new Set(["bad-settings", "bad-controller-settings", "unknown-component", "unknown-controller"])

const SEVERITY = { error: monaco.MarkerSeverity.Error, warning: monaco.MarkerSeverity.Warning, info: monaco.MarkerSeverity.Info } as const

const markersFor = (text: string): Array<monaco.editor.IMarkerData> => {
  const read = readDesign(text)
  // Text that isn't a design yet is the YAML and schema checks' business.
  if (!read.ok) return []
  const lines = new YAML.LineCounter()
  const yaml = YAML.parseDocument(text, { lineCounter: lines })
  /** The range of the key `id` in the map at `section` (nodes, edges, controllers), or the first line. */
  const at = (section: string | undefined, id: string | undefined) => {
    const map = section === undefined ? undefined : yaml.get(section, true)
    const pair = YAML.isMap(map) ? map.items.find((p) => YAML.isScalar(p.key) && String(p.key.value) === id) : undefined
    const range = YAML.isScalar(pair?.key) ? pair.key.range : undefined
    if (range === undefined || range === null) return { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 200 }
    const start = lines.linePos(range[0])
    const end = lines.linePos(range[1])
    return { startLineNumber: start.line, startColumn: start.col, endLineNumber: end.line, endColumn: end.col }
  }
  const where = (d: Diagnostic) =>
    d.edge !== undefined ? at("edges", d.edge) : d.controller !== undefined ? at("controllers", d.controller) : at("nodes", d.node)
  return Diagnostics.diagnose(read.doc, registry)
    .filter((d) => !SCHEMA_CHECKED.has(d.code))
    .map((d) => ({ ...where(d), severity: SEVERITY[d.level], message: d.message, source: "infra-sim", code: d.code }))
}
