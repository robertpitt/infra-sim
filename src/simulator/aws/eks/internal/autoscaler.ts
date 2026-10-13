import { Duration } from "effect"
import type { Fleet } from "../../../fleet/Fleet.ts"
import { type Host, HostPool, type Resources } from "../../../fleet/Hosts.ts"
import type { TimerHandle } from "../../../VirtualTime.ts"
import type { Settings } from "./config.ts"
import { CA_EMPTY_BULK, KARPENTER_CONSOLIDATION_PERIOD_MS } from "./limits.ts"
import type { NodeGroup } from "./nodes.ts"

/**
 * What adds nodes when pods are Pending and removes the ones not needed: the second level of two-level scaling (the HPA
 * changes pods, this changes nodes). Two of them, chosen by a setting:
 *
 *  - **Cluster Autoscaler** (FAQ): every scan interval (10 s) it looks for unschedulable pods and asks the node group for
 *    as many more nodes as they need, counting room on nodes already launching. For scale-down it marks a node unneeded
 *    while its pods request less than half its allocatable CPU and memory and would fit elsewhere; after 10 minutes
 *    unneeded it removes it: empty nodes together, a node with pods one at a time (draining it). It doesn't even look
 *    for 10 minutes after a scale-up, so after a surge the nodes stay at least 20 minutes.
 *  - **Karpenter**: it batches pending pods (until 1 s passes with no new one, at most 10 s), then launches the nodes they
 *    need directly, with no node group in between. Consolidation removes empty nodes, and (WhenEmptyOrUnderutilized) any
 *    node whose pods fit on the others, as soon as its pods haven't changed for `consolidateAfter`, within a disruption
 *    budget of 10% of nodes.
 *
 * Both see pods as the scheduler does: by their requests, never their use.
 */

/** One decision, for a probe. */
export interface Decision {
  readonly t: number
  readonly action: "add" | "remove"
  readonly nodes: number
  readonly reason: string
}

interface Timers {
  readonly now: () => number
  readonly after: <A>(ms: number, fire: (arg: A) => void, arg: A) => TimerHandle
}

const KEEP = 20

/** Pods still Pending once the nodes already launching have taken their share, and how many nodes they need. */
const shortfall = (group: NodeGroup, pending: number, demand: Resources): { readonly pods: number; readonly nodes: number } => {
  const perNode = HostPool.perHost(group.allocatable(), demand)
  if (perNode === 0) return { pods: pending, nodes: 0 }
  const pods = Math.max(0, pending - group.fleet.pending * perNode)
  return { pods, nodes: Math.ceil(pods / perNode) }
}

/** How full a node is by requests: the larger of its CPU and memory shares. */
const utilization = (h: Host): number => Math.max(h.room.cpu > 0 ? h.cpu / h.room.cpu : 1, h.room.memory > 0 ? h.memory / h.room.memory : 1)

export class NodeAutoscaler {
  readonly decisions: Array<Decision> = []
  private lastScaleUp = Number.NEGATIVE_INFINITY
  private readonly unneededSince = new WeakMap<Host, number>()
  /** Karpenter's batch of pending pods: when it began, how many were pending at the last look and when that changed. */
  private batchStart: number | undefined = undefined
  private batchCount = 0
  private batchChanged = 0
  /** Karpenter: how many pods each node had at the last look, and since when. */
  private readonly podsSeen = new WeakMap<Host, { n: number; since: number }>()
  private nextConsolidation = 0

  constructor(
    private readonly group: NodeGroup,
    private readonly pods: () => Fleet,
    private readonly demand: () => Resources,
    private readonly settings: () => Settings,
    private readonly timers: Timers
  ) {
    timers.after(this.period(), this.tick, undefined)
  }

  /** The Cluster Autoscaler looks every scan interval; Karpenter reacts within its batch idle time (at most every second). */
  private period(): number {
    const s = this.settings()
    if (s.nodes.autoscaler === "karpenter") return Math.max(100, Math.min(1_000, Duration.toMillis(s.karpenter.batchIdle) || 1_000))
    return Math.max(1_000, Duration.toMillis(s.clusterAutoscaler.scanInterval))
  }

  private readonly tick = (): void => {
    const which = this.settings().nodes.autoscaler
    if (which === "cluster-autoscaler") this.clusterAutoscaler()
    else if (which === "karpenter") this.karpenter()
    this.timers.after(this.period(), this.tick, undefined)
  }

  private record(action: Decision["action"], nodes: number, reason: string): void {
    this.decisions.push({ t: this.timers.now(), action, nodes, reason })
    if (this.decisions.length > KEEP) this.decisions.shift()
  }

  private clusterAutoscaler(): void {
    const s = this.settings()
    const now = this.timers.now()
    const pending = this.pods().count.requested
    if (pending > 0) {
      const short = shortfall(this.group, pending, this.demand())
      if (short.nodes > 0) {
        const added = this.group.add(short.nodes)
        if (added > 0) {
          this.lastScaleUp = now
          this.record("add", added, `${short.pods} pods unschedulable`)
        }
      }
      return
    }
    const ca = s.clusterAutoscaler
    if (now - this.lastScaleUp < Duration.toMillis(ca.scaleDownDelayAfterAdd)) return
    const unneededFor = Duration.toMillis(ca.scaleDownUnneededTime)
    const empty: Array<Host> = []
    let busy: Host | undefined
    for (const h of this.group.pool.hosts) {
      if (!h.alive || h.cordoned) continue
      if (utilization(h) < ca.scaleDownUtilizationThreshold && this.group.pool.evacuable(h)) {
        let since = this.unneededSince.get(h)
        if (since === undefined) this.unneededSince.set(h, (since = now))
        if (now - since < unneededFor) continue
        if (h.tenants.size === 0) empty.push(h)
        else busy ??= h
      } else this.unneededSince.delete(h)
    }
    // Empty nodes go together (up to --max-empty-bulk-delete, 10); otherwise one node with pods, which are evicted.
    const minutes = Math.round(unneededFor / 60_000)
    const threshold = Math.round(ca.scaleDownUtilizationThreshold * 100)
    let removed = 0
    for (const h of empty) {
      if (removed >= CA_EMPTY_BULK || this.group.live <= s.nodes.minSize) break
      this.group.remove(h)
      removed++
    }
    if (removed > 0) this.record("remove", removed, `${removed === 1 ? "a node" : `${removed} nodes`} empty for ${minutes} min`)
    else if (busy !== undefined && this.group.live > s.nodes.minSize) {
      const pct = Math.round(utilization(busy) * 100)
      this.group.remove(busy)
      this.record("remove", 1, `${busy.name} under ${threshold}% requested (${pct}%) for ${minutes} min`)
    }
  }

  private karpenter(): void {
    const s = this.settings()
    const k = s.karpenter
    const now = this.timers.now()
    const short = shortfall(this.group, this.pods().count.requested, this.demand())
    if (short.pods > 0) {
      if (this.batchStart === undefined) {
        this.batchStart = this.batchChanged = now
        this.batchCount = short.pods
      } else if (short.pods !== this.batchCount) {
        this.batchCount = short.pods
        this.batchChanged = now
      }
      if (now - this.batchChanged >= Duration.toMillis(k.batchIdle) || now - this.batchStart >= Duration.toMillis(k.batchMax)) {
        this.batchStart = undefined
        const added = this.group.add(short.nodes)
        if (added > 0) this.record("add", added, `${short.pods} pods pending`)
      }
      return
    }
    this.batchStart = undefined
    if (now < this.nextConsolidation) return
    this.nextConsolidation = now + KARPENTER_CONSOLIDATION_PERIOD_MS
    this.consolidate(s, now)
  }

  /** Karpenter's consolidation: empty nodes first, then (if the policy allows) one node whose pods fit elsewhere. */
  private consolidate(s: Settings, now: number): void {
    const k = s.karpenter
    const hosts = this.group.pool.hosts
    let up = 0
    for (const h of hosts) if (h.alive) up++
    const budget = Math.max(1, Math.floor((up * k.budget) / 100)) - this.group.fleet.count.draining
    if (budget <= 0) return
    const after = Duration.toMillis(k.consolidateAfter)
    let removed = 0
    let underused: Host | undefined
    for (const h of [...hosts]) {
      if (!h.alive || h.cordoned) continue
      let seen = this.podsSeen.get(h)
      if (seen === undefined || seen.n !== h.tenants.size) this.podsSeen.set(h, (seen = { n: h.tenants.size, since: seen === undefined ? h.since : now }))
      if (now - seen.since < after) continue
      if (h.tenants.size === 0) {
        if (removed < budget) {
          this.group.remove(h)
          removed++
          this.record("remove", 1, `${h.name} empty`)
        }
      } else if (k.consolidation === "WhenEmptyOrUnderutilized" && (underused === undefined || utilization(h) < utilization(underused)) && this.group.pool.evacuable(h)) {
        underused = h
      }
    }
    if (removed === 0 && underused !== undefined) {
      const pct = Math.round(utilization(underused) * 100)
      this.group.remove(underused)
      this.record("remove", 1, `${underused.name}'s pods fit elsewhere (${pct}% requested)`)
    }
  }
}
