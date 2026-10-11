import { examples } from "#examples"
import { Design, type Scenario } from "#simulator"
import type { Doc, Position } from "./types.ts"
import { createStore } from "../lib/store.ts"
import { containerAt, GROUP_DEFAULT, isContainer, rectOf, withDescendants } from "../canvas/groups.ts"
import { catalog } from "./engine.ts"

export type Selection = { readonly kind: "node" | "edge"; readonly id: string }

export interface DocState {
  readonly design: Doc
  readonly selection: Selection | undefined
  readonly past: ReadonlyArray<Doc>
  readonly future: ReadonlyArray<Doc>
  /** Bumped when the whole design is replaced, so the simulation restarts even if the structure is identical. */
  readonly epoch: number
}

// v2: designs saved by the earlier engine used different setting names.
const STORAGE_KEY = "sim:design:v2"
const HISTORY_LIMIT = 100

const loadSaved = (): Doc | undefined => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return undefined
    const parsed = Design.parse(JSON.parse(raw))
    return parsed.ok ? parsed.doc : undefined
  } catch {
    return undefined
  }
}

export const doc = createStore<DocState>({
  design: loadSaved() ?? examples[0]!.design(),
  selection: undefined,
  past: [],
  future: [],
  epoch: 0
})

const save = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(doc.get().design))
  } catch {
    // Storage may be full or blocked; the design simply isn't remembered.
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
doc.subscribe(() => {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(save, 400)
})
// Don't lose an edit made just before the tab closes.
window.addEventListener("pagehide", save)

// ---------------------------------------------------------------------------------------------------------
// Editing. Every edit goes through `commit` so undo/redo and selection housekeeping stay in one place.
// ---------------------------------------------------------------------------------------------------------

const valid = (design: Doc, selection: Selection | undefined): Selection | undefined => {
  if (selection === undefined) return undefined
  return (selection.kind === "node" ? design.nodes : design.edges)[selection.id] === undefined ? undefined : selection
}

let lastKey: string | undefined
let lastAt = 0

/** Apply an edit. Edits sharing a `key` within a second (typing, dragging a slider) collapse into one undo step. */
const commit = (edit: (design: Doc) => Doc, key?: string): void => {
  doc.set((s) => {
    const next = edit(s.design)
    if (next === s.design) return s
    const now = Date.now()
    const merge = key !== undefined && key === lastKey && now - lastAt < 1000
    lastKey = key
    lastAt = now
    return {
      ...s,
      design: next,
      selection: valid(next, s.selection),
      past: merge ? s.past : [...s.past, s.design].slice(-HISTORY_LIMIT),
      future: []
    }
  })
}

export const select = (selection: Selection | undefined): void =>
  doc.set((s) => (s.selection?.id === selection?.id && s.selection?.kind === selection?.kind ? s : { ...s, selection }))

export const undo = (): void =>
  doc.set((s) => {
    const previous = s.past[s.past.length - 1]
    if (previous === undefined) return s
    lastKey = undefined
    return { ...s, design: previous, selection: valid(previous, s.selection), past: s.past.slice(0, -1), future: [s.design, ...s.future] }
  })

export const redo = (): void =>
  doc.set((s) => {
    const next = s.future[0]
    if (next === undefined) return s
    lastKey = undefined
    return { ...s, design: next, selection: valid(next, s.selection), past: [...s.past, s.design], future: s.future.slice(1) }
  })

/** Replace the whole design (examples, import). Clears history and selection. */
export const replaceDesign = (design: Doc): void => {
  lastKey = undefined
  doc.set((s) => ({ design, selection: undefined, past: [], future: [], epoch: s.epoch + 1 }))
}

const uniqueName = (design: Doc, base: string): string => {
  const taken = new Set(Object.entries(design.nodes).map(([id, n]) => n.name ?? id))
  return Design.uniqueId((candidate) => taken.has(candidate), base).replace(/-(\d+)$/, " $1")
}

export const addNode = (type: string, position: Position): string => {
  const manifest = catalog.get().byType[type]
  const title = manifest?.title ?? type
  let created = ""
  commit((design) => {
    const added = Design.addNode(design, {
      type,
      name: uniqueName(design, title),
      position,
      ...(isContainer(manifest) ? { size: GROUP_DEFAULT } : {})
    })
    created = added.id
    return adopt(added.doc, created)
  })
  select({ kind: "node", id: created })
  return created
}

/**
 * Put a node in the container whose box it was dropped on, or take it out if it left every box. A container that
 * decides the region makes the node's own region redundant, so that is dropped.
 */
const adopt = (design: Doc, id: string): Doc => {
  const manifests = catalog.get().byType
  const node = design.nodes[id]
  if (node === undefined) return design
  const r = rectOf(node, manifests[node.type])
  const target = containerAt(design, manifests, id, { x: r.x + r.w / 2, y: r.y + Math.min(r.h / 2, 30) })
  if (target === node.parent) return design
  let next = Design.setParent(design, id, target)
  if (target !== undefined) {
    const decides = [target, ...Design.ancestors(next, target)].some((a) => manifests[next.nodes[a]?.type ?? ""]?.container?.decidesRegion)
    if (decides && next.nodes[id]?.region !== undefined) {
      const { region: _region, ...free } = next.nodes[id]!
      next = { ...next, nodes: { ...next.nodes, [id]: free } }
    }
  }
  return next
}

/** After a drag: re-home the node (and so its contents) by where it landed. */
export const settleNode = (id: string): void => doc.set((s) => {
  const next = adopt(s.design, id)
  return next === s.design ? s : { ...s, design: next, past: [...s.past, s.design].slice(-HISTORY_LIMIT), future: [] }
})

/** A drag: moves the node, and anything inside it, by the same distance. The first change pushes one undo step. */
export const beginMove = (id: string): ((dx: number, dy: number) => void) => {
  const start = doc.get().design
  const origin = new Map(withDescendants(start, id).map((member) => [member, start.nodes[member]?.position ?? { x: 0, y: 0 }]))
  let started = false
  return (dx, dy) =>
    doc.set((s) => {
      let next = s.design
      for (const [member, at] of origin) next = Design.moveNode(next, member, { x: Math.round(at.x + dx), y: Math.round(at.y + dy) })
      if (next === s.design) return s
      const first = !started
      started = true
      return { ...s, design: next, past: first ? [...s.past, s.design].slice(-HISTORY_LIMIT) : s.past, future: first ? [] : s.future }
    })
}

/** Resize a container. Coalesces into one undo step per drag. */
export const beginResize = (id: string): ((size: { w: number; h: number }) => void) => {
  let started = false
  return (size) =>
    doc.set((s) => {
      const next = Design.patchNode(s.design, id, { size })
      if (next === s.design) return s
      const first = !started
      started = true
      return { ...s, design: next, past: first ? [...s.past, s.design].slice(-HISTORY_LIMIT) : s.past, future: first ? [] : s.future }
    })
}

/** A node's own region, for nodes no container places. `undefined` falls back to the provider's default. */
export const setNodeRegion = (id: string, region: string | undefined): void =>
  commit((d) => {
    const node = d.nodes[id]
    if (node === undefined) return d
    const { region: _old, ...rest } = node
    return { ...d, nodes: { ...d.nodes, [id]: region === undefined ? rest : { ...rest, region } } }
  })

/** An account-level quota for a placement such as `aws:us-east-1`. */
export const setAccountSetting = (placement: string, path: ReadonlyArray<string>, value: unknown): void =>
  commit((d) => Design.setAccountSetting(d, placement, path, value), `account:${placement}:${path.join(".")}`)

export const resetAccount = (placement: string): void =>
  commit((d) => {
    const { [placement]: _gone, ...rest } = d.accounts ?? {}
    const { accounts: _accounts, ...others } = d
    return Object.keys(rest).length === 0 ? others : { ...others, accounts: rest }
  })

export const renameNode = (id: string, name: string): void =>
  commit((d) => Design.patchNode(d, id, { name }), `name:${id}`)

export const setNodeSetting = (id: string, path: ReadonlyArray<string>, value: unknown): void =>
  commit((d) => Design.setNodeSetting(d, id, path, value), `node:${id}:${path.join(".")}`)

export const setEdgeSetting = (id: string, path: ReadonlyArray<string>, value: unknown): void =>
  commit((d) => Design.setEdgeSetting(d, id, path, value), `edge:${id}:${path.join(".")}`)

/** Choose what sits on an edge, or with `undefined` go back to the one that fits best. */
export const setEdgeConnector = (id: string, connector: string | undefined): void => commit((d) => Design.setConnector(d, id, connector))

/** Attach a controller of `type` to a node. */
export const addController = (type: string, target: string): void => commit((d) => Design.addController(d, { type, target }).doc)

export const removeController = (id: string): void => commit((d) => Design.removeController(d, id))

export const setControllerSetting = (id: string, path: ReadonlyArray<string>, value: unknown): void =>
  commit((d) => Design.setControllerSetting(d, id, path, value), `controller:${id}:${path.join(".")}`)

export const resetNodeSettings = (id: string): void => commit((d) => Design.patchNode(d, id, { settings: {} }))

export const connect = (from: string, port: string, to: string): void => {
  let created: string | undefined
  commit((design) => {
    const exists = Object.values(design.edges).some((e) => e.from.node === from && Design.portOf(e) === port && e.to === to)
    if (exists || from === to) return design
    const added = Design.connect(design, { from: { node: from, port }, to })
    created = added.id
    return added.doc
  })
  if (created !== undefined) select({ kind: "edge", id: created })
}

export const removeSelection = (): void => {
  const selection = doc.get().selection
  if (selection === undefined) return
  commit((d) => (selection.kind === "node" ? Design.removeNode(d, selection.id) : Design.removeEdge(d, selection.id)))
}

export const setDesignName = (name: string): void => commit((d) => ({ ...d, name }), "design-name")

export const setSeed = (seed: number): void => commit((d) => ({ ...d, seed }), "design-seed")

export const applyLayout = (layout: (design: Doc) => Doc): void => commit(layout)

/** Replace the design's content with an edited version of it (the YAML editor), as one undoable edit. */
export const applyDesign = (next: Doc): void => commit(() => next)

// ---------------------------------------------------------------------------------------------------------
// Scenarios travel with the design (its `scenarios` section): adding or removing one is an edit like any other.
// ---------------------------------------------------------------------------------------------------------

/** Add a scenario to the design under an id made from its name. Returns the id. */
export const addScenario = (scenario: Scenario.Spec): string => {
  let created = ""
  commit((d) => {
    created = Design.uniqueId((candidate) => candidate in (d.scenarios ?? {}), Design.slug(scenario.name ?? "scenario"))
    return { ...d, scenarios: { ...d.scenarios, [created]: scenario } }
  })
  return created
}

export const removeScenario = (id: string): void =>
  commit((d) => {
    if (d.scenarios?.[id] === undefined) return d
    const { [id]: _removed, ...rest } = d.scenarios
    const { scenarios: _all, ...design } = d
    return Object.keys(rest).length === 0 ? design : { ...design, scenarios: rest }
  })
