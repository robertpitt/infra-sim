import { Context, Layer } from "effect"
import { type AnyComponent, type Manifest, manifestOf } from "./Component.ts"
import type { Provider } from "./Provider.ts"
import { known } from "./providers.ts"

/** The set of components a design may use. Designs refer to components by `type`. */
export interface Components {
  readonly get: (type: string) => AnyComponent | undefined
  readonly list: ReadonlyArray<AnyComponent>
  readonly manifests: ReadonlyArray<Manifest>
  /** Providers by id. `internet` is always there. */
  readonly provider: (id: string) => Provider | undefined
  readonly providers: ReadonlyArray<Provider>
}

export class Registry extends Context.Service<Registry, Components>()("simulator/Registry") {
  /** A registry over these components. Swapping the layer swaps what designs can use. */
  static readonly layer = (components: ReadonlyArray<AnyComponent>, providers: ReadonlyArray<Provider> = []): Layer.Layer<Registry> =>
    Layer.sync(Registry, () => make(components, providers))
}

export const make = (components: ReadonlyArray<AnyComponent>, providers: ReadonlyArray<Provider> = []): Components => {
  const knownProviders = known(providers)
  const byType = new Map<string, AnyComponent>()
  for (const c of components) {
    if (byType.has(c.type)) throw new Error(`Component type "${c.type}" is registered twice`)
    byType.set(c.type, c)
  }
  return {
    get: (type) => byType.get(type),
    list: [...byType.values()],
    manifests: [...byType.values()].map((c, _, all) => manifestOf(c, all)),
    provider: (id) => knownProviders.get(id),
    providers: [...knownProviders.values()]
  }
}
