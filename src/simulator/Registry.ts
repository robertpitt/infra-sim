import { Context, Layer } from "effect"
import { accepts, type AnyComponent, type Manifest, manifestOf, type PortDefs } from "./Component.ts"
import * as Connector from "./Connector.ts"
import { core } from "./connectors/index.ts"
import * as Controller from "./Controller.ts"
import { core as coreControllers } from "./controllers/index.ts"
import type { Provider } from "./Provider.ts"
import { known } from "./providers.ts"

/** The set of components, connectors and controllers a design may use. Designs refer to each by `type`. */
export interface Components {
  readonly get: (type: string) => AnyComponent | undefined
  readonly list: ReadonlyArray<AnyComponent>
  readonly manifests: ReadonlyArray<Manifest>
  /** Providers by id. `internet` is always there. */
  readonly provider: (id: string) => Provider | undefined
  readonly providers: ReadonlyArray<Provider>
  /** Connectors by type: the core ones (`core.link`, `core.poller`) and every provider's. */
  readonly connector: (type: string) => Connector.AnyConnector | undefined
  readonly connectors: ReadonlyArray<Connector.AnyConnector>
  readonly connectorManifests: ReadonlyArray<Connector.Manifest>
  /**
   * The connector for a wire from `from`'s port to a node of type `to`: the one named, if it fits, or else the most
   * specific that does (see `Connector.pick`).
   */
  readonly connectorFor: (from: { readonly type: string; readonly port: string }, to: string, explicit?: string) => Connector.Picked<Connector.AnyConnector>
  /** Controllers by type: the core ones (`core.target-tracking`) and every provider's. */
  readonly controller: (type: string) => Controller.AnyController | undefined
  readonly controllers: ReadonlyArray<Controller.AnyController>
  readonly controllerManifests: ReadonlyArray<Controller.Manifest>
}

export class Registry extends Context.Service<Registry, Components>()("simulator/Registry") {
  /** A registry over these components. Swapping the layer swaps what designs can use. */
  static readonly layer = (components: ReadonlyArray<AnyComponent>, providers: ReadonlyArray<Provider> = []): Layer.Layer<Registry> =>
    Layer.sync(Registry, () => make(components, providers))
}

/** The two ends of a wire, as `Connector.pick` sees them. `undefined` if either component or the port is unknown. */
export const queryOf = (source: AnyComponent | undefined, port: string, target: AnyComponent | undefined): Connector.Query | undefined => {
  const def = source === undefined ? undefined : (source.ports as PortDefs)[port]
  if (source === undefined || def === undefined || target === undefined) return undefined
  return { from: { component: source.type, port, protocol: def.protocol }, to: { component: target.type, protocol: accepts(target) } }
}

export const make = (components: ReadonlyArray<AnyComponent>, providers: ReadonlyArray<Provider> = []): Components => {
  const knownProviders = known(providers)
  const byType = new Map<string, AnyComponent>()
  for (const c of components) {
    if (byType.has(c.type)) throw new Error(`Component type "${c.type}" is registered twice`)
    byType.set(c.type, c)
  }
  const connectors = new Map<string, Connector.AnyConnector>()
  for (const c of [...core, ...[...knownProviders.values()].flatMap((p) => p.connectors ?? [])]) {
    if (connectors.has(c.type)) throw new Error(`Connector type "${c.type}" is registered twice`)
    connectors.set(c.type, c)
  }
  const connectorList = [...connectors.values()]
  const controllers = new Map<string, Controller.AnyController>()
  for (const c of [...coreControllers, ...[...knownProviders.values()].flatMap((p) => p.controllers ?? [])]) {
    if (controllers.has(c.type)) throw new Error(`Controller type "${c.type}" is registered twice`)
    controllers.set(c.type, c)
  }
  const controllerList = [...controllers.values()]
  return {
    get: (type) => byType.get(type),
    list: [...byType.values()],
    manifests: [...byType.values()].map((c, _, all) => manifestOf(c, all)),
    provider: (id) => knownProviders.get(id),
    providers: [...knownProviders.values()],
    connector: (type) => connectors.get(type),
    connectors: connectorList,
    connectorManifests: connectorList.map(Connector.manifestOf),
    connectorFor: (from, to, explicit) => {
      const source = byType.get(from.type)
      const target = byType.get(to)
      const q = queryOf(source, from.port, target)
      if (q === undefined) {
        return { ok: false, reason: source === undefined ? `unknown component "${from.type}"` : target === undefined ? `unknown component "${to}"` : `${source.title} has no "${from.port}" output` }
      }
      return Connector.pick(connectorList, q, explicit)
    },
    controller: (type) => controllers.get(type),
    controllers: controllerList,
    controllerManifests: controllerList.map(Controller.manifestOf)
  }
}
