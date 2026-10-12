import { Effect, type Scope } from "effect"

/**
 * What a load balancer shares with the connectors on its edges (its target groups), through `shared` in its placement.
 *
 * A load balancer has a node in each of its zones, and a request reaches one of them; with cross-zone off that node sends
 * only to targets in its own zone. The component decides which node a request reached (its DNS, its nodes' health) and the
 * target group on the edge picks the target, so the zone has to cross from one to the other. The component sets `zone`
 * immediately before it sends through an edge, and the connector reads it at the start of `send`, which the edge calls
 * synchronously: nothing else runs in between, so no request ever sees another's zone.
 *
 * The other way, the connectors register what they are (a target group, a Lambda target), so the component can tell a
 * Lambda function's edge from a fleet's and read each target group's health for its DNS failover.
 *
 * Only a target in the load balancer's own region shares it (ELB targets are in its VPC; a Lambda target must be in the same
 * Region): a connector whose target is elsewhere gets an object the load balancer never `attached` to, and works without
 * zones of its own (the target group then picks a zone among its targets').
 */
export class Listener {
  /** Set by the load balancer when it is made, before any connector: a connector that finds it unset is in another region. */
  attached = false
  /** The zone the request being sent now reached the load balancer in. */
  zone: string | undefined = undefined
  /** The zones the load balancer has a node in (a new array when they change): targets elsewhere are unused. */
  zones: ReadonlyArray<string> | undefined = undefined
  /** Target groups on the load balancer's edges into fleets, by edge id. */
  readonly groups = new Map<string, GroupHealth>()
  /** Edges to a Lambda function (a target group of type lambda). */
  readonly lambdas = new Set<string>()
}

/** What the load balancer's DNS failover reads of one target group. */
export interface GroupHealth {
  readonly crossZone: () => boolean
  readonly healthyIn: (zone: string | undefined) => number
  readonly registeredIn: (zone: string | undefined) => number
}

type Shared = <A>(key: string, build: Effect.Effect<A, never, Scope.Scope>) => Effect.Effect<A>

/** The listener of load balancer `id`, shared in the placement `shared` belongs to. */
export const listenerOf = (shared: Shared, id: string): Effect.Effect<Listener> => shared(`aws.elb.listener:${id}`, Effect.sync(() => new Listener()))
