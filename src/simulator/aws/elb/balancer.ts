import type { Link } from "../../Edge.ts"

/**
 * What the two load balancers share: choosing the target group (an edge) for a request, and naming their zones.
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
