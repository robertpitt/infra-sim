import { components as aws, provider as awsProvider } from "../aws/index.ts"
import { components as common } from "../common/index.ts"
import type { AnyComponent } from "../Component.ts"
import type { Provider } from "../Provider.ts"
import * as Registry from "../Registry.ts"

/**
 * Everything the simulator ships with. Adding a cloud is adding its components and its provider here: Cloudflare
 * or Azure would register theirs the same way, with their own regions and account quotas.
 */
export const builtins: ReadonlyArray<AnyComponent> = [...common, ...aws]
export const providers: ReadonlyArray<Provider> = [awsProvider]

/** The built-in components as a plain value, and as a layer for programs that want them as a service. */
export const registry = Registry.make(builtins, providers)
export const layer = Registry.Registry.layer(builtins, providers)
