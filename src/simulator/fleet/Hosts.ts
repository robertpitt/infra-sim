import type { Unit } from "../Protocol.ts"
import type { Fleet, Placement, UnitEvent } from "./Fleet.ts"

/**
 * Units placed on hosts: ECS tasks on the container instances of an Auto Scaling group, Kubernetes pods on the nodes of a
 * node group. Two fleets, one on top of the other:
 *
 *  - the **hosts** are an ordinary `Fleet` (instances: launch, boot, join; zones; scale-in; interruptions), whose units
 *    serve no calls themselves;
 *  - the **tenants** are another `Fleet` (tasks, pods) given `pool.tenants(...)` as its `Options.hosts`. Before one of
 *    them launches, the pool finds it a host with room for what it asks (CPU, memory, a slot), and it lives in that
 *    host's zone. With no room it waits as `requested` (ECS's PROVISIONING, Kubernetes' Pending) until room is made:
 *    a host comes up, a tenant leaves one.
 *
 * What a host's life does to its tenants:
 *
 *  - **up**: its room is offered; tenants waiting are tried again.
 *  - **draining** (scaled in, interrupted, replaced): it takes no new tenants (cordoned), and its tenants are evicted:
 *    each drains while a replacement is placed elsewhere, as ECS's managed instance draining and `kubectl drain` do. The
 *    host waits for them (`Fleet.hold`) until its own drain time runs out.
 *  - **dead** (its zone went down, it crashed): its tenants die with it. Their fleet notices as it notices any dead unit
 *    (`Options.detect`: Kubernetes' node-monitor grace period plus the eviction toleration, say).
 *  - **gone**: whatever is still on it is gone too, and replaced at once.
 *
 * The pool also keeps the host fleet's scale-in honest: `occupied(host)` is the predicate for `Options.protect`, so an
 * Auto Scaling group with managed termination protection only lets go of empty instances.
 *
 * It is provider-neutral, like the fleet: resources are plain numbers the component chooses (vCPUs and MiB here), and every
 * policy is a function in its options, read when it is needed.
 */

/** What a host can give its tenants (its allocatable resources), or what a tenant asks of one. CPU in vCPUs, memory in MiB. */
export interface Resources {
  readonly cpu: number
  readonly memory: number
}

/** A host's room: resources, and how many tenants it can hold whatever their size (Kubernetes' max pods per node). */
export interface Room extends Resources {
  readonly slots: number
}

/**
 * Which host a tenant goes to, among those in the zone being tried that have room: the fullest (binpack: ECS's `binpack`,
 * Kubernetes' MostAllocated, so that whole hosts empty out and can be let go) or the emptiest (spread: ECS's `spread` on
 * `instanceId`, Kubernetes' default LeastAllocated). Ties go to the host that came up first.
 */
export type Strategy = "binpack" | "spread"

/**
 * How tenants spread over zones. `zones`: the zone with the fewest of the fleet's tenants first, others if it has no room
 * (ECS's default `spread` on `attribute:ecs.availability-zone`, Kubernetes' ScheduleAnyway). `strict`: only the zones with
 * the fewest (a topology spread constraint with maxSkew 1 and DoNotSchedule: wait rather than skew). `none`: any zone.
 */
export type ZoneSpread = "zones" | "strict" | "none"

const EPSILON = 1e-9

/** A host as the pool keeps it. */
export class Host {
  /** Its tenants, in the order they were placed. */
  readonly tenants = new Set<Unit>()
  /** Resources its tenants asked for. */
  cpu = 0
  memory = 0
  /** Takes no new tenants (draining, or cordoned by an autoscaler that means to remove it). */
  cordoned = false
  alive = true
  /** Images already on it: a component's business (what it has pulled here), kept with the host. */
  readonly images = new Set<string>()

  constructor(
    /** Its unit in the host fleet. */
    readonly unit: Unit,
    readonly room: Room,
    /** When it came up (virtual ms). */
    readonly since: number
  ) {}

  get zone(): string | undefined {
    return this.unit.zone
  }

  get name(): string {
    return this.unit.name
  }

  /** Whether a tenant asking for `d` fits now. */
  fits(d: Resources): boolean {
    return this.alive && !this.cordoned && this.tenants.size < this.room.slots && this.cpu + d.cpu <= this.room.cpu + EPSILON &&
      this.memory + d.memory <= this.room.memory + EPSILON
  }

  /** Its share used, as binpack and spread weigh it: CPU, memory, or the mean of the two (as Kubernetes scores nodes). */
  share(weigh: "cpu" | "memory" | "both", extra?: Resources): number {
    const cpu = this.room.cpu > 0 ? (this.cpu + (extra?.cpu ?? 0)) / this.room.cpu : 1
    const memory = this.room.memory > 0 ? (this.memory + (extra?.memory ?? 0)) / this.room.memory : 1
    return weigh === "cpu" ? cpu : weigh === "memory" ? memory : (cpu + memory) / 2
  }
}

export interface PoolOptions {
  /** What a host gives its tenants: read once, as it comes up. */
  readonly room: (host: Unit) => Room
  /** How a host is chosen within a zone. */
  readonly strategy: () => Strategy
  /** What binpack and spread weigh. Default both. */
  readonly weigh?: () => "cpu" | "memory" | "both"
  /** Evict a draining host's tenants so they are placed elsewhere (default true). Off: they run until the host is gone. */
  readonly evictOnDrain?: () => boolean
  /** Virtual time, for `Host.since`. */
  readonly now: () => number
}

/** What one fleet of tenants asks of the pool. */
export interface TenantOptions {
  /** What each tenant asks for: read when one is placed (and given back exactly when it goes). */
  readonly demand: () => Resources
  /** How strictly they spread over zones. Default `zones`. */
  readonly spread?: () => ZoneSpread
}

interface Placed {
  readonly host: Host
  readonly demand: Resources
  readonly fleet: Fleet
}

export class HostPool {
  /** Hosts that are up (serving in the host fleet, alive or dead but not yet gone), in the order they came up. */
  readonly hosts: Array<Host> = []
  private readonly byUnit = new Map<Unit, Host>()
  private readonly placed = new Map<Unit, Placed>()
  private readonly tenantFleets: Array<Fleet> = []
  /** Tenants placed over time, and tenants that found no room when they asked: for a probe. */
  readonly totals = { placed: 0, unplaced: 0, evicted: 0, lostWithHost: 0 }

  constructor(
    /** The hosts' own fleet. */
    readonly fleet: Fleet,
    private readonly options: PoolOptions
  ) {
    // Hosts there from the start never come up: they are already serving.
    for (const unit of fleet.units) if (unit.serving && unit.alive) this.add(unit)
    fleet.observe((unit, event) => this.changed(unit, event))
  }

  /**
   * The `Options.hosts` of a fleet of tenants. Each tenant fleet gets its own (its demand and spread are its own); they
   * all share the hosts.
   */
  tenants(options: TenantOptions): Placement {
    let bound: Fleet | undefined
    return {
      bind: (fleet) => {
        bound = fleet
        this.tenantFleets.push(fleet)
      },
      place: (unit, zones, counts) => {
        const demand = options.demand()
        const host = this.choose(demand, zones, counts, options.spread?.() ?? "zones")
        if (host === undefined || bound === undefined) {
          this.totals.unplaced++
          return undefined
        }
        host.cpu += demand.cpu
        host.memory += demand.memory
        host.tenants.add(unit)
        this.placed.set(unit, { host, demand, fleet: bound })
        this.fleet.hold(host.unit)
        this.totals.placed++
        return host
      },
      release: (unit) => this.release(unit)
    }
  }

  /** The host a tenant runs on. */
  hostOf(tenant: Unit): Host | undefined {
    return this.placed.get(tenant)?.host
  }

  /** The pool's host for a unit of the host fleet. */
  host(unit: Unit): Host | undefined {
    return this.byUnit.get(unit)
  }

  /** Whether a host has tenants: the host fleet's `Options.protect` for managed termination protection. */
  occupied(unit: Unit): boolean {
    const host = this.byUnit.get(unit)
    return host !== undefined && host.tenants.size > 0
  }

  /** Take no new tenants on it (an autoscaler about to remove it), or take them again. */
  cordon(host: Host, cordoned = true): void {
    if (host.cordoned === cordoned) return
    host.cordoned = cordoned
    if (!cordoned) this.roomMade()
  }

  /** Evict a host's tenants: each is replaced elsewhere (its fleet's `stop`) and drains meanwhile. */
  evict(host: Host): void {
    for (const tenant of [...host.tenants]) {
      const p = this.placed.get(tenant)
      if (p === undefined || !isLive(tenant)) continue
      this.totals.evicted++
      p.fleet.stop(tenant)
    }
  }

  /**
   * Whether every tenant of `host` would fit on the other hosts (not cordoned, alive), placed first-fit largest first:
   * the check a cluster autoscaler makes before it removes a node.
   */
  evacuable(host: Host): boolean {
    const others = this.hosts.filter((h) => h !== host && h.alive && !h.cordoned)
    const used = others.map((h) => ({ cpu: h.cpu, memory: h.memory, n: h.tenants.size }))
    const demands = [...host.tenants].map((t) => this.placed.get(t)!.demand).sort((a, b) => b.cpu - a.cpu || b.memory - a.memory)
    for (const d of demands) {
      let fitted = false
      for (let i = 0; i < others.length; i++) {
        const h = others[i]!
        const u = used[i]!
        if (u.n < h.room.slots && u.cpu + d.cpu <= h.room.cpu + EPSILON && u.memory + d.memory <= h.room.memory + EPSILON) {
          u.cpu += d.cpu
          u.memory += d.memory
          u.n++
          fitted = true
          break
        }
      }
      if (!fitted) return false
    }
    return true
  }

  /** Room over the hosts that are up and alive, and what their tenants asked for of it. */
  totalsNow(): { readonly hosts: number; readonly room: Room; readonly used: Resources & { readonly tenants: number } } {
    let hosts = 0
    let cpu = 0
    let memory = 0
    let slots = 0
    let usedCpu = 0
    let usedMemory = 0
    let tenants = 0
    for (const h of this.hosts) {
      if (!h.alive) continue
      hosts++
      cpu += h.room.cpu
      memory += h.room.memory
      slots += h.room.slots
      usedCpu += h.cpu
      usedMemory += h.memory
      tenants += h.tenants.size
    }
    return { hosts, room: { cpu, memory, slots }, used: { cpu: usedCpu, memory: usedMemory, tenants } }
  }

  /** How many tenants asking for `d` fit on one empty host with `room`: what a new host adds. */
  static perHost(room: Room, d: Resources): number {
    const byCpu = d.cpu > 0 ? Math.floor(room.cpu / d.cpu + EPSILON) : Infinity
    const byMemory = d.memory > 0 ? Math.floor(room.memory / d.memory + EPSILON) : Infinity
    return Math.max(0, Math.min(room.slots, byCpu, byMemory))
  }

  // ---------------------------------------------------------------------------------------------------------

  private choose(d: Resources, zones: ReadonlyArray<string>, counts: ReadonlyArray<number>, spread: ZoneSpread): Host | undefined {
    if (zones.length === 0) return this.best(d, undefined)
    if (spread === "none") return this.best(d, zones)
    const fewest = counts[0] ?? 0
    for (let i = 0; i < zones.length; i++) {
      if (spread === "strict" && counts[i]! > fewest) break
      const host = this.best(d, undefined, zones[i])
      if (host !== undefined) return host
    }
    return undefined
  }

  /** The best host with room for `d`: in `zone`, or in any of `zones`, or anywhere. */
  private best(d: Resources, zones: ReadonlyArray<string> | undefined, zone?: string): Host | undefined {
    const binpack = this.options.strategy() === "binpack"
    const weigh = this.options.weigh?.() ?? "both"
    let pick: Host | undefined
    let score = 0
    for (const h of this.hosts) {
      if (zone !== undefined && h.zone !== zone) continue
      if (zones !== undefined && (h.zone === undefined || !zones.includes(h.zone))) continue
      if (!h.fits(d)) continue
      const s = h.share(weigh, d)
      if (pick === undefined || (binpack ? s > score + EPSILON : s < score - EPSILON)) {
        pick = h
        score = s
      }
    }
    return pick
  }

  private add(unit: Unit): void {
    if (this.byUnit.has(unit)) return
    const host = new Host(unit, this.options.room(unit), this.options.now())
    this.hosts.push(host)
    this.byUnit.set(unit, host)
  }

  private changed(unit: Unit, event: UnitEvent): void {
    if (event === "up") {
      this.add(unit)
      return this.roomMade()
    }
    const host = this.byUnit.get(unit)
    if (host === undefined) return
    if (event === "draining") {
      host.cordoned = true
      if (this.options.evictOnDrain?.() ?? true) this.evict(host)
      return
    }
    if (event === "dead") {
      host.alive = false
      for (const tenant of [...host.tenants]) {
        this.totals.lostWithHost++
        this.placed.get(tenant)?.fleet.kill(tenant, `its host ${host.name} died`)
      }
      return
    }
    // Gone: forget it, and whatever is still on it went with it (and is replaced now).
    host.alive = false
    this.hosts.splice(this.hosts.indexOf(host), 1)
    this.byUnit.delete(unit)
    for (const tenant of [...host.tenants]) {
      const p = this.placed.get(tenant)
      if (p === undefined) continue
      this.totals.lostWithHost++
      p.fleet.kill(tenant, `its host ${host.name} stopped`)
      p.fleet.stop(tenant)
    }
  }

  private release(unit: Unit): void {
    const p = this.placed.get(unit)
    if (p === undefined) return
    this.placed.delete(unit)
    const host = p.host
    host.tenants.delete(unit)
    host.cpu = Math.max(0, host.cpu - p.demand.cpu)
    host.memory = Math.max(0, host.memory - p.demand.memory)
    this.fleet.unhold(host.unit)
    if (host.alive && !host.cordoned) this.roomMade()
    // An empty host may be what scale-in was waiting for (managed termination protection).
    if (host.tenants.size === 0) this.fleet.retry()
  }

  /** Room was made: every tenant fleet tries its waiting tenants again. */
  private roomMade(): void {
    for (const f of this.tenantFleets) f.retry()
  }
}

const isLive = (u: Unit): boolean => u.state === "requested" || u.state === "starting" || u.state === "grace" || u.state === "inService"
