import { Connector, Design } from "#simulator"
import type { ComponentManifest, Position } from "../state/types.ts"
import { useEffect, useMemo, useRef, useState } from "react"
import type { PointerEvent as ReactPointerEvent } from "react"
import { useStore } from "../lib/store.ts"
import { addNode, beginMove, beginResize, connect, doc, select, settleNode } from "../state/document.ts"
import { catalog, connectorOf, registry } from "../state/engine.ts"
import { run } from "../state/run.ts"
import { Arrowhead, EdgeView } from "./EdgeLayer.tsx"
import { NODE_W, edgePath, inPoint, nodeHeight, outPoint } from "./geometry.ts"
import { GroupView } from "./GroupView.tsx"
import { containersByDepth, GROUP_MIN, isContainer, regionOf } from "./groups.ts"
import { NodeView } from "./NodeView.tsx"
import * as viewport from "./viewport.ts"

export const PALETTE_MIME = "application/x-sim-component"

interface Ghost {
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
  readonly valid: boolean
}

type Gesture =
  | { readonly kind: "pan"; readonly startX: number; readonly startY: number; readonly origin: viewport.View; moved: boolean }
  | {
    readonly kind: "node"
    readonly id: string
    readonly startX: number
    readonly startY: number
    readonly move: (dx: number, dy: number) => void
    moved: boolean
  }
  | { readonly kind: "resize"; readonly id: string; readonly startX: number; readonly startY: number; readonly origin: { readonly w: number; readonly h: number }; readonly apply: (size: { w: number; h: number }) => void }
  | { readonly kind: "connect"; readonly node: string; readonly port: string }

const DRAG_THRESHOLD = 3

export function Canvas() {
  const design = useStore(doc, (s) => s.design)
  const selection = useStore(doc, (s) => s.selection)
  const manifests = useStore(catalog, (s) => s.byType)
  const diagnostics = useStore(run, (s) => s.diagnostics)
  const containerRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | undefined>(undefined)
  const [ghost, setGhost] = useState<Ghost | undefined>()
  const [panning, setPanning] = useState(false)

  // Apply pan/zoom straight to the DOM.
  useEffect(() => {
    const container = containerRef.current!
    const world = worldRef.current!
    viewport.attach(container)
    const apply = () => {
      const { x, y, k } = viewport.view.get()
      world.style.transform = `translate(${x}px, ${y}px) scale(${k})`
      world.style.setProperty("--k", String(k))
      let grid = 24 * k
      while (grid < 14) grid *= 2
      container.style.setProperty("--grid", `${grid}px`)
      container.style.setProperty("--gx", `${x}px`)
      container.style.setProperty("--gy", `${y}px`)
    }
    apply()
    const off = viewport.view.subscribe(apply)

    // Wheel: scroll pans, pinch (ctrl+wheel) and cmd/ctrl+wheel zoom around the cursor.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = container.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) viewport.zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.01))
      else if (e.shiftKey) viewport.panBy(-(e.deltaY || e.deltaX), 0)
      else viewport.panBy(-e.deltaX, -e.deltaY)
    }
    container.addEventListener("wheel", onWheel, { passive: false })
    return () => {
      off()
      container.removeEventListener("wheel", onWheel)
      viewport.attach(undefined)
    }
  }, [])

  const worstLevel = useMemo(() => {
    const rank = { error: 3, warning: 2, info: 1 } as const
    const out: Record<string, "error" | "warning" | "info"> = {}
    for (const d of diagnostics) {
      if (d.node === undefined) continue
      const current = out[d.node]
      if (current === undefined || rank[d.level] > rank[current]) out[d.node] = d.level
    }
    return out
  }, [diagnostics])

  // --- Pointer gestures -----------------------------------------------------------------------------------
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 1) return
    const target = e.target as Element
    const handle = target.closest<HTMLElement>("[data-port-node]")
    const nodeEl = target.closest<HTMLElement>("[data-node-id]")
    const edgeEl = target.closest<SVGElement>("[data-edge-id]")
    containerRef.current!.setPointerCapture(e.pointerId)

    const resizer = target.closest<HTMLElement>("[data-resize-id]")
    if (e.button === 0 && resizer !== null) {
      const id = resizer.dataset.resizeId!
      const spec = doc.get().design.nodes[id]
      const origin = spec?.size ?? { w: 560, h: 340 }
      gesture.current = { kind: "resize", id, startX: e.clientX, startY: e.clientY, origin, apply: beginResize(id) }
      select({ kind: "node", id })
      return
    }
    if (e.button === 0 && handle !== null) {
      const node = handle.dataset.portNode!
      gesture.current = { kind: "connect", node, port: handle.dataset.portName! }
      select({ kind: "node", id: node })
      return
    }
    if (e.button === 0 && nodeEl !== null) {
      const id = nodeEl.dataset.nodeId!
      gesture.current = { kind: "node", id, startX: e.clientX, startY: e.clientY, move: beginMove(id), moved: false }
      select({ kind: "node", id })
      return
    }
    if (e.button === 0 && edgeEl !== null) {
      select({ kind: "edge", id: edgeEl.dataset.edgeId! })
      gesture.current = undefined
      return
    }
    gesture.current = { kind: "pan", startX: e.clientX, startY: e.clientY, origin: viewport.view.get(), moved: false }
  }

  /** The node under `element`, if a wire from `from`'s `port` can go there: something must be able to sit between them. */
  const validTarget = (from: string, port: string, element: Element | null): string | undefined => {
    const id = element?.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId
    if (id === undefined || id === from) return undefined
    const design = doc.get().design
    const source = design.nodes[from]?.type
    const type = design.nodes[id]?.type
    if (source === undefined || type === undefined) return undefined
    return connectorOf({ type: source, port }, type) !== undefined ? id : undefined
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current
    if (g === undefined) return
    if (g.kind === "pan") {
      const dx = e.clientX - g.startX
      const dy = e.clientY - g.startY
      if (!g.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
      if (!g.moved) setPanning(true)
      g.moved = true
      viewport.view.set({ ...g.origin, x: g.origin.x + dx, y: g.origin.y + dy })
    } else if (g.kind === "node") {
      const k = viewport.view.get().k
      const dx = (e.clientX - g.startX) / k
      const dy = (e.clientY - g.startY) / k
      if (!g.moved && Math.hypot(dx, dy) * k < DRAG_THRESHOLD) return
      g.moved = true
      g.move(dx, dy)
    } else if (g.kind === "resize") {
      const k = viewport.view.get().k
      g.apply({
        w: Math.max(GROUP_MIN.w, Math.round(g.origin.w + (e.clientX - g.startX) / k)),
        h: Math.max(GROUP_MIN.h, Math.round(g.origin.h + (e.clientY - g.startY) / k))
      })
    } else {
      const design = doc.get().design
      const node = design.nodes[g.node]
      if (node === undefined) return
      const from = outPoint(node, manifests[node.type], g.port)
      const to = viewport.toWorld(e.clientX, e.clientY)
      const over = document.elementFromPoint(e.clientX, e.clientY)
      setGhost({ x1: from.x, y1: from.y, x2: to.x, y2: to.y, valid: validTarget(g.node, g.port, over) !== undefined })
    }
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current
    gesture.current = undefined
    setPanning(false)
    if (g === undefined) return
    if (g.kind === "pan" && !g.moved) select(undefined)
    if (g.kind === "node" && g.moved) settleNode(g.id)
    if (g.kind === "connect") {
      setGhost(undefined)
      const target = validTarget(g.node, g.port, document.elementFromPoint(e.clientX, e.clientY))
      if (target !== undefined) connect(g.node, g.port, target)
    }
  }

  // --- Dropping components from the palette ---------------------------------------------------------------
  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(PALETTE_MIME)) {
      e.preventDefault()
      e.dataTransfer.dropEffect = "copy"
    }
  }
  const onDrop = (e: React.DragEvent) => {
    const type = e.dataTransfer.getData(PALETTE_MIME)
    if (type === "") return
    e.preventDefault()
    const at = viewport.toWorld(e.clientX, e.clientY)
    const box = isContainer(manifests[type])
    addNode(type, box ? { x: Math.round(at.x - 40), y: Math.round(at.y - 18) } : { x: Math.round(at.x - NODE_W / 2), y: Math.round(at.y - nodeHeight(manifests[type]) / 2) })
  }

  const nodeEntries = Object.entries(design.nodes).filter(([, spec]) => !isContainer(manifests[spec.type]))
  const groups = containersByDepth(design, manifests)
  const edgeEntries = Object.entries(design.edges)

  return (
    <div
      ref={containerRef}
      className="canvas"
      data-panning={panning || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div ref={worldRef} className="world">
        {groups.map((id) => {
          const spec = design.nodes[id]!
          const manifest = manifests[spec.type]
          const { region } = regionOf(design, manifests, (p) => registry.provider(p)?.defaultRegion, id)
          const provider = registry.provider(manifest?.provider ?? "")
          const regionName = provider?.regions.find((r) => r.id === region)?.name
          const detail = manifest?.container?.decidesRegion
            ? `${region ?? "?"}${regionName === undefined ? "" : ` · ${regionName}`}`
            : `${region ?? ""} · IPv4 /${(spec.settings as { cidrPrefix?: number } | undefined)?.cidrPrefix ?? 16}`
          return (
            <GroupView
              key={id}
              id={id}
              spec={spec}
              manifest={manifest}
              selected={selection?.kind === "node" && selection.id === id}
              placement={manifest === undefined || region === undefined ? undefined : `${manifest.provider}:${region}`}
              detail={detail}
              level={worstLevel[id]}
            />
          )
        })}
        <svg className="edges" width="1" height="1">
          <Arrowhead />
          {edgeEntries.map(([id, edge]) => {
            const from = design.nodes[edge.from.node]
            const to = design.nodes[edge.to]
            if (from === undefined || to === undefined) return null
            const port = Design.portOf(edge)
            const a = outPoint(from, manifests[from.type], port)
            const b = inPoint(to, manifests[to.type])
            // Anything but a plain link is something between the two nodes, drawn on the line.
            const between = connectorOf({ type: from.type, port }, to.type, edge.connector)?.connector
            const connector = between === undefined || Connector.isPlain(between.type) ? undefined : between
            return <EdgeView key={id} id={id} a={a} b={b} selected={selection?.kind === "edge" && selection.id === id} label={edge.name} connector={connector} />
          })}
          {ghost !== undefined && (
            <path className="edge-ghost" data-valid={ghost.valid || undefined} d={edgePath({ x: ghost.x1, y: ghost.y1 }, { x: ghost.x2, y: ghost.y2 })} />
          )}
        </svg>
        {nodeEntries.map(([id, spec]) => (
          <NodeView
            key={id}
            id={id}
            spec={spec}
            manifest={manifests[spec.type] as ComponentManifest | undefined}
            selected={selection?.kind === "node" && selection.id === id}
            level={worstLevel[id]}
          />
        ))}
      </div>
      {nodeEntries.length === 0 && (
        <div className="empty-hint">
          <b>An empty canvas</b>
          <span>Drag a component in from the sidebar, or pick an example there.</span>
        </div>
      )}
    </div>
  )
}
