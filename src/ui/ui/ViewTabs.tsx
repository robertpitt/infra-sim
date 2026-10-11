import { useStore } from "../lib/store.ts"
import { editor, showView, type View } from "../state/editor.ts"
import { ui } from "../state/ui.ts"
import { Icon } from "./Icon.tsx"

/** The design as a canvas or as YAML: two tabs at the top left of the stage. */
export function ViewTabs() {
  const view = useStore(ui, (s) => s.view)
  const edited = useStore(editor, (s) => s.draft !== undefined)
  const tab = (id: View, icon: string, label: string, title: string) => (
    <button role="tab" aria-selected={view === id} data-on={view === id || undefined} onClick={() => showView(id)} title={title}>
      <Icon name={icon} size={13} /> {label}
      {id === "editor" && edited && <i className="tab-dot" title="Edited, not applied yet" />}
    </button>
  )
  return (
    <div className="view-tabs" role="tablist" aria-label="View">
      {tab("visual", "layout", "Visual", "The design as a diagram")}
      {tab("editor", "code", "Editor", "The design as YAML, checked against its schema as you type")}
    </div>
  )
}
