import { Describe, Edge, Fault, Registry } from "#simulator"
import { registry as builtin } from "#simulator/components"
import { createStore } from "../lib/store.ts"
import type { Command, ComponentManifest, Event, FaultKind, FieldSpec } from "./types.ts"

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
  /** The universal edge form, shown for every connection. */
  readonly edge: ReadonlyArray<FieldSpec>
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
  edge: Describe.fields(Edge.Config),
  faults: Fault.catalog
})

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
