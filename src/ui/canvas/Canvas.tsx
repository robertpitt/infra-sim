import {
  Background,
  BackgroundVariant,
  type Connection,
  type ConnectionLineComponentProps,
  MiniMap,
  type NodeChange,
  type OnConnectEnd,
  type OnConnectStart,
  type OnNodeDrag,
  ReactFlow,
  type XYPosition
} from "@xyflow/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { DragEvent } from "react"
import { useStore } from "../lib/store.ts"
import { addNode, beginMove, connect, doc, select, settleNode } from "../state/document.ts"
import { catalog, connectorOf } from "../state/engine.ts"
import { run } from "../state/run.ts"
import { openSettings } from "../state/ui.ts"
import { BoxGrips } from "./BoxGrips.tsx"
import { Arrowheads, EdgeView } from "./EdgeLayer.tsx"
import { edgesOf, type FlowEdge, type FlowNode, type Level, type Measured, memo, nodesOf } from "./flow.ts"
import { edgePath, NODE_W, nodeHeight } from "./geometry.ts"
import { GroupView } from "./GroupView.tsx"
import { isContainer, rectOf } from "./groups.ts"
import { NodeView } from "./NodeView.tsx"
import { pathThrough } from "./path.ts"
import * as viewport from "./viewport.ts"

export const PALETTE_MIME = "application/x-sim-component"

const nodeTypes = { component: NodeView, container: GroupView }
const edgeTypes = { traffic: EdgeView }

/** Whether a wire from `from`'s `port` can end at `to`: something must be able to sit between them. */
const validTarget = (from: string, port: string, to: string | undefined): to is string => {
  if (to === undefined || to === from) return false
  const design = doc.get().design
  const source = design.nodes[from]?.type
  const target = design.nodes[to]?.type
  return source !== undefined && target !== undefined && connectorOf({ type: source, port }, target) !== undefined
}

/** The component (not a container) under a point in world space. */
const componentAt = (at: XYPosition): string | undefined => {
  const { design } = doc.get()
  const manifests = catalog.get().byType
  for (const [id, node] of Object.entries(design.nodes)) {
    const manifest = manifests[node.type]
    if (isContainer(manifest)) continue
    const r = rectOf(node, manifest)
    if (at.x >= r.x && at.x <= r.x + r.w && at.y >= r.y && at.y <= r.y + r.h) return id
  }
  return undefined
}

/** Where a mouse or touch event happened, on screen. */
const pointOf = (event: MouseEvent | TouchEvent): { readonly clientX: number; readonly clientY: number } | undefined =>
  "touches" in event ? (event.touches[0] ?? event.changedTouches[0]) : event

/** The wire being drawn: blue once it is over something it can connect to. */
function Ghost({ fromX, fromY, toX, toY, fromNode, fromHandle, toNode }: ConnectionLineComponentProps<FlowNode>) {
  const over = toNode?.id ?? componentAt({ x: toX, y: toY })
  const valid = validTarget(fromNode.id, fromHandle.id ?? "out", over)
  return <path className="edge-ghost" data-valid={valid || undefined} d={edgePath({ x: fromX, y: fromY }, { x: toX, y: toY })} />
}

/**
 * The canvas, on React Flow. The document is the source of truth: nodes and edges are derived from it, and what React
 * Flow reports (a drag, a resize, a wire drawn) becomes an edit to it, so undo, saving and the running simulation all
 * follow. Selection is the document's too: one node or one connection, which also lights up the path it is on.
 */
export function Canvas() {
  const design = useStore(doc, (s) => s.design)
  const selection = useStore(doc, (s) => s.selection)
  const manifests = useStore(catalog, (s) => s.byType)
  const diagnostics = useStore(run, (s) => s.diagnostics)
  const container = useRef<HTMLDivElement>(null)

  // What React Flow measured, handed back on every node: without it, a node whose object changes is measured again.
  const measured = useRef(new Map<string, Measured>())
  const [measuredVersion, setMeasuredVersion] = useState(0)
  const [nodeCache] = useState(() => memo<FlowNode>())
  const [edgeCache] = useState(() => memo<FlowEdge>())

  // Selecting something lights up the path it is part of and the rest of the design steps back. `edges` keeps its
  // identity while nodes are dragged, so this is only recomputed when the wiring or the selection changes.
  const focus = useMemo(() => pathThrough(design.edges, selection), [design.edges, selection])

  const levels = useMemo(() => {
    const rank = { error: 3, warning: 2, info: 1 } as const
    const out: Record<string, Level> = {}
    for (const d of diagnostics) {
      if (d.node === undefined) continue
      const current = out[d.node]
      if (current === undefined || rank[d.level] > rank[current]) out[d.node] = d.level
    }
    return out
  }, [diagnostics])

  // biome-ignore lint/correctness/useExhaustiveDependencies: `measuredVersion` is the signal that `measured` changed.
  const nodes = useMemo(
    () => nodesOf({ design, manifests, selection, focus, levels, measured: measured.current }, nodeCache),
    [design, manifests, selection, focus, levels, measuredVersion, nodeCache]
  )
  const edges = useMemo(() => edgesOf({ design, selection, focus }, edgeCache), [design, selection, focus, edgeCache])

  // The zoom, for things drawn at a constant size on screen (a box's resize corner).
  useEffect(() => {
    const apply = () => container.current?.style.setProperty("--k", String(viewport.view.get().k))
    apply()
    return viewport.view.subscribe(apply)
  }, [])
  useEffect(() => () => viewport.attach(undefined), [])

  // --- Dragging ------------------------------------------------------------------------------------------
  // A drag moves the node, and anything inside it, by how far the pointer has gone since it went down (React Flow
  // would count from where the drag threshold was crossed, and the node would trail the pointer); one drag is one
  // undo step.
  const down = useRef<XYPosition>({ x: 0, y: 0 })
  const drag = useRef<{ readonly id: string; readonly move: (dx: number, dy: number) => void; moved: boolean } | undefined>(undefined)

  const onNodeDragStart: OnNodeDrag<FlowNode> = useCallback((_, node) => {
    select({ kind: "node", id: node.id })
    drag.current = { id: node.id, move: beginMove(node.id), moved: false }
  }, [])

  const onNodeDrag: OnNodeDrag<FlowNode> = useCallback((event) => {
    const d = drag.current
    if (d === undefined) return
    const point = pointOf(event)
    if (point === undefined) return
    const k = viewport.view.get().k
    const dx = (point.clientX - down.current.x) / k
    const dy = (point.clientY - down.current.y) / k
    d.moved = true
    d.move(dx, dy)
  }, [])

  const onNodeDragStop: OnNodeDrag<FlowNode> = useCallback(() => {
    const d = drag.current
    drag.current = undefined
    // Dropped inside a box, it now belongs to it; dragged out of every box, it belongs to none.
    if (d?.moved) settleNode(d.id)
  }, [])

  const onNodesChange = useCallback((changes: Array<NodeChange<FlowNode>>) => {
    let grew = false
    for (const change of changes) {
      if (change.type === "dimensions" && change.dimensions !== undefined && !change.resizing) {
        const before = measured.current.get(change.id)
        if (before?.width === change.dimensions.width && before.height === change.dimensions.height) continue
        measured.current.set(change.id, change.dimensions)
        grew = true
      }
      // Positions follow the pointer (`onNodeDrag`), and selection and removal are the document's: clicks and the
      // keyboard handle them, not React Flow.
    }
    if (grew) setMeasuredVersion((v) => v + 1)
  }, [])

  // --- Connecting ------------------------------------------------------------------------------------------
  // A wire can be dropped anywhere on the node it goes to, not only on its handle.
  const onConnectStart: OnConnectStart = useCallback((_, { nodeId }) => {
    if (nodeId !== null) select({ kind: "node", id: nodeId })
  }, [])

  const onConnectEnd: OnConnectEnd = useCallback((event, state) => {
    if (state.fromNode === null || state.fromHandle === null) return
    const point = pointOf(event)
    const over = state.toNode?.id ?? (point === undefined ? undefined : componentAt(viewport.toWorld(point.clientX, point.clientY)))
    const port = state.fromHandle.id ?? "out"
    if (validTarget(state.fromNode.id, port, over)) connect(state.fromNode.id, port, over)
  }, [])

  const isValidConnection = useCallback((c: Connection | FlowEdge) => validTarget(c.source, c.sourceHandle ?? "out", c.target), [])

  // --- Dropping components from the sidebar ----------------------------------------------------------------
  const onDragOver = useCallback((e: DragEvent) => {
    if (e.dataTransfer.types.includes(PALETTE_MIME)) {
      e.preventDefault()
      e.dataTransfer.dropEffect = "copy"
    }
  }, [])
  const onDrop = useCallback((e: DragEvent) => {
    const type = e.dataTransfer.getData(PALETTE_MIME)
    if (type === "") return
    e.preventDefault()
    const at = viewport.toWorld(e.clientX, e.clientY)
    const manifest = catalog.get().byType[type]
    addNode(type, isContainer(manifest) ? { x: Math.round(at.x - 40), y: Math.round(at.y - 18) } : { x: Math.round(at.x - NODE_W / 2), y: Math.round(at.y - nodeHeight(manifest) / 2) })
  }, [])

  const empty = nodes.every((n) => n.type === "container")
  const initial = viewport.view.get()

  return (
    <div
      ref={container}
      className="canvas"
      data-focus={focus !== undefined || undefined}
      onPointerDownCapture={(e) => {
        down.current = { x: e.clientX, y: e.clientY }
      }}
    >
      <Arrowheads />
      <ReactFlow<FlowNode, FlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={(_, node) => select({ kind: "node", id: node.id })}
        onEdgeClick={(_, edge) => select({ kind: "edge", id: edge.id })}
        // A double-click opens the settings, as the gear on a selected node or connection does.
        onNodeDoubleClick={(_, node) => {
          select({ kind: "node", id: node.id })
          openSettings()
        }}
        onEdgeDoubleClick={(_, edge) => {
          select({ kind: "edge", id: edge.id })
          openSettings()
        }}
        onPaneClick={() => select(undefined)}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        connectionLineComponent={Ghost}
        connectionRadius={28}
        onInit={(instance) => viewport.attach(container.current ?? undefined, instance)}
        onMove={(_, v) => viewport.moved(v)}
        defaultViewport={{ x: initial.x, y: initial.y, zoom: initial.k }}
        minZoom={viewport.MIN_ZOOM}
        maxZoom={viewport.MAX_ZOOM}
        // Scroll and two-finger drag pan, pinch or ⌘-scroll zoom: a trackpad behaves as it does in design tools.
        panOnScroll
        panOnScrollSpeed={1}
        zoomOnScroll={false}
        zoomOnPinch
        zoomOnDoubleClick={false}
        panOnDrag={[0, 1]}
        // The app's own shortcuts own the keyboard (Space plays and pauses, Delete removes the selection).
        panActivationKeyCode={null}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        disableKeyboardA11y
        selectNodesOnDrag={false}
        // Boxes behind wires, wires behind components, whatever is selected.
        zIndexMode="manual"
        elevateNodesOnSelect={false}
        nodeDragThreshold={3}
        colorMode="dark"
        attributionPosition="bottom-left"
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.6} color="#273142" />
        <BoxGrips />
        <MiniMap<FlowNode>
          className="minimap"
          style={{ width: 176, height: 116 }}
          pannable
          zoomable
          ariaLabel="Overview of the design"
          nodeColor={(n) => (n.type === "container" ? "transparent" : (n.data.manifest?.accent ?? "#8893a5"))}
          nodeStrokeColor={(n) => (n.type === "container" ? (n.data.manifest?.accent ?? "#8893a5") : "transparent")}
          nodeStrokeWidth={6}
          nodeBorderRadius={10}
          maskColor="rgba(5, 8, 12, 0.6)"
          bgColor="#0e131b"
        />
      </ReactFlow>
      {empty && (
        <div className="empty-hint">
          <b>An empty canvas</b>
          <span>Drag a component in from the sidebar, or pick an example there.</span>
        </div>
      )}
    </div>
  )
}
