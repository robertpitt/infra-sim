import type { Fast, Zones } from "../../Component.ts"
import * as Distribution from "../../Distribution.ts"
import { Slots } from "../../kit/Slots.ts"
import { type Tally, tallies } from "../../kit/Tally.ts"
import type { Meter, Sampler } from "../../Telemetry.ts"
import { classOf, defaultMaxConnections, isAurora } from "./catalog.ts"
import type { Config } from "./config.ts"
import { DEFAULT_POLICY } from "./client.ts"
import { type ClientPolicy, Pool, Server } from "./connections.ts"
import { Failover } from "./failover.ts"
import { CLUSTER_STANDBYS, MAX_CONNECTIONS_RANGE, STORAGE } from "./limits.ts"
import { type Shape, Topology, type ZoneEffect } from "./zones.ts"

/** What follows from a database's settings, worked out once per change of them rather than per query. */
export interface Derived {
  readonly aurora: boolean
  readonly vcpu: number
  /** `max_connections` of one instance: the setting, or the default parameter group's, within the engine's range. */
  readonly maxConnections: number
  /** IOPS one instance's storage serves; `Infinity` for Aurora, whose cluster volume isn't provisioned by IOPS. */
  readonly iops: number
  /** Reader instances when nothing is failing over: readers, and a Multi-AZ DB cluster's two readable standbys. */
  readonly readers: number
  /** Whether a failover promotes one of the readers (Aurora with readers, a Multi-AZ DB cluster). */
  readonly promotesReader: boolean
  /** The instances by kind, for placing them in zones (see `zones.ts`). */
  readonly shape: Shape
}

/** The storage's IOPS, as RDS applies the settings: a baseline, or what is provisioned, clamped to what AWS accepts. */
export const iopsOf = (c: Config): number => {
  if (isAurora(c.engine)) return Number.POSITIVE_INFINITY
  const { type, allocated, iops } = c.storage
  const gib = Math.max(STORAGE.minGiB[type], allocated)
  const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi)
  switch (type) {
    case "gp3": {
      if (gib < STORAGE.stripedFromGiB) return STORAGE.gp3.baseline
      if (iops === 0) return STORAGE.gp3.stripedBaseline
      return clamp(iops, STORAGE.gp3.stripedBaseline, Math.min(STORAGE.gp3.maxIops, STORAGE.gp3.maxPerGiB * gib))
    }
    case "io1": {
      const top = gib < STORAGE.stripedFromGiB ? STORAGE.io1.smallMaxIops : STORAGE.io1.maxIops
      return clamp(iops || STORAGE.io1.minIops, Math.max(STORAGE.io1.minIops, STORAGE.io1.minPerGiB * gib), Math.min(top, STORAGE.io1.maxPerGiB * gib))
    }
    case "io2":
      return clamp(iops || STORAGE.io2.minIops, Math.max(STORAGE.io2.minIops, STORAGE.io2.minPerGiB * gib), Math.min(STORAGE.io2.maxIops, STORAGE.io2.maxPerGiB * gib))
  }
}

/** `max_connections` of one instance, as the engine applies the setting: 0 is the default parameter group's. */
export const maxConnectionsOf = (c: Config): number => {
  const range = MAX_CONNECTIONS_RANGE[c.engine]
  if (c.maxConnections === 0) return defaultMaxConnections(c.engine, c.instanceClass)
  return Math.min(Math.max(c.maxConnections, range.min), range.max)
}

export const derive = (c: Config): Derived => {
  const aurora = isAurora(c.engine)
  const standbys = !aurora && c.multiAz === "cluster" ? CLUSTER_STANDBYS : 0
  // Aurora's readers are its failover group; an RDS instance's are its Multi-AZ standbys, and its readers are replicas.
  const members = aurora ? 1 + c.readers : c.multiAz === "instance" ? 2 : 1 + standbys
  return {
    aurora,
    vcpu: classOf(c.instanceClass).vcpu,
    maxConnections: maxConnectionsOf(c),
    iops: iopsOf(c),
    readers: c.readers + standbys,
    promotesReader: aurora ? c.readers > 0 : c.multiAz === "cluster",
    shape: { members, readableMembers: aurora || c.multiAz === "cluster", replicas: aurora ? 0 : c.readers }
  }
}

type FailoverTime = Config["failover"]["aurora"]

/** How long the writer is unavailable while another instance is promoted: the standby, a cluster's standby, an Aurora reader. */
export const promotionTimeOf = (c: Config): FailoverTime => {
  if (isAurora(c.engine)) return c.failover.aurora
  return c.multiAz === "cluster" ? c.failover.multiAzCluster : c.failover.multiAzInstance
}

/** How long the writer is unavailable when nothing can take over and the primary is recovered where it is. */
export const recoveryTimeOf = (c: Config): FailoverTime => (isAurora(c.engine) ? c.failover.auroraRecreate : c.failover.singleAz)

/**
 * One side of the database that runs queries: the writer, or all the readers together (the reader endpoint spreads
 * connections over them, so they are modelled as one pool of their vCPUs, connections and storage).
 */
export class Role {
  readonly server: Server
  /** vCPUs, with the line of queries waiting for one. */
  readonly cpu: Slots
  /** The connections of clients that didn't say how they handle them, together (see `DEFAULT_POLICY`). */
  readonly anonymous: Pool
  /** When storage will have worked through the I/O asked of it so far. */
  private ioFreeAt = 0

  constructor(
    readonly name: "writer" | "reader",
    /** Instances serving this role right now. */
    readonly instances: () => number,
    private readonly derived: () => Derived
  ) {
    this.server = new Server(() => this.instances() * this.derived().maxConnections)
    this.cpu = new Slots(() => this.instances() * this.derived().vcpu, () => Number.POSITIVE_INFINITY)
    this.anonymous = new Pool(this.server, () => DEFAULT_POLICY)
  }

  /** IOPS the role's storage serves: each instance's volume (RDS), or no limit (Aurora). */
  iops(): number {
    return this.instances() * this.derived().iops
  }

  /**
   * How long `ios` I/Os wait behind the ones already asked of storage. A volume works through its IOPS and no faster, so
   * while queries ask for less than that nothing waits, and past it a queue builds (RDS's `DiskQueueDepth`).
   */
  ioWait(now: number, ios: number): number {
    const iops = this.iops()
    if (ios <= 0 || iops === Number.POSITIVE_INFINITY || iops <= 0) return 0
    const start = this.ioFreeAt > now ? this.ioFreeAt : now
    this.ioFreeAt = start + (ios * 1000) / iops
    return start - now
  }

  /** I/Os waiting for storage right now. */
  diskQueue(now: number): number {
    const iops = this.iops()
    if (iops === Number.POSITIVE_INFINITY || this.ioFreeAt <= now) return 0
    return ((this.ioFreeAt - now) * iops) / 1000
  }

  /** Busy vCPUs as a share of all of them. */
  utilization(): number {
    const n = this.instances() * this.derived().vcpu
    return n > 0 ? Math.min(1, this.cpu.running / n) : 0
  }
}

/** One client of the database: its policy and its connections to each role. */
export interface Client {
  readonly policy: () => ClientPolicy
  readonly writer: Pool
  readonly reader: Pool
}

const COUNTERS = ["queries", "reads", "writes", "opened", "refused", "readOnly", "stale", "lost", "unavailable", "failovers"] as const

export interface Stats {
  readonly count: Record<(typeof COUNTERS)[number], Tally>
  /** Time a query spent in the database, from arrival to answer (connecting and queueing included), in ms. */
  readonly queryTime: Sampler
  /** Time spent opening a connection (handshake), in ms. */
  readonly connectTime: Sampler
  /** Time a query waited for a vCPU, in ms. */
  readonly cpuWait: Sampler
  /** Time a query waited for storage behind other I/O, in ms. */
  readonly ioWait: Sampler
  /** Replica lag of each write, while there are readers, in ms. */
  readonly replicaLag: Sampler
}

export const makeStats = (meter: Meter): Stats => ({
  count: tallies(meter, COUNTERS),
  queryTime: meter.sampler("queryTime"),
  connectTime: meter.sampler("connectTime"),
  cpuWait: meter.sampler("cpuWait"),
  ioWait: meter.sampler("ioWait"),
  replicaLag: meter.sampler("replicaLag")
})

/** Why the writer refuses while a failover is under way. A proxy waits these out; a direct client gets the error. */
export const FAILING_OVER = "the primary failed and the database is failing over"
/** Why the writer refuses while its Availability Zone is down and nothing could take over (a Single-AZ instance). */
export const ZONE_DOWN = "the primary's Availability Zone is down and there is no standby in another zone to fail over to"

/**
 * Everything one database's queries share: its writer and readers, its clients, and where its instances are (`zones.ts`).
 *
 * **Failover.** The primary failing is an Outage on the node (or its region) beginning, which the node sees
 * (`primaryFailed`): every connection to the writer is dropped and the writer is unavailable for the failover time, a
 * standby or reader being promoted, or the primary recovered where it is when nothing can take over. The engine keeps
 * refusing calls for as long as the Outage lasts, so a short Outage shows the failover and a long one is the database
 * down for its length. **A zone outage** (`faultsChanged`) loses the instances in that zone: when it is the writer's, a
 * Multi-AZ instance or cluster, or Aurora with a reader in another zone, fails over to it and then serves from there
 * however long the zone is down; a Single-AZ instance (or Aurora with no reader elsewhere) is down until the zone
 * returns. Readers in that zone stop serving and the reader connections are dropped (the readers are one pool, so all of
 * them: their clients reconnect to the readers left).
 */
export class Database {
  readonly writer: Role
  readonly reader: Role
  readonly failover = new Failover()
  readonly clients = new Map<string, Client>()
  readonly topology: Topology
  /** Whether the writer's zone was down at the last change of faults: its going down drops the writer's connections. */
  private writerZoneDown = false
  private memo: { c: Config; value: Derived } | undefined

  constructor(
    readonly id: string,
    readonly fast: Fast<Config>,
    readonly stats: Stats,
    zones: Zones,
    /** The zone the primary is placed in (the node's `zone`); the region's first if none. */
    home?: string
  ) {
    const derived = (): Derived => this.derived()
    this.topology = new Topology(zones, home)
    this.writer = new Role("writer", () => 1, derived)
    this.reader = new Role("reader", () => this.readerInstances(this.fast.now()), derived)
  }

  derived(): Derived {
    const c = this.fast.settings()
    const memo = this.memo
    if (memo !== undefined && memo.c === c) return memo.value
    const value = derive(c)
    this.memo = { c, value }
    this.topology.fit(value.shape)
    return value
  }

  /** A failover that is over has made its promoted instance the writer. */
  settle(now: number): void {
    const t = this.topology
    if (t.promoting < 0 || this.failover.down(now)) return
    t.writer = t.promoting
    t.promoting = -1
    this.writerZoneDown = t.memberDown(t.writer)
  }

  /** Reader instances serving now: one fewer while it is being promoted in a failover, and none in a zone that is down. */
  readerInstances(now: number): number {
    const d = this.derived()
    if (!this.topology.anyDown) {
      const promoting = this.failover.down(now) && this.topology.promoting >= 0 && d.shape.readableMembers
      return promoting ? Math.max(0, d.readers - 1) : d.readers
    }
    this.settle(now)
    return this.topology.readers(d.shape, this.failover.down(now))
  }

  /** Why the writer refuses a request at `now`, if it does: failing over, or its zone down with nothing to take over. */
  writerRefusal(now: number): string | undefined {
    if (this.failover.down(now)) return FAILING_OVER
    if (this.topology.anyDown) {
      this.settle(now)
      if (this.topology.memberDown(this.topology.writer)) return ZONE_DOWN
    }
    return undefined
  }

  /** The Slow and Errors faults of the zone of the instance a query runs on: the writer's, or the reader its key picks. */
  zoneEffect(onWriter: boolean, key: number, now: number): ZoneEffect {
    const t = this.topology
    this.settle(now)
    return t.effect(onWriter ? t.memberZone(t.writer) : t.readerZone(this.derived().shape, this.failover.down(now), key))
  }

  /** The primary failed (an Outage on the node or its region began). One failover at a time. */
  primaryFailed(now: number): void {
    this.settle(now)
    if (this.failover.down(now)) return
    const c = this.fast.settings()
    const target = this.topology.candidate(this.derived().shape)
    this.begin(now, target, target >= 0 ? promotionTimeOf(c) : recoveryTimeOf(c))
  }

  /** Faults changed somewhere: see what the zones' outages did to the instances. */
  faultsChanged(now: number): void {
    const t = this.topology
    this.settle(now)
    const shape = this.derived().shape
    const lostBefore = t.lostReaders(shape)
    t.refresh()
    // The instance being promoted lost its zone: promote another, or recover the writer where it is.
    if (this.failover.down(now) && t.promoting >= 0 && t.memberDown(t.promoting)) {
      const target = t.candidate(shape)
      if (target >= 0) this.begin(now, target, promotionTimeOf(this.fast.settings()))
      else t.promoting = -1
    }
    const writerDown = t.memberDown(t.writer)
    // The primary is lost with its zone: its connections go, and it fails over if an instance elsewhere can take over.
    if (writerDown && !this.writerZoneDown) this.writer.server.dropAll()
    this.writerZoneDown = writerDown
    if (writerDown && !this.failover.down(now)) {
      const target = t.candidate(shape)
      if (target >= 0) this.begin(now, target, promotionTimeOf(this.fast.settings()))
    }
    if (t.lostReaders(shape) > lostBefore) this.reader.server.dropAll()
  }

  /** A failover to `target` (or a recovery in place, -1) begins: the writer's connections are dropped. */
  private begin(now: number, target: number, time: FailoverTime): void {
    this.failover.begin(now, Distribution.latencyMs(time, this.fast.random))
    this.topology.promoting = target
    this.stats.count.failovers.add(1)
    this.writer.server.dropAll()
  }

  /** The client whose requests carry `group`; `undefined` for one that didn't attach itself (see `DEFAULT_POLICY`). */
  client(group: string | undefined): Client | undefined {
    return group === undefined ? undefined : this.clients.get(group)
  }

  attach(key: string, policy: () => ClientPolicy): void {
    if (this.clients.has(key)) return
    this.clients.set(key, { policy, writer: new Pool(this.writer.server, policy), reader: new Pool(this.reader.server, policy) })
  }

  /** Close every client's connections that have been idle too long. */
  sweep(now: number): void {
    this.writer.server.sweep(now)
    this.reader.server.sweep(now)
  }
}
