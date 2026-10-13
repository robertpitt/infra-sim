import { Duration, Effect } from "effect"
import type { Node, PortDefs } from "../../../Component.ts"
import type { Link } from "../../../Edge.ts"
import type { Meter } from "../../../Telemetry.ts"
import { Capacity, type Costs, type Scaling } from "./capacity.ts"
import { TICK_MS } from "./config.ts"
import { ZonalDns } from "./dns.ts"
import { hostsIn, type Listener, listenerOf } from "./listener.ts"
import type { TargetKind } from "./state.ts"

/**
 * What the two load balancers share: their nodes' setup (listener, DNS, capacity and the once-a-second tick), choosing the
 * target group (an edge) for a request, and naming their zones.
 */

/**
 * Pick one of `links` by weight for a draw `u` in [0, 1): its index, or -1 if every weight is 0 (nothing to forward to).
 * Weights are read live, so moving traffic from blue to green is editing two numbers.
 */
export const pickByWeight = (links: ReadonlyArray<Link>, u: number): number => {
  const n = links.length
  if (n === 0) return -1
  if (n === 1) return links[0]!.weightUnsafe() > 0 ? 0 : -1
  let total = 0
  for (const l of links) total += Math.max(0, l.weightUnsafe())
  if (total <= 0) return -1
  let r = u * total
  for (let i = 0; i < n; i++) {
    r -= Math.max(0, links[i]!.weightUnsafe())
    if (r < 0) return i
  }
  return n - 1
}

/**
 * A second hash of a message's key, for choosing a target group by key. The target group then picks its target by the
 * key itself (a flow hash, sticky sessions); without this, every key that chose the first group would also land on its
 * first targets.
 */
export const rehash = (key: number): number => {
  const x = key * 2_654_435.761
  return x - Math.floor(x)
}

/**
 * A third hash of the key, for the load balancer node a client reaches: a client (a key) keeps its connection to one node,
 * as it keeps the address its DNS answer gave it. Messages with random keys spread over the nodes by their DNS shares;
 * one client (a hot key) goes through one node.
 */
export const nodeHash = (key: number): number => {
  const x = key * 40_503.123_7 + 0.381_966
  return x - Math.floor(x)
}

/** The zones a load balancer has a node in: the first `n` of its region's, and at least `min` (when the region has them). */
export const enabledZones = (all: ReadonlyArray<string>, n: number, min: number): ReadonlyArray<string> => all.slice(0, Math.max(min, n))

/** What a load balancer's settings make of a request, worked out once per settings object. */
export interface Derived {
  readonly costs: Costs
  /** The idle timeout, in ms. */
  readonly idleMs: number
}

/** A load balancer node's moving parts, as `balancer` sets them up for `Alb.ts` and `Nlb.ts`. */
export interface Balancer<S> {
  readonly listener: Listener
  readonly capacity: Capacity
  readonly dns: ZonalDns
  /** What each edge out leads to: known once the connectors exist, which is after the component is made. */
  readonly kinds: () => ReadonlyArray<TargetKind>
  /** The settings' derived numbers, worked out again only when the settings are replaced. */
  readonly derived: (s: S) => Derived
  /** Gauge the zones in DNS and the targets' health over every target group (HealthyHostCount, UnHealthyHostCount). */
  readonly gaugeHealth: (meter: Meter) => void
  /** The target groups, as the probe reports them. */
  readonly targetGroups: () => ReadonlyArray<{ readonly edge: string; readonly to: string; readonly kind: TargetKind }>
}

/**
 * Set up a load balancer's nodes: attach its listener, keep its DNS over its zones and its capacity, and once a second
 * re-read the zones' health for DNS and measure the load (`scaling`: how it scales, or not at all).
 */
export const balancer = <S extends { readonly zones: number; readonly idleTimeout: Duration.Duration }>(
  node: Pick<Node<S, PortDefs>, "id" | "shared" | "zones" | "fast">,
  out: ReadonlyArray<Link>,
  o: {
    readonly activePerLcu: number
    readonly minZones: number
    /** Whether a zone with no registered targets stays in DNS (ALB) or is failed over like an unhealthy one (NLB). */
    readonly emptyZonesStay: boolean
    readonly costs: (s: S) => Costs
    readonly scaling: (s: S) => Scaling | undefined
    /** Requests in flight now. */
    readonly active: () => number
  }
): Effect.Effect<Balancer<S>> =>
  Effect.gen(function*() {
    const { fast } = node
    const listener = yield* listenerOf(node.shared, node.id)
    listener.attached = true
    const capacity = new Capacity(o.activePerLcu)
    const dns = new ZonalDns(node.zones, listener, fast.now, o.emptyZonesStay)
    const zonesNow = () => enabledZones(node.zones.all, fast.settings().zones, o.minZones)

    // Which edges invoke a Lambda function: known once the connectors exist, which is after this component is made.
    let kinds: Array<TargetKind> | undefined
    const kindsOf = (): Array<TargetKind> =>
      (kinds ??= out.map((l) => (listener.lambdas.has(l.id) ? "lambda" : listener.groups.has(l.id) ? "fleet" : "address")))

    let derivedFor: S | undefined
    let derived: Derived
    const derivedOf = (s: S): Derived => {
      if (s !== derivedFor) {
        derivedFor = s
        derived = { costs: o.costs(s), idleMs: Duration.toMillis(s.idleTimeout) }
      }
      return derived
    }

    // Once a second: the zones' health for DNS, and the load for scaling.
    const tick = (): void => {
      dns.refresh(zonesNow())
      capacity.tick(fast.now(), o.active(), o.scaling(fast.settings()))
      fast.after(TICK_MS, tick, undefined)
    }
    // DNS as it has been since before the run, read once the target groups exist (their connectors are made after this).
    fast.after(0, () => dns.refresh(zonesNow()), undefined)
    // The first tick, a second in, sizes the load balancer to the traffic it has seen.
    fast.after(TICK_MS, tick, undefined)
    node.zones.watch(() => dns.refresh(zonesNow()))

    return {
      listener,
      capacity,
      dns,
      kinds: kindsOf,
      derived: derivedOf,
      gaugeHealth: (meter) => {
        meter.gaugeUnsafe("zones.inDns", () => dns.healthyZones)
        meter.gaugeUnsafe("healthyHosts", () => hostsIn(listener, "healthy"))
        meter.gaugeUnsafe("unhealthyHosts", () => hostsIn(listener, "unhealthy"))
      },
      targetGroups: () => out.map((l, i) => ({ edge: l.id, to: l.to, kind: kindsOf()[i]! }))
    }
  })
