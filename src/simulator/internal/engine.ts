/**
 * Plain helpers for `Engine.ts`: the catalog a host reads once, and the edits the engine keeps its copy of the document
 * in step with as live changes are applied.
 */
import type { Catalog } from "../Engine.ts"
import * as Connector from "../Connector.ts"
import * as Describe from "../Describe.ts"
import type * as Design from "../Design.ts"
import * as Fault from "../Fault.ts"
import type { Registry } from "../Registry.ts"

/** What the components, connectors, controllers and providers in `registry` are, for a host to build its forms from. */
export const catalog = (registry: Registry["Service"]): Catalog => ({
  providers: registry.providers.map((p) => ({
    id: p.id,
    title: p.title,
    defaultRegion: p.defaultRegion,
    regions: p.regions.map((r) => ({ id: r.id, name: r.name, zones: r.zones ?? [] })),
    account: Object.fromEntries(p.regions.map((r) => [r.id, Describe.fields(p.account(r.id))]))
  })),
  components: registry.manifests,
  connectors: registry.connectorManifests,
  transport: Connector.transportFields(),
  controllers: registry.controllerManifests,
  faults: Fault.catalog
})

/** `doc` with edge `id`'s settings replaced; unchanged if it has no such edge. */
export const withEdgeSettings = (doc: Design.Doc, id: string, settings: Record<string, unknown>): Design.Doc =>
  doc.edges[id] === undefined ? doc : { ...doc, edges: { ...doc.edges, [id]: { ...doc.edges[id]!, settings } } }

/** `doc` with the account-level quotas of `placement` replaced. */
export const withAccount = (doc: Design.Doc, placement: string, settings: Record<string, unknown>): Design.Doc => ({
  ...doc,
  accounts: { ...doc.accounts, [placement]: settings }
})

/** `doc` with controller `id`'s settings replaced; unchanged if it has no such controller. */
export const withControllerSettings = (doc: Design.Doc, id: string, settings: Record<string, unknown>): Design.Doc => {
  const c = doc.controllers?.[id]
  return c === undefined ? doc : { ...doc, controllers: { ...doc.controllers, [id]: { ...c, settings } } }
}
