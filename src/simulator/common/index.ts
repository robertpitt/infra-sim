import type { AnyComponent } from "../Component.ts"
import { Client } from "./Client.ts"
import { HttpEndpoint } from "./HttpEndpoint.ts"

export { Client, HttpEndpoint }

/** Components that belong to no cloud: traffic from outside, and external receivers. */
export const components: ReadonlyArray<AnyComponent> = [Client, HttpEndpoint]
