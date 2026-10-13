import type { Zones } from "../../../Component.ts"
import { DNS_TTL_MS, NODE_DETECTION_MS } from "./config.ts"
import type { Listener } from "./listener.ts"

/**
 * A load balancer's nodes, one in each of its zones, as its clients reach them through DNS.
 *
 * ELB answers its DNS name with the address of a node in each zone in DNS (How Elastic Load Balancing works), and each
 * client spreads its requests evenly over the addresses its cached answer holds. A zone leaves DNS when its node is down
 * (assumed noticed at once: `NODE_DETECTION_MS`) or when no target group has a healthy target for its node (DNS failover:
 * by default one healthy target is the minimum; with cross-zone off a target group counts the zone's own targets, with it
 * on all of them; one healthy target group is enough). A zone with no targets at all stays in an ALB's DNS, and gets 503s
 * (`emptyZonesStay`); an NLB treats it as unhealthy. If no zone is healthy, ELB answers with every zone again (here: every
 * zone whose node is up).
 *
 * Clients resolved at random moments over the last TTL (60 seconds), so a client's answer is DNS as it was then. A zone's
 * share of new requests is therefore DNS's history over the last TTL, averaged: `(1 / TTL) ∫ [z in S(τ)] / |S(τ)| dτ`
 * over `τ` in `[now − TTL, now]`, where `S(τ)` is the set of zones DNS answered with at `τ`. A zone that leaves goes from a
 * third (of three) to nothing over a minute, linearly; one that comes back gains its share the same way.
 *
 * Health is read once a second (`refresh`) and whenever a zone's faults change; a request only draws from the shares.
 */
export class ZonalDns {
  private zones: Array<string> = []
  /** What DNS answered with, and from when: the last entry is now; the first started before the last TTL began. */
  private history: Array<{ readonly from: number; readonly inDns: ReadonlyArray<boolean> }> = []
  /** Each zone's share of new requests, cumulative, worked out on each refresh. */
  private cumulative: Array<number> = []

  constructor(
    private readonly zoneFaults: Pick<Zones, "down">,
    private readonly listener: Listener,
    private readonly now: () => number,
    /** Whether a zone with no registered targets stays in DNS (ALB) or is failed over like an unhealthy one (NLB). */
    private readonly emptyZonesStay: boolean
  ) {}

  /** Re-read the zones' health against `enabled` (the load balancer's zones now), and the shares that follow. */
  refresh(enabled: ReadonlyArray<string>): void {
    const t = this.now()
    if (!same(enabled, this.zones)) this.rezone(enabled)
    const answer = this.answer()
    const last = this.history[this.history.length - 1]
    if (last === undefined || !same(last.inDns, answer)) {
      // The very first answer has always been there; later ones from now (plus however long ELB takes to notice).
      this.history.push({ from: last === undefined ? -Infinity : t + NODE_DETECTION_MS, inDns: answer })
    }
    // Forget what no cached answer can still hold.
    while (this.history.length > 1 && this.history[1]!.from <= t - DNS_TTL_MS) this.history.shift()
    const shares = this.shares(t)
    let total = 0
    for (let i = 0; i < shares.length; i++) {
      total += shares[i]!
      this.cumulative[i] = total
    }
  }

  /** The zone a new request reaches, for a draw `u` in [0, 1). `undefined` when the load balancer has no zones. */
  pick(u: number): string | undefined {
    const n = this.zones.length
    if (n === 0) return undefined
    const total = this.cumulative[n - 1] ?? 0
    // Not read yet: every zone alike.
    if (total <= 0) return this.zones[Math.min(n - 1, Math.floor(u * n))]
    const r = u * total
    for (let i = 0; i < n; i++) if (r < this.cumulative[i]!) return this.zones[i]
    return this.zones[n - 1]
  }

  /** Zones DNS answers with now. */
  get healthyZones(): number {
    const last = this.history[this.history.length - 1]
    let k = 0
    if (last !== undefined) for (const inDns of last.inDns) if (inDns) k++
    return k
  }

  /** Each zone's state, for a probe: in DNS or not, its share of new requests now, and whether its node is up. */
  report(): ReadonlyArray<{ readonly zone: string; readonly inDns: boolean; readonly share: number; readonly nodeUp: boolean }> {
    const shares = this.shares(this.now())
    const last = this.history[this.history.length - 1]
    return this.zones.map((zone, i) => ({ zone, inDns: last?.inDns[i] ?? false, share: shares[i]!, nodeUp: !this.zoneFaults.down(zone) }))
  }

  /** Which zones DNS answers with now: the healthy ones, or (none healthy) those whose node is up, or else all. */
  private answer(): ReadonlyArray<boolean> {
    const up = this.zones.map((z) => !this.zoneFaults.down(z))
    const healthy = this.zones.map((z, i) => up[i]! && this.targetsHealthy(z))
    if (healthy.some(Boolean)) return healthy
    if (up.some(Boolean)) return up
    return this.zones.map(() => true)
  }

  /** Some target group has a healthy target for the node in `zone`, or there are no target groups to ask. */
  private targetsHealthy(zone: string): boolean {
    const groups = this.listener.groups
    if (groups.size === 0) return true
    for (const g of groups.values()) {
      const scope = g.crossZone() ? undefined : zone
      if (g.healthyIn(scope) > 0 || (this.emptyZonesStay && g.registeredIn(scope) === 0)) return true
    }
    return false
  }

  /** Each zone's share of the clients' cached answers at `t`: DNS's last TTL, averaged. */
  private shares(t: number): Array<number> {
    const n = this.zones.length
    const out = new Array<number>(n).fill(0)
    const since = t - DNS_TTL_MS
    for (let k = 0; k < this.history.length; k++) {
      const h = this.history[k]!
      const from = Math.max(since, h.from)
      const to = k + 1 < this.history.length ? Math.min(t, this.history[k + 1]!.from) : t
      if (to <= from) continue
      let size = 0
      for (const inDns of h.inDns) if (inDns) size++
      if (size === 0) continue
      const each = (to - from) / size
      for (let i = 0; i < n; i++) if (h.inDns[i]) out[i] = out[i]! + each
    }
    let total = 0
    for (const s of out) total += s
    // Nothing yet (the very first instant): every zone alike.
    if (total <= 0) return out.map(() => 1 / Math.max(1, n))
    return out.map((s) => s / total)
  }

  /** The load balancer's zones changed: keep each zone's history by name; a zone new to it was never in DNS before now. */
  private rezone(enabled: ReadonlyArray<string>): void {
    const was = this.zones
    this.zones = [...enabled]
    this.history = this.history.map((h) => ({ from: h.from, inDns: enabled.map((z) => (was.indexOf(z) >= 0 ? h.inDns[was.indexOf(z)]! : false)) }))
    this.cumulative = enabled.map(() => 0)
    this.listener.zones = this.zones
  }
}

/** Whether two lists hold the same items in the same order. */
const same = <A>(a: ReadonlyArray<A>, b: ReadonlyArray<A>): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
