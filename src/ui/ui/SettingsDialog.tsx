import { useRef } from "react"
import type { PointerEvent } from "react"
import { createStore, useStore } from "../lib/store.ts"
import { doc, removeSelection } from "../state/document.ts"
import { closeSettings, setPanel, ui } from "../state/ui.ts"
import { Icon } from "./Icon.tsx"
import { EdgeSettings, NodeSettings } from "./Inspector.tsx"

/**
 * The settings of what is selected, in a dialog over the canvas: opened from the gear on a selected node or connection,
 * or by double-clicking it. It doesn't block the canvas, so the system can be watched responding while a slider moves,
 * and it follows the selection: click another node and it shows that one. It can be dragged out of the way by its
 * title bar, and stays where it was put.
 */

// Deselecting closes it: there is nothing left to configure.
doc.subscribe(() => {
  if (doc.get().selection === undefined && ui.get().settings) setPanel("settings", false)
})

/** How far the dialog has been dragged from its corner. */
const offset = createStore({ x: 0, y: 0 })

export function SettingsDialog() {
  const open = useStore(ui, (s) => s.settings)
  const selection = useStore(doc, (s) => s.selection)
  const at = useStore(offset, (o) => o)
  const box = useRef<HTMLElement>(null)
  const drag = useRef<{ readonly x: number; readonly y: number; readonly from: { x: number; y: number } } | undefined>(undefined)
  if (!open || selection === undefined) return null

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as Element).closest("button") !== null) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, from: offset.get() }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    const el = box.current
    if (d === undefined || el === null) return
    // Keep the title bar on screen: the dialog stays inside the canvas it floats over.
    const parent = (el.offsetParent as HTMLElement | null)?.getBoundingClientRect()
    const base = { left: el.offsetLeft, top: el.offsetTop }
    let x = d.from.x + e.clientX - d.x
    let y = d.from.y + e.clientY - d.y
    if (parent !== undefined) {
      x = Math.min(Math.max(x, -base.left), parent.width - base.left - el.offsetWidth)
      y = Math.min(Math.max(y, -base.top), parent.height - base.top - 40)
    }
    offset.set({ x, y })
  }
  const onPointerUp = () => {
    drag.current = undefined
  }

  return (
    <section
      ref={box}
      className="settings-dialog"
      role="dialog"
      aria-label="Settings"
      style={{ translate: `${at.x}px ${at.y}px` }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation()
          closeSettings()
        }
      }}
    >
      <div className="settings-bar" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        <Icon name="gear" size={13} />
        <span>{selection.kind === "node" ? "Settings" : "Connection settings"}</span>
        <span className="spacer" />
        <button className="icon-btn" title="Delete (Del)" onClick={removeSelection}>
          <Icon name="trash" size={14} />
        </button>
        <button className="icon-btn" title="Close (Esc)" onClick={closeSettings}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="settings-scroll">
        {selection.kind === "node" ? <NodeSettings key={selection.id} id={selection.id} /> : <EdgeSettings key={selection.id} id={selection.id} />}
      </div>
    </section>
  )
}
