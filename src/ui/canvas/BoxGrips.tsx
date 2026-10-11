import { ViewportPortal } from "@xyflow/react"
import { useRef } from "react"
import type { PointerEvent } from "react"
import { useStore } from "../lib/store.ts"
import { beginResize, doc, select } from "../state/document.ts"
import { catalog } from "../state/engine.ts"
import { GROUP_DEFAULT, GROUP_MIN, isContainer } from "./groups.ts"
import { view } from "./viewport.ts"

/**
 * The resize corners of the boxes. A box is drawn behind the wires and the nodes, so anything placed inside it (a node
 * near its corner, a node's handles) could cover a corner drawn as part of it; these are drawn in a layer above
 * everything instead, at each box's bottom-right corner, at one size on screen whatever the zoom.
 */
export function BoxGrips() {
  const nodes = useStore(doc, (s) => s.design.nodes)
  const manifests = useStore(catalog, (s) => s.byType)
  return (
    <ViewportPortal>
      {Object.entries(nodes).flatMap(([id, node]) => {
        const manifest = manifests[node.type]
        if (!isContainer(manifest)) return []
        const at = node.position ?? { x: 0, y: 0 }
        const size = node.size ?? GROUP_DEFAULT
        return [<Grip key={id} id={id} x={at.x + size.w} y={at.y + size.h} size={size} accent={manifest?.accent ?? "#8893a5"} />]
      })}
    </ViewportPortal>
  )
}

function Grip({ id, x, y, size, accent }: { id: string; x: number; y: number; size: { w: number; h: number }; accent: string }) {
  // One resize is one undo step.
  const resizing = useRef<{ readonly x: number; readonly y: number; readonly size: { w: number; h: number }; readonly apply: (size: { w: number; h: number }) => void } | undefined>(undefined)
  const onPointerDown = (e: PointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    resizing.current = { x: e.clientX, y: e.clientY, size, apply: beginResize(id) }
    select({ kind: "node", id })
  }
  const onPointerMove = (e: PointerEvent<HTMLSpanElement>) => {
    const r = resizing.current
    if (r === undefined) return
    const k = view.get().k
    r.apply({
      w: Math.max(GROUP_MIN.w, Math.round(r.size.w + (e.clientX - r.x) / k)),
      h: Math.max(GROUP_MIN.h, Math.round(r.size.h + (e.clientY - r.y) / k))
    })
  }
  const onPointerUp = () => {
    resizing.current = undefined
  }
  return (
    <span
      className="group-resize nopan nodrag"
      data-resize-id={id}
      title="Drag to resize"
      style={{ left: x, top: y, ["--accent" as string]: accent }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  )
}
