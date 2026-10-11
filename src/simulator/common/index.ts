import type { AnyComponent } from "../Component.ts"
import { Actor } from "./Actor.ts"
import { Client } from "./Client.ts"
import { HttpEndpoint } from "./HttpEndpoint.ts"
import { Service } from "./Service.ts"

export { Actor, Client, HttpEndpoint, Service }

/**
 * Components that belong to no cloud: traffic from outside, external receivers, and the shapes every system is built
 * from (a service of replicas, a family of keyed objects), which a provider's own components specialise.
 */
export const components: ReadonlyArray<AnyComponent> = [Client, HttpEndpoint, Service, Actor]
