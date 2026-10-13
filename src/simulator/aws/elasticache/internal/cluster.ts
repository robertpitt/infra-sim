import type { Counter, Sampler } from "../../../Telemetry.ts"
import type { Derived } from "./derived.ts"
import { READ_ANY, READ_PRIMARY } from "./derived.ts"
import { shardOfSlot, slotOf, Store, type Tally } from "./store.ts"

/**
 * The Availability Zones a cluster's nodes are spread over, and which of them are down. ElastiCache with Multi-AZ puts a
 * shard's replicas in zones other than its primary's (AutoFailover.html); here node `r` of shard `s` is in the
 * `(s + r)`-th zone after the first one, round robin over the region's zones, so a shard's nodes are in different zones
 * (up to as many as there are) and the shards' primaries are spread over them too. Updated when faults change; read on
 * every command, so asking it is one check while no zone is down.
 */
export class ZoneMap {
  /** Whether any zone is down. */
  anyLost = false
  /** Which zones are down, by index into `names`. */
  readonly lost: Uint8Array

  constructor(
    /** The region's zones, in order. Empty in a place with none: then no node is ever lost to a zone. */
    readonly names: ReadonlyArray<string>,
    /** The zone of shard 0's first node (the node's `zone`, or the region's first). */
    readonly base: number
  ) {
    this.lost = new Uint8Array(names.length)
  }

  /** The zone of node `member` of shard `shard`, or -1 in a place with no zones. */
  of(shard: number, member: number): number {
    const n = this.names.length
    return n === 0 ? -1 : (this.base + shard + member) % n
  }
}

const NO_ZONES = new ZoneMap([], 0)

/**
 * How busy the nodes were: the busiest node's share of its busier resource, its shard, and the mean over the nodes; and
 * each resource on its own: the busiest engine thread and the mean of them (EngineCPUUtilization), and the busiest network.
 */
export interface Utilization {
  readonly hottest: number
  readonly hottestShard: number
  readonly mean: number
  readonly hottestEngine: number
  readonly meanEngine: number
  readonly hottestNetwork: number
}

/** What the replication stream is counted by: bytes primaries send their replicas (ReplicationBytes), and replica lag. */
export interface ReplicationMeter {
  readonly bytes: Counter
  readonly lag: Sampler
}

/**
 * The nodes of a node-based cluster: shards of `group` nodes each (a primary and its replicas), the time each node's
 * engine thread and network are next free, which node of each shard is the primary, and when each node is down.
 *
 * Every node is a queue with one server: a command holds the engine for `commandMs` (Valkey and Redis OSS execute
 * commands on one main thread), and a reply holds the network for its bytes at the node's baseline bandwidth. So a
 * node that is offered more than it can do builds a backlog, and every command on it waits, hits included, which is
 * what a hot shard feels like. Nothing is per request but two numbers per node.
 *
 * Node `n` is node `n % group` of shard `floor(n / group)`. All of it is plain arrays, rebuilt only when the number of
 * shards or replicas changes.
 */
export class Cluster<W> {
  readonly stores: Array<Store> = []
  /** Fills in flight per shard, by key, with the requests waiting on each (only with the lock). */
  readonly pending: Array<Map<number, Array<W>>> = []
  readonly engineFree: Float64Array
  readonly networkFree: Float64Array
  /** Engine and network milliseconds used since the last tick, for utilisation. */
  readonly engineBusy: Float64Array
  readonly networkBusy: Float64Array
  readonly downFrom: Float64Array
  readonly downUntil: Float64Array
  /** Which node of each shard is the primary (0..group-1), and the replica being promoted, from when. */
  readonly primary: Int32Array
  readonly promoteTo: Int32Array
  readonly promoteAt: Float64Array
  /** Until when each shard's primary cannot take writes (a failover or a replacement in progress). */
  readonly writesBlockedUntil: Float64Array

  constructor(
    readonly shards: number,
    readonly group: number,
    readonly tally: Tally,
    readonly zones: ZoneMap = NO_ZONES,
    readonly replication?: ReplicationMeter
  ) {
    const nodes = shards * group
    this.engineFree = new Float64Array(nodes)
    this.networkFree = new Float64Array(nodes)
    this.engineBusy = new Float64Array(nodes)
    this.networkBusy = new Float64Array(nodes)
    this.downFrom = new Float64Array(nodes)
    this.downUntil = new Float64Array(nodes)
    this.primary = new Int32Array(shards)
    this.promoteTo = new Int32Array(shards).fill(-1)
    this.promoteAt = new Float64Array(shards)
    this.writesBlockedUntil = new Float64Array(shards)
    for (let s = 0; s < shards; s++) {
      this.stores.push(new Store(tally))
      this.pending.push(new Map())
    }
  }

  get nodes(): number {
    return this.shards * this.group
  }

  /**
   * A cluster with a new shape, holding what this one held. Keys move to the shard that now owns their slot (online
   * resharding, here instantaneous), up to each shard's capacity; the queues and any failover in progress start afresh.
   */
  reshape(shards: number, group: number, d: Derived): Cluster<W> {
    const next = new Cluster<W>(shards, group, this.tally, this.zones, this.replication)
    for (const store of this.stores) {
      for (const [key, entry] of store.entries) {
        const target = next.stores[shardOfSlot(slotOf(key), shards)]!
        if (target.size >= d.capacity) {
          this.tally.evicted()
          continue
        }
        target.entries.set(key, entry)
        if (entry.expires !== Infinity) target.volatile++
      }
    }
    return next
  }

  /** Whether node `n` is serving at `now`: not failed or being replaced, and its zone not down. */
  isUp(n: number, now: number): boolean {
    if (this.downFrom[n]! <= now && now < this.downUntil[n]!) return false
    return !this.zones.anyLost || this.zones.lost[this.zoneOf(n)] !== 1
  }

  /** The zone node `n` is in (an index into the region's zones), or -1. */
  zoneOf(n: number): number {
    return this.zones.of(Math.floor(n / this.group), n % this.group)
  }

  /** Nodes not serving at `now`: failed, being replaced or resynced, or in a zone that is down. */
  nodesDown(now: number): number {
    let down = 0
    for (let n = 0; n < this.nodes; n++) if (!this.isUp(n, now)) down++
    return down
  }

  /**
   * Zone `zone` went down, with its nodes: each shard whose primary was there fails it (`fail`: a replica elsewhere is
   * promoted, or with none the shard waits for a replacement and its data is gone); the shards' other nodes there stop
   * serving until it comes back. Returns the failovers (and replacements) begun.
   */
  zoneLost(zone: number, now: number, d: Derived): number {
    let started = 0
    for (let s = 0; s < this.shards; s++) {
      if (this.zoneOf(this.primaryOf(s, now)) === zone && this.fail(s, now, d).started) started++
    }
    return started
  }

  /**
   * Zone `zone` came back. ElastiCache provisions the nodes it lost only once their zone is up again (AutoFailover.html,
   * "Limitations"), so each of them is replaced first, taking `replacement`; a shard whose primary is one of them waits
   * that long more for its writes.
   */
  zoneBack(zone: number, now: number, d: Derived): void {
    const until = now + d.replacementMs
    for (let n = 0; n < this.nodes; n++) {
      if (this.zoneOf(n) !== zone) continue
      if (this.downFrom[n]! <= now && now < this.downUntil[n]!) this.downUntil[n] = Math.max(this.downUntil[n]!, until)
      else this.down(n, now, until)
      const shard = Math.floor(n / this.group)
      if (this.primaryOf(shard, now) === n) this.writesBlockedUntil[shard] = Math.max(this.writesBlockedUntil[shard]!, until)
    }
  }

  /** The primary node of a shard right now: a promotion lands once its time has come. */
  primaryOf(shard: number, now: number): number {
    const to = this.promoteTo[shard]!
    if (to >= 0 && now >= this.promoteAt[shard]!) {
      this.primary[shard] = to
      this.promoteTo[shard] = -1
    }
    return shard * this.group + this.primary[shard]!
  }

  writable(shard: number, now: number): boolean {
    return now >= this.writesBlockedUntil[shard]! && this.isUp(this.primaryOf(shard, now), now)
  }

  /** The node a read goes to, or -1 when none of the ones it may use is up. */
  reader(shard: number, now: number, readFrom: number, random: () => number): number {
    const primary = this.primaryOf(shard, now)
    if (readFrom === READ_PRIMARY || this.group === 1) return this.isUp(primary, now) ? primary : -1
    const base = shard * this.group
    // Pick at random among the nodes it may read from that are up; replicas first when they are preferred.
    let up = 0
    for (let r = 0; r < this.group; r++) {
      const n = base + r
      if ((readFrom === READ_ANY || n !== primary) && this.isUp(n, now)) up++
    }
    if (up === 0) return this.isUp(primary, now) ? primary : -1
    let pick = Math.floor(random() * up)
    for (let r = 0; r < this.group; r++) {
      const n = base + r
      if ((readFrom === READ_ANY || n !== primary) && this.isUp(n, now) && pick-- === 0) return n
    }
    return primary
  }

  /**
   * Commands waiting at a node: those queued for its engine, and the replies of `itemBytes` queued for its network
   * behind them (a reply leaves once its command has run, so the network's own queue is what lies past the engine's).
   */
  waiting(n: number, now: number, d: Derived): number {
    const engineFree = this.engineFree[n]! > now ? this.engineFree[n]! : now
    const engine = (engineFree - now) / d.commandMs
    const reply = d.itemBytes * d.msPerByte
    const network = reply > 0 && this.networkFree[n]! > engineFree ? (this.networkFree[n]! - engineFree) / reply : 0
    return engine + network
  }

  /** Run one command on a node: wait for its engine, then send `bytes` back over its network. The delay until done. */
  occupy(n: number, now: number, bytes: number, d: Derived): number {
    const engineFree = this.engineFree[n]!
    let done = (engineFree > now ? engineFree : now) + d.commandMs
    this.engineFree[n] = done
    this.engineBusy[n] = this.engineBusy[n]! + d.commandMs
    if (bytes > 0) {
      const transfer = bytes * d.msPerByte
      const networkFree = this.networkFree[n]!
      done = (networkFree > done ? networkFree : done) + transfer
      this.networkFree[n] = done
      this.networkBusy[n] = this.networkBusy[n]! + transfer
    }
    return done - now
  }

  /**
   * A write on a shard's primary reaches every replica: each one's engine applies it, and the primary sends it to each
   * over its network. Nobody waits for it (replication is asynchronous), but it is load all the same.
   *
   * The replica lag recorded is how much later than the primary (`appliedAt`) the last replica has the write: once the
   * primary's network has sent it and the replica's engine has worked through its own queue to it. It grows when a
   * replica or the primary's network is busier than the primary's engine.
   */
  replicate(shard: number, now: number, bytes: number, d: Derived, appliedAt: number): void {
    if (this.group === 1) return
    const primary = this.primaryOf(shard, now)
    const base = shard * this.group
    let sent = 0
    let reached = 0
    let applied = 0
    for (let r = 0; r < this.group; r++) {
      const n = base + r
      if (n === primary || !this.isUp(n, now)) continue
      const free = this.engineFree[n]!
      const done = (free > now ? free : now) + d.commandMs
      this.engineFree[n] = done
      this.engineBusy[n] = this.engineBusy[n]! + d.commandMs
      sent += bytes
      reached++
      if (done > applied) applied = done
    }
    if (sent > 0) {
      const transfer = sent * d.msPerByte
      const free = this.networkFree[primary]!
      const done = (free > now ? free : now) + transfer
      this.networkFree[primary] = done
      this.networkBusy[primary] = this.networkBusy[primary]! + transfer
      if (done > applied) applied = done
    }
    if (reached > 0 && this.replication !== undefined) {
      this.replication.bytes.n += sent
      this.replication.lag.add(applied > appliedAt ? applied - appliedAt : 0)
    }
  }

  /**
   * The primary of a shard fails (AutoFailover.html). With automatic failover and a replica up, the replica is promoted
   * after detection and promotion; writes fail until then, reads from replicas carry on, the other replicas resync from
   * the new primary (unreadable meanwhile) and the failed node comes back as a replica once replaced. Without, the
   * primary is replaced, and writes fail until it is: it is synced from a replica if there is one, and starts empty if
   * not. Memcached has no replicas: the node is replaced and comes back empty. Returns whether data was lost.
   */
  fail(shard: number, now: number, d: Derived): { readonly started: boolean; readonly lost: boolean } {
    if (now < this.writesBlockedUntil[shard]!) return { started: false, lost: false }
    const base = shard * this.group
    const primary = this.primaryOf(shard, now)
    let candidate = -1
    let copies = 0
    for (let r = 0; r < this.group; r++) {
      const n = base + r
      if (n === primary || !this.isUp(n, now)) continue
      copies++
      if (candidate < 0) candidate = r
    }
    if (d.automaticFailover && candidate >= 0) {
      const promoted = now + d.detectionMs + d.promotionMs
      this.promoteTo[shard] = candidate
      this.promoteAt[shard] = promoted
      this.writesBlockedUntil[shard] = promoted
      this.down(primary, now, promoted + d.replacementMs)
      for (let r = 0; r < this.group; r++) {
        const n = base + r
        if (n !== primary && r !== candidate && this.isUp(n, now)) this.down(n, promoted, promoted + d.resyncMs)
      }
      return { started: true, lost: false }
    }
    const back = now + d.detectionMs + d.replacementMs
    this.writesBlockedUntil[shard] = back
    this.down(primary, now, back)
    if (copies > 0) return { started: true, lost: false }
    this.stores[shard]!.clear()
    return { started: true, lost: true }
  }

  /**
   * How busy each node was over the last `periodMs` (its engine or its network, whichever was busier), and start the
   * next period. The hottest node is what a hot key shows up as.
   */
  utilization(periodMs: number): Utilization {
    let hottest = 0
    let hottestShard = 0
    let all = 0
    let hottestEngine = 0
    let allEngine = 0
    let hottestNetwork = 0
    const nodes = this.nodes
    for (let n = 0; n < nodes; n++) {
      const engine = Math.min(1, this.engineBusy[n]! / periodMs)
      const network = Math.min(1, this.networkBusy[n]! / periodMs)
      this.engineBusy[n] = 0
      this.networkBusy[n] = 0
      const used = engine > network ? engine : network
      all += used
      allEngine += engine
      if (engine > hottestEngine) hottestEngine = engine
      if (network > hottestNetwork) hottestNetwork = network
      if (used > hottest) {
        hottest = used
        hottestShard = Math.floor(n / this.group)
      }
    }
    return { hottest, hottestShard, mean: nodes > 0 ? all / nodes : 0, hottestEngine, meanEngine: nodes > 0 ? allEngine / nodes : 0, hottestNetwork }
  }

  items(): number {
    let n = 0
    for (const store of this.stores) n += store.size
    return n
  }

  /** The fullest shard's share of its data memory (DatabaseMemoryUsagePercentage, of the worst shard). */
  memoryUsed(capacity: number): number {
    if (capacity === Infinity) return 0
    let most = 0
    for (const store of this.stores) if (store.size > most) most = store.size
    return capacity > 0 ? Math.min(1, most / capacity) : 1
  }

  /** Shards whose primary cannot take writes right now. */
  writeBlocked(now: number): number {
    let n = 0
    for (let s = 0; s < this.shards; s++) if (!this.writable(s, now)) n++
    return n
  }

  private down(n: number, from: number, until: number): void {
    this.downFrom[n] = from
    this.downUntil[n] = until
  }
}
