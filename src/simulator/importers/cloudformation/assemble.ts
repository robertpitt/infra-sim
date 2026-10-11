import { Schema } from "effect"
import { type AnyComponent, edgeConfigFor, type PortDefs } from "../../Component.ts"
import * as Design from "../../Design.ts"
import { fields as describeFields, type FieldSpec } from "../../Describe.ts"
import * as Layout from "../../Layout.ts"
import type { Components } from "../../Registry.ts"
import { type Bag, type Draft, type Run, SOURCE, type Wire } from "./model.ts"

/**
 * From the finished `Run` to a design: every setting is checked against its component's schema and clamped to its
 * range, the nodes are put in boxes (a region per region used, a VPC inside its region), the edges are drawn, and the
 * result is laid out.
 */

// ---------------------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------------------

/**
 * Check one setting against the schema it will be decoded with. A number outside its range is brought into it, a
 * fraction rounded for a whole-number setting, and anything the schema still refuses is dropped; each is reported.
 * `who` says whose setting it is, for the report. Returns the value to write, or `undefined` to keep the default.
 */
const fitSetting = (run: Run, schema: Schema.Top, specs: ReadonlyArray<FieldSpec>, who: string, path: ReadonlyArray<string>, original: unknown, label: string): unknown => {
  const spec = path.reduce<FieldSpec | undefined>((found, key, i) => {
    const list = i === 0 ? specs : found?.kind === "group" ? found.fields : []
    return list.find((f) => f.key === key)
  }, undefined)
  let value = original
  // Durations are written as text ("120 seconds"); compare them in the milliseconds the form describes them in.
  const text = typeof value === "string" ? /^(\d+(?:\.\d+)?) (seconds|millis)$/.exec(value) : null
  if (spec?.kind === "duration" && text !== null) {
    const ms = Number(text[1]) * (text[2] === "seconds" ? 1000 : 1)
    const clamped = Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, ms))
    if (clamped !== ms) {
      run.adjusted.push(`${who}: ${label} ${value} is outside the ${spec.min ?? "…"} to ${spec.max ?? "…"} ms the simulator accepts; using ${clamped} ms`)
      value = `${clamped} millis`
    }
  } else if (spec !== undefined && (spec.kind === "int" || spec.kind === "number") && typeof value === "number") {
    let n = value
    if (spec.kind === "int" && !Number.isInteger(n)) {
      n = Math.round(n)
      run.adjusted.push(`${who}: ${label} ${value} has to be a whole number; using ${n}`)
    }
    const clamped = Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, n))
    if (clamped !== n) {
      run.adjusted.push(`${who}: ${label} ${n} is outside the ${spec.min ?? "…"} to ${spec.max ?? "…"} the simulator accepts; using ${clamped}`)
      n = clamped
    }
    value = n
  }
  const probe = path.reduceRight<unknown>((inner, key) => ({ [key]: inner }), value)
  const decoded = Schema.decodeUnknownResult(schema as Schema.Decoder<unknown>)(probe)
  if (decoded._tag === "Failure") {
    run.adjusted.push(`${who}: ${label} = ${JSON.stringify(original)} isn't accepted (${String(decoded.failure).split("\n")[0]}); kept the default`)
    return undefined
  }
  return value
}

const setIn = (target: Bag, path: ReadonlyArray<string>, value: unknown): void => {
  let at = target
  for (const key of path.slice(0, -1)) at = (at[key] ??= {}) as Bag
  at[path[path.length - 1]!] = value
}

/** The values of nested settings with the path to each: `{ retry: { backoff: 1 } }` is `retry.backoff`. */
const leaves = (settings: Bag, prefix: ReadonlyArray<string> = []): ReadonlyArray<{ readonly path: ReadonlyArray<string>; readonly value: unknown }> =>
  Object.entries(settings).flatMap(([key, value]) =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? leaves(value as Bag, [...prefix, key]) : [{ path: [...prefix, key], value }]
  )

// ---------------------------------------------------------------------------------------------------------
// Layout that respects boxes
// ---------------------------------------------------------------------------------------------------------

interface Rect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** The room `Layout.fitContainers` leaves between a box and what is in it (it doesn't export it). */
const BOX_PAD = 28

const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/**
 * A NAT gateway or endpoint with nothing wired to it is, to `autoLayout`, a source of traffic, so it lands in the column
 * of the callers and drags its VPC's box across the canvas. Such members are moved under the VPC's connected ones instead.
 */
const tuckUnwiredMembers = (doc: Design.Doc, registry: Components): Design.Doc => {
  const wired = new Set(Object.values(doc.edges).flatMap((e) => [e.from.node, e.to]))
  const heightOf = (id: string) => Layout.nodeHeight(Object.keys(registry.get(doc.nodes[id]!.type)?.ports ?? {}).length)
  const leaf = (id: string) => registry.get(doc.nodes[id]!.type)?.container === undefined
  const nodes = { ...doc.nodes }
  const holders = new Set(Object.values(doc.nodes).flatMap((n) => (n.parent !== undefined && doc.nodes[n.parent]?.parent !== undefined ? [n.parent] : [])))
  for (const holder of holders) {
    const members = Object.keys(doc.nodes).filter((id) => doc.nodes[id]!.parent === holder && leaf(id))
    const anchors = members.filter((id) => wired.has(id))
    const loose = members.filter((id) => !wired.has(id))
    if (anchors.length === 0 || loose.length === 0) continue
    const x = Math.min(...anchors.map((id) => nodes[id]!.position?.x ?? 0))
    let y = Math.max(...anchors.map((id) => (nodes[id]!.position?.y ?? 0) + heightOf(id))) + 30
    for (const id of loose) {
      nodes[id] = { ...nodes[id]!, position: { x, y } }
      y += heightOf(id) + 30
    }
  }
  return { ...doc, nodes }
}

/** Whether `id` is `holder` or sits anywhere inside it. */
const within = (doc: Design.Doc, id: string, holder: string): boolean => id === holder || Design.ancestors(doc, id).includes(holder)

/**
 * `Layout.autoLayout` places nodes by their place in the traffic flow and knows nothing of boxes, so the box that
 * `fitContainers` draws round a container's members can swallow a node that isn't one of them: a client or external
 * service in the same column, or something in another region. Nodes that are in the way are moved down their own column
 * to the next free place, which keeps the left-to-right flow and clears the box.
 */
const clearContainers = (doc: Design.Doc, registry: Components): Design.Doc => {
  const isContainer = (id: string) => registry.get(doc.nodes[id]!.type)?.container !== undefined
  const leafIds = Object.keys(doc.nodes).filter((id) => !isContainer(id))
  const holders = Object.keys(doc.nodes).filter((id) => isContainer(id) && leafIds.some((leaf) => within(doc, leaf, id) && leaf !== id))
  const rectOf = (nodes: Design.Doc["nodes"], id: string): Rect => {
    const at = nodes[id]!.position ?? { x: 0, y: 0 }
    return { x: at.x, y: at.y, w: Layout.NODE_W, h: Layout.nodeHeight(Object.keys(registry.get(nodes[id]!.type)?.ports ?? {}).length) }
  }
  let nodes = doc.nodes
  for (let pass = 0; pass < 12; pass++) {
    let moved = false
    for (const holder of holders) {
      const inside = leafIds.filter((id) => within(doc, id, holder))
      const rects = inside.map((id) => rectOf(nodes, id))
      const left = Math.min(...rects.map((r) => r.x)) - BOX_PAD
      const top = Math.min(...rects.map((r) => r.y)) - BOX_PAD - Layout.BOX_HEAD_H
      const right = Math.max(...rects.map((r) => r.x + r.w)) + BOX_PAD
      const bottom = Math.max(...rects.map((r) => r.y + r.h)) + BOX_PAD
      const box: Rect = { x: left, y: top, w: right - left, h: bottom - top }
      for (const id of leafIds) {
        if (inside.includes(id) || !overlaps(rectOf(nodes, id), box)) continue
        const here = rectOf(nodes, id)
        // Something outside every box (a traffic source) in the left half of the box steps out to the left, keeping its height
        // and so its line to what it calls; anything else goes down its own column, clear of this box and of every other node.
        const stepsLeft = nodes[id]!.parent === undefined && here.x + here.w / 2 < box.x + box.w / 2
        const x = stepsLeft ? box.x - here.w - 40 : here.x
        let y = stepsLeft ? here.y : bottom + 40
        while (leafIds.some((other) => other !== id && overlaps({ ...here, x, y }, rectOf(nodes, other)))) y += Layout.PORT_H * 6
        nodes = { ...nodes, [id]: { ...nodes[id]!, position: { x, y } } }
        moved = true
      }
    }
    if (!moved) break
  }
  return { ...doc, nodes }
}

/**
 * Regions are boxes of their own, and the layout, which only sees the traffic flow, would weave the nodes of one
 * region between those of another. Each region's nodes are moved together into a band of their own, one below the
 * other, the stack's own region on top; their columns are kept, so the flow still reads left to right.
 */
const separateRegions = (doc: Design.Doc, registry: Components): Design.Doc => {
  const regions = Object.keys(doc.nodes).filter((id) => registry.get(doc.nodes[id]!.type)?.container !== undefined && doc.nodes[id]!.parent === undefined)
  if (regions.length < 2) return doc
  const leaves = (region: string) => Object.keys(doc.nodes).filter((id) => registry.get(doc.nodes[id]!.type)?.container === undefined && Design.ancestors(doc, id).includes(region))
  const heightOf = (id: string) => Layout.nodeHeight(Object.keys(registry.get(doc.nodes[id]!.type)?.ports ?? {}).length)
  const nodes = { ...doc.nodes }
  let cursor = -Infinity
  for (const region of regions) {
    const members = leaves(region)
    if (members.length === 0) continue
    const top = Math.min(...members.map((id) => nodes[id]!.position?.y ?? 0))
    const shift = cursor === -Infinity ? 0 : Math.max(0, cursor + 2 * BOX_PAD + Layout.BOX_HEAD_H + 40 - top)
    for (const id of members) {
      const at = nodes[id]!.position ?? { x: 0, y: 0 }
      nodes[id] = { ...nodes[id]!, position: { x: at.x, y: at.y + shift } }
    }
    cursor = Math.max(...members.map((id) => (nodes[id]!.position?.y ?? 0) + heightOf(id)))
  }
  return { ...doc, nodes }
}

/**
 * A container with nothing in it has no members to hug, so `fitContainers` leaves it alone and it would sit at the
 * canvas origin. Such boxes are placed in a row under everything else.
 */
const placeEmptyContainers = (doc: Design.Doc, registry: Components): Design.Doc => {
  const containers = Object.keys(doc.nodes).filter((id) => registry.get(doc.nodes[id]!.type)?.container !== undefined)
  const empty = containers.filter((id) => doc.nodes[id]!.position === undefined && !Object.values(doc.nodes).some((n) => n.parent === id) && doc.nodes[id]!.parent !== undefined)
  if (empty.length === 0) return doc
  const placed = Object.values(doc.nodes).flatMap((n) => (n.position === undefined ? [] : [n.position]))
  const bottom = placed.length === 0 ? 80 : Math.max(...placed.map((p) => p.y)) + 160
  const nodes = { ...doc.nodes }
  empty.forEach((id, i) => {
    nodes[id] = { ...nodes[id]!, position: { x: 80 + i * 600, y: bottom }, size: { w: 560, h: 340 } }
  })
  return { ...doc, nodes }
}

// ---------------------------------------------------------------------------------------------------------
// The design
// ---------------------------------------------------------------------------------------------------------

export interface Assembly {
  readonly doc: Design.Doc
  /** Settings carried over from the template, on nodes and edges. */
  readonly preserved: number
}

export const assemble = (run: Run, registry: Components, name: string): Assembly => {
  let doc: Design.Doc = { version: 1, name, seed: 1, nodes: {}, edges: {} }

  // A box for the region the stack is in, and one for each other region something is placed in (a replica of a global table).
  const regionsUsed = [...new Set([...run.drafts.values()].filter((d) => d.type.startsWith("aws.") && d.parent === undefined).map((d) => d.region ?? run.options.region))]
  const hasAws = [...run.drafts.values()].some((d) => d.type.startsWith("aws."))
  if (hasAws && !regionsUsed.includes(run.options.region)) regionsUsed.unshift(run.options.region)
  const boxes = new Map<string, string>()
  for (const region of regionsUsed.sort((a, b) => (a === run.options.region ? -1 : b === run.options.region ? 1 : a.localeCompare(b)))) {
    const added = Design.addNode(doc, { id: `aws-${region}`, type: "aws.region", name: region, settings: { region }, origin: { source: SOURCE, ref: "(import)", type: "Region" } })
    doc = added.doc
    boxes.set(region, added.id)
    run.added.push(
      region === run.options.region
        ? `An aws.region box for ${region}: everything AWS runs inside it. Move it to another region in its settings.`
        : `An aws.region box for ${region}, where part of the template runs.`
    )
  }

  let preserved = 0
  const regionBox = (d: Draft): string | undefined => (d.type.startsWith("aws.") ? boxes.get(d.region ?? run.options.region) : undefined)
  for (const d of run.drafts.values()) {
    const component = registry.get(d.type)!
    const specs = describeFields(component.config)
    const settings: Bag = {}
    for (const s of d.settings) {
      const value = fitSetting(run, component.config, specs, d.name, s.path, s.value, s.label)
      if (value !== undefined) {
        setIn(settings, s.path, value)
        preserved++
      }
    }
    const parent = d.parent !== undefined ? d.parent.id : regionBox(d)
    doc = Design.addNode(doc, {
      id: d.id,
      type: d.type,
      name: d.name,
      ...(parent === undefined ? {} : { parent }),
      ...(Object.keys(settings).length > 0 ? { settings } : {}),
      ...(d.origin === undefined ? {} : { origin: d.origin })
    }).doc
  }

  // Edges. A single-connection port keeps the first and says so.
  const singles = new Map<string, number>()
  for (const w of run.wires) {
    const component = registry.get(w.from.type)
    const def = (component?.ports as PortDefs | undefined)?.[w.port]
    if (component === undefined || def === undefined) {
      run.warn(`${w.from.name} has no "${w.port}" output in this simulator, so its connection to ${w.to.name} isn't drawn.`)
      continue
    }
    if (!def.many) {
      const key = `${w.from.id}:${w.port}`
      if ((singles.get(key) ?? 0) >= 1) {
        run.warn(`${w.from.name}'s ${def.label ?? w.port} can only go to one place; ${w.to.name} was left out.`)
        continue
      }
      singles.set(key, 1)
    }
    const settings = edgeSettings(run, component, w)
    preserved += leaves(settings).length
    doc = Design.connect(doc, {
      from: { node: w.from.id, port: w.port },
      to: w.to.id,
      ...(w.name === undefined ? {} : { name: w.name }),
      ...(Object.keys(settings).length > 0 ? { settings } : {}),
      ...(w.origin === undefined ? {} : { origin: w.origin })
    }).doc
  }

  doc = Layout.autoLayout(doc, registry)
  doc = clearContainers(separateRegions(tuckUnwiredMembers(doc, registry), registry), registry)
  doc = placeEmptyContainers(doc, registry)
  doc = Layout.fitContainers(doc, registry)

  // The design must be one the simulator accepts; anything it still objects to is reported, not hidden.
  const check = Design.resolve(doc, registry)
  for (const diagnostic of check.diagnostics) if (diagnostic.level === "error") run.warn(diagnostic.message)
  return { doc, preserved }
}

/** An edge's settings, each checked against the universal edge policy plus the settings of the port it leaves. */
const edgeSettings = (run: Run, component: AnyComponent, w: Wire): Bag => {
  const schema = edgeConfigFor(component, w.port)
  const specs = describeFields(schema)
  const out: Bag = {}
  for (const { path, value } of leaves(w.settings)) {
    const fitted = fitSetting(run, schema, specs, `${w.from.name} → ${w.to.name}`, path, value, path.join("."))
    if (fitted !== undefined) setIn(out, path, fitted)
  }
  return out
}
