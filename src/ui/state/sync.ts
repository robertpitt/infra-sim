import type { Doc } from "./types.ts"
import { doc } from "./document.ts"
import { catalog, client, onReload } from "./engine.ts"
import { run } from "./run.ts"

/**
 * Keeps the running simulation in step with the document being edited.
 *  - Structural edits (nodes/edges added, removed, retyped, rewired, new seed) rebuild the simulation, and
 *    resume playing if it was running.
 *  - Settings edits are applied live, so you can drag a slider and watch the system respond.
 *  - Positions and names never touch the engine.
 */

const structure = (d: Doc): string => {
  const manifests = catalog.get().byType
  return JSON.stringify([
    d.seed,
    // Where a node runs decides which quotas it shares and which regional faults reach it, so it is structure.
    Object.entries(d.nodes).map(([id, n]) => [id, n.type, n.region, n.parent, manifests[n.type]?.container?.decidesRegion ? n.settings : undefined]),
    Object.entries(d.edges).map(([id, e]) => [id, e.from.node, e.from.port, e.to])
  ])
}

export const startSync = (): (() => void) => {
  let synced = doc.get().design
  let epoch = doc.get().epoch
  client.send({ _tag: "load", design: synced })

  // A component was edited and the engine rebuilt: load the current design again and carry on as before.
  const offReload = onReload(() => {
    const status = run.get().status
    client.send({ _tag: "load", design: doc.get().design })
    if (status !== undefined) client.send({ _tag: "setSpeed", speed: status.speed })
    if (status?.phase === "running") client.send({ _tag: "play" })
  })

  const offDoc = doc.subscribe(() => {
    const next = doc.get().design
    const replaced = doc.get().epoch !== epoch
    epoch = doc.get().epoch
    if (next === synced && !replaced) return
    const prev = synced
    synced = next

    if (replaced || structure(prev) !== structure(next)) {
      const wasRunning = run.get().status?.phase === "running"
      client.send({ _tag: "load", design: next })
      if (wasRunning) client.send({ _tag: "play" })
      return
    }
    for (const [id, node] of Object.entries(next.nodes)) {
      if (prev.nodes[id]?.settings !== node.settings) client.send({ _tag: "updateNode", id, settings: node.settings ?? {} })
    }
    for (const placement of new Set([...Object.keys(prev.accounts ?? {}), ...Object.keys(next.accounts ?? {})])) {
      if (prev.accounts?.[placement] !== next.accounts?.[placement]) client.send({ _tag: "updateAccount", placement, settings: next.accounts?.[placement] ?? {} })
    }
    for (const [id, edge] of Object.entries(next.edges)) {
      if (prev.edges[id]?.settings !== edge.settings) client.send({ _tag: "updateEdge", id, settings: edge.settings ?? {} })
    }
  })

  return () => {
    offDoc()
    offReload()
  }
}
