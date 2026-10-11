import { Graph } from "effect"
import type { Diagnostic } from "./Diagnostic.ts"
import * as Design from "./Design.ts"
import type { Components } from "./Registry.ts"
import { keyOf } from "./Provider.ts"
import * as Topology from "./Topology.ts"

export type { Diagnostic, Level } from "./Diagnostic.ts"
export { hasErrors } from "./Diagnostic.ts"

/**
 * Everything worth telling the author about a document.
 *
 * Errors come from decoding it (unknown components, settings out of range, edges to nowhere); once it decodes,
 * the `Graph` is asked about feedback loops (where retries amplify), nodes no client can reach, and sources wired to nothing.
 */
export const diagnose = (doc: Design.Doc, registry: Components): ReadonlyArray<Diagnostic> => {
  const { design, diagnostics } = Design.resolve(doc, registry)
  if (design === undefined) return diagnostics

  const out: Array<Diagnostic> = [...diagnostics]
  const label = (id: string) => doc.nodes[id]?.name ?? id

  for (const loop of Topology.feedbackLoops(design)) {
    out.push({
      level: "warning",
      code: "feedback-loop",
      node: loop[0]!,
      message: `Feedback loop through ${loop.map(label).join(" → ")}. Retries and redelivery can amplify load here.`
    })
  }
  // What the design asks of each account and region, against that account's quotas.
  for (const [key, account] of design.accounts) {
    const provider = registry.provider(account.placement.provider)
    if (provider?.audit === undefined) continue
    const members = Array.from(Graph.values(Graph.nodes(design.graph)))
      .filter((n) => keyOf(n.placement) === key)
      .map((n) => ({ id: n.id, name: n.name, type: n.type, config: n.config }))
    // Show quota findings on the container that draws that region, if the design has one.
    const box = Array.from(Graph.values(Graph.nodes(design.graph))).find((n) => n.component.container?.region !== undefined && keyOf(n.placement) === key)
    for (const finding of provider.audit(account.placement.region, members, account.config)) {
      out.push(finding.node === undefined && box !== undefined ? { ...finding, node: box.id } : finding)
    }
  }
  const sources = Topology.sources(design)
  if (sources.length === 0 && Object.keys(doc.nodes).length > 0) {
    out.push({ level: "info", code: "no-source", message: "No traffic source yet. Add a client to generate load." })
  }
  if (sources.length > 0) {
    const reachable = Topology.reachable(design)
    for (const id of Object.keys(doc.nodes)) {
      const component = registry.get(doc.nodes[id]!.type)
      if (!reachable.has(id) && component?.inputs !== false) {
        out.push({ level: "warning", code: "unreachable", node: id, message: `${label(id)} never receives traffic from any client` })
      }
    }
  }
  for (const id of sources) {
    if (Topology.outgoing(design, id).length === 0) {
      out.push({ level: "warning", code: "source-unconnected", node: id, message: `${label(id)} isn't connected to anything` })
    }
  }
  return out
}
