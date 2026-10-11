import { Connector, Describe, Fault, Registry } from "#simulator"
import { registry as builtin } from "#simulator/components"
import { createStore } from "../lib/store.ts"
import type { Command, ComponentManifest, ConnectorManifest, ControllerManifest, Event, FaultKind, FieldSpec } from "./types.ts"

/**
 * The engine, wired up. The UI never imports simulation logic beyond this file: it sends commands and listens
 * to events. The `Engine` runs in a Web Worker; commands and events cross as plain data.
 */

let current: Registry.Components = builtin

/** What the engine is built over, as a live view so a hot-swapped component set is picked up. */
export const registry: Registry.Components = {
  get: (type) => current.get(type),
  get list() {
    return current.list
  },
  get manifests() {
    return current.manifests
  },
  provider: (id) => current.provider(id),
  get providers() {
    return current.providers
  },
  connector: (type) => current.connector(type),
  get connectors() {
    return current.connectors
  },
  get connectorManifests() {
    return current.connectorManifests
  },
  connectorFor: (from, to, explicit) => current.connectorFor(from, to, explicit),
  controller: (type) => current.controller(type),
  get controllers() {
    return current.controllers
  },
  get controllerManifests() {
    return current.controllerManifests
  }
}

export interface ProviderInfo {
  readonly id: string
  readonly title: string
  readonly defaultRegion: string
  readonly regions: ReadonlyArray<{ readonly id: string; readonly name: string }>
}

export interface Catalog {
  readonly providers: ReadonlyArray<ProviderInfo>
  readonly list: ReadonlyArray<ComponentManifest>
  readonly byType: Readonly<Record<string, ComponentManifest>>
  /** What can sit on an edge, in registration order (the core ones first). */
  readonly connectors: ReadonlyArray<ConnectorManifest>
  readonly connectorsByType: Readonly<Record<string, ConnectorManifest>>
  /** Transport's form, the last part of every connection's settings. */
  readonly transport: ReadonlyArray<FieldSpec>
  /** What can be attached to a node to change it while it runs. */
  readonly controllers: ReadonlyArray<ControllerManifest>
  readonly faults: ReadonlyArray<FaultKind>
}

const catalogOf = (components: Registry.Components): Catalog => ({
  providers: components.providers.map((p) => ({
    id: p.id,
    title: p.title,
    defaultRegion: p.defaultRegion,
    regions: p.regions.map((r) => ({ id: r.id, name: r.name }))
  })),
  list: components.manifests,
  byType: Object.fromEntries(components.manifests.map((m) => [m.type, m])),
  connectors: components.connectorManifests,
  connectorsByType: Object.fromEntries(components.connectorManifests.map((m) => [m.type, m])),
  transport: Connector.transportFields(),
  controllers: components.controllerManifests,
  faults: Fault.catalog
})

/**
 * What sits on a wire from `from`'s port to a node of type `to`: the connector the document names or the one that fits
 * best, and every connector that would fit (most specific first), for a picker. `undefined` if nothing fits.
 */
export const connectorOf = (
  from: { readonly type: string; readonly port: string },
  to: string,
  explicit?: string
): { readonly connector: ConnectorManifest; readonly choices: ReadonlyArray<ConnectorManifest> } | undefined => {
  const picked = current.connectorFor(from, to, explicit)
  if (!picked.ok) return undefined
  const q = Registry.queryOf(current.get(from.type), from.port, current.get(to))
  const { connectorsByType } = catalog.get()
  const manifest = connectorsByType[picked.connector.type]
  if (manifest === undefined || q === undefined) return undefined
  return { connector: manifest, choices: Connector.candidates(catalog.get().connectors, q) }
}

/** The account-level quota form for one region of a provider (published defaults differ by region). */
export const accountFields = (provider: string, region: string): ReadonlyArray<FieldSpec> => {
  const p = current.provider(provider)
  return p === undefined ? [] : Describe.fields(p.account(region))
}

/** What components exist, as serialisable manifests. */
export const catalog = createStore<Catalog>(catalogOf(current))

// ---------------------------------------------------------------------------------------------------------
// A session is one running Engine. Replacing the components replaces the session.
// ---------------------------------------------------------------------------------------------------------

const listeners = new Set<(event: Event) => void>()

interface Session {
  readonly send: (command: Command) => void
  readonly dispose: () => void
}

/**
 * A session is one running engine, in a Web Worker of its own (`engine.worker.ts`): the simulation never shares a
 * thread with the page. Commands go in as posted messages; events come back in batches.
 */
const open = (): Session => {
  const worker = new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module" })
  worker.onmessage = (message: MessageEvent<ReadonlyArray<Event>>) => {
    for (const event of message.data) for (const listener of [...listeners]) listener(event)
  }
  return {
    send: (command) => worker.postMessage(command),
    dispose: () => worker.terminate()
  }
}

let session = open()
const reloaded = new Set<() => void>()

export const client = {
  send: (command: Command): void => session.send(command),
  subscribe: (listener: (event: Event) => void): (() => void) => {
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }
}

/** Called after the engine has been rebuilt (a component was edited), so the host can reload its design. */
export const onReload = (handler: () => void): (() => void) => {
  reloaded.add(handler)
  return () => void reloaded.delete(handler)
}

// Edit a component and the running simulation restarts with the same design, seed and run state.
if (import.meta.hot) {
  import.meta.hot.accept("#simulator/components", (module) => {
    if (module === undefined) return
    current = (module as unknown as { registry: Registry.Components }).registry
    catalog.set(catalogOf(current))
    session.dispose()
    session = open()
    // The run store still holds the old engine's state, which is what the host needs to restore.
    for (const handler of reloaded) handler()
  })
}
