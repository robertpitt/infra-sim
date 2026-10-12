import { Duration } from "effect"
import type { Fast } from "../../Component.ts"
import type { Source } from "../../Distribution.ts"
import type { TimerHandle } from "../../VirtualTime.ts"
import { type Config, INSTANCE_TYPES, SEARCH_QUEUE, searchThreads, WRITE_QUEUE, writeThreads } from "./config.ts"
import { DataNode } from "./node.ts"

/**
 * The domain's data nodes and where the index's shards live on them: which node holds each copy of each shard, which
 * copy is the primary, and what happens to them when nodes fail and come back.
 *
 * **Placement.** Copies are dealt out like OpenSearch's balanced allocator does: primaries first, then each round of
 * replicas, each to the next node that doesn't already hold a copy of that shard (two copies of a shard never share a
 * node). Shard counts that are a multiple of the node count come out even, and others don't, which is the skew AWS
 * warns about. Copies that can't be placed (more copies than nodes) stay unassigned and the cluster is yellow.
 *
 * **Zones.** Data node `i` is in the `(i mod z)`-th of the domain's `z` Availability Zones (`availabilityZones`), counted
 * round robin over the region's zones from the node's own zone (or the region's first). With more than one, the
 * allocator is zone aware, as OpenSearch Service makes it: a copy goes to a node in a zone that holds no copy of its
 * shard yet, while there is one, so a shard's copies are in as many zones as they can be (managedomains-multiaz).
 *
 * **Failure.** A failed node loses its copies: the first `failover.failedNodes` nodes, and every node in a zone that is
 * down. A shard whose primary was there has none until the cluster notices (`failover.detection`) and promotes a copy on
 * a live node; writes for it wait meanwhile. With no live copy the shard is red: writes wait until their timeout and
 * searches get nothing from it. A node that comes back brings its copies back (as replicas; a shard with no primary
 * takes the returning copy as its primary).
 */

/** The region's zones, the domain's first, and which are down: updated when faults change, read when nodes are counted. */
export class ZoneMap {
  anyLost = false
  readonly lost: Uint8Array

  constructor(
    /** The region's zones, in order; empty in a place with none. */
    readonly names: ReadonlyArray<string>,
    /** The index of the domain's first zone: the node's own, or the region's first. */
    readonly base: number
  ) {
    this.lost = new Uint8Array(names.length)
  }
}

/** One shard of the index and its copies. */
export class Shard {
  /** The node holding the primary, or -1 while it has none. */
  primary: number
  promotion: TimerHandle | undefined = undefined
  /** Writes waiting for a primary. */
  readonly waiting: Array<Waiter> = []

  constructor(
    readonly id: number,
    /** Nodes holding a copy; the primary was placed on the first. */
    readonly copies: ReadonlyArray<number>
  ) {
    this.primary = copies[0] ?? -1
  }
}

interface Waiter {
  readonly resume: () => void
  readonly timer: TimerHandle
}

export class Cluster {
  readonly nodes: Array<DataNode> = []
  shards: Array<Shard> = []
  /** Replica copies that have no node to go to. */
  unplaced = 0
  /** Replicas promoted to primary after a node failed. */
  promotions = 0
  private applied: Config | undefined
  private layout = ""
  private instance = ""
  private dataNodes = 0
  private failedNodes = 0
  /** Availability Zones the data nodes are spread over (1 when zone awareness is off). */
  private zoneCount = 1

  constructor(private readonly fast: Fast<Config>, readonly zones: ZoneMap = new ZoneMap([], 0)) {}

  /** Nodes in the cluster that are up: the ones after the failed ones, outside a zone that is down. */
  get live(): number {
    if (!this.zones.anyLost) return Math.max(0, this.dataNodes - this.failedNodes)
    let n = 0
    for (let i = 0; i < this.dataNodes; i++) if (this.nodes[i]!.up) n++
    return n
  }

  /** The zone data node `index` is in (an index into the region's zones), or -1 in a place with none. */
  zoneOf(index: number): number {
    const n = this.zones.names.length
    if (n === 0) return -1
    return (this.zones.base + (this.zoneCount > 1 ? index % this.zoneCount : 0)) % n
  }

  /** The name of the zone data node `index` is in, or "" in a place with none. */
  zoneName(index: number): string {
    const z = this.zoneOf(index)
    return z < 0 ? "" : this.zones.names[z]!
  }

  /** Writes waiting for a primary, over every shard. */
  get waiting(): number {
    let n = 0
    for (const shard of this.shards) n += shard.waiting.length
    return n
  }

  /** A node to coordinate a request, chosen at random among the live ones, as the domain endpoint spreads requests. */
  coordinator(random: Source): DataNode | undefined {
    const live = this.live
    if (live === 0) return undefined
    const pick = Math.floor(random.nextDoubleUnsafe() * live)
    // With no zone down the live nodes are the ones after the failed ones.
    if (!this.zones.anyLost) return this.nodes[this.failedNodes + pick]
    let k = pick
    for (let i = 0; i < this.dataNodes; i++) {
      const node = this.nodes[i]!
      if (node.up && k-- === 0) return node
    }
    return undefined
  }

  /** The shard a routing hash in [0, 1) lands on. */
  shardOf(key: number): Shard {
    const n = this.shards.length
    return this.shards[Math.min(n - 1, Math.max(0, Math.floor(key * n)))]!
  }

  /** Shard `index`, or the one it maps to if the index has fewer shards now. */
  shard(index: number): Shard {
    return this.shards[index % this.shards.length]!
  }

  /** Wait for a shard to have a primary: `resume` then, or `timeout` after `ms` if it still has none. */
  waitForPrimary(shard: Shard, ms: number, resume: () => void, timeout: () => void): void {
    const waiter: Waiter = {
      resume,
      timer: this.fast.after(ms, () => {
        const i = shard.waiting.indexOf(waiter)
        if (i >= 0) shard.waiting.splice(i, 1)
        timeout()
      }, undefined)
    }
    shard.waiting.push(waiter)
  }

  /** 2 red (a shard has no live copy), 1 yellow (a copy is missing or a primary is being replaced), 0 green. */
  status(): number {
    let status = this.unplaced > 0 ? 1 : 0
    for (const shard of this.shards) {
      let live = 0
      for (const n of shard.copies) if (this.nodes[n]!.up) live++
      if (live === 0) return 2
      if (live < shard.copies.length || shard.primary < 0) status = 1
    }
    return status
  }

  /** Copies not serving: unplaced, or on a failed node. */
  unassigned(): number {
    let n = this.unplaced
    for (const shard of this.shards) for (const c of shard.copies) if (!this.nodes[c]!.up) n++
    return n
  }

  /**
   * Make the cluster match the settings: instance type, node count, shard layout, failed nodes. Settings are read on
   * every request, so this is a no-op unless they changed.
   */
  reconcile(c: Config): void {
    if (c === this.applied) return
    this.applied = c
    const type = INSTANCE_TYPES[c.instanceType]
    const vcpu = type.vcpu
    while (this.nodes.length < c.dataNodes) {
      this.nodes.push(new DataNode(
        this.nodes.length,
        this.fast,
        vcpu,
        () => writeThreads(INSTANCE_TYPES[this.fast.settings().instanceType].vcpu),
        () => searchThreads(INSTANCE_TYPES[this.fast.settings().instanceType].vcpu),
        WRITE_QUEUE,
        SEARCH_QUEUE
      ))
    }
    if (c.instanceType !== this.instance) {
      this.instance = c.instanceType
      for (const node of this.nodes) {
        node.cpu.setCores(vcpu)
        node.kick()
      }
    }

    this.dataNodes = c.dataNodes
    this.failedNodes = Math.min(c.failover.failedNodes, c.dataNodes)
    this.zoneCount = Math.max(1, Math.min(c.availabilityZones, this.zones.names.length))
    const { down, back } = this.mark()

    const layout = `${c.dataNodes}/${c.primaryShards}/${c.replicas}/${this.zoneCount}`
    let carried: Array<Waiter> = []
    if (layout !== this.layout) {
      this.layout = layout
      carried = this.place(c)
    } else {
      this.failOver(c, down)
      this.recover(back)
    }

    // Callbacks last, once the shards say where things are now: lost writes find their shard waiting for a primary.
    for (const node of down) node.fail()
    for (const waiter of carried) waiter.resume()
  }

  /**
   * Which nodes are up: not among the first `failedNodes`, and not in a zone that is down. Nodes past `dataNodes` (after
   * a scale-in) hold nothing and count as up. Returns the nodes that went down and came back.
   */
  private mark(): { readonly down: Array<DataNode>; readonly back: Array<DataNode> } {
    const down: Array<DataNode> = []
    const back: Array<DataNode> = []
    const lost = this.zones.lost
    for (const node of this.nodes) {
      const up = node.index >= this.failedNodes && !(this.zones.anyLost && lost[this.zoneOf(node.index)] === 1)
      if (node.up && !up) down.push(node)
      else if (!node.up && up) back.push(node)
      node.up = up
    }
    return { down, back }
  }

  /**
   * A zone went down or came back (`zones` says which are down now): its nodes fail, or return, through the same path
   * as `failover.failedNodes`.
   */
  zonesChanged(): void {
    const c = this.applied
    if (c === undefined) return
    const { down, back } = this.mark()
    this.failOver(c, down)
    this.recover(back)
    for (const node of down) node.fail()
  }

  /** Deal the copies out afresh. Returns the writes that were waiting on the old shards, to be sent again. */
  private place(c: Config): Array<Waiter> {
    const carried: Array<Waiter> = []
    for (const shard of this.shards) {
      shard.promotion?.cancel()
      for (const waiter of shard.waiting) {
        waiter.timer.cancel()
        carried.push(waiter)
      }
    }
    const n = c.dataNodes
    const copies: Array<Array<number>> = Array.from({ length: c.primaryShards }, () => [])
    let cursor = 0
    this.unplaced = 0
    for (let round = 0; round <= c.replicas; round++) {
      for (let s = 0; s < c.primaryShards; s++) {
        if (round >= n) {
          this.unplaced++
          continue
        }
        const held = copies[s]!
        // Zone aware: while some zone has no copy of this shard, only a node in such a zone will do.
        const spread = this.zoneCount > 1 && round < this.zoneCount
        const node = this.next(n, cursor, (k) => !held.includes(k) && (!spread || !held.some((h) => h % this.zoneCount === k % this.zoneCount)))
          ?? this.next(n, cursor, (k) => !held.includes(k))!
        held.push(node)
        cursor = node + 1
      }
    }
    // The cluster already knows which nodes are down: a primary placed on one is replaced by a live copy at once.
    this.shards = copies.map((held, id) => {
      const shard = new Shard(id, held)
      if (!this.nodes[shard.primary]!.up) shard.primary = held.find((node) => this.nodes[node]!.up) ?? -1
      return shard
    })
    return carried
  }

  /** The first node from `cursor` on, round robin over `n`, that `fits`. */
  private next(n: number, cursor: number, fits: (node: number) => boolean): number | undefined {
    for (let k = 0; k < n; k++) {
      const node = (cursor + k) % n
      if (fits(node)) return node
    }
    return undefined
  }

  /** Nodes went down: their primaries are replaced by a live copy once the cluster notices. */
  private failOver(c: Config, down: ReadonlyArray<DataNode>): void {
    if (down.length === 0) return
    const detection = Duration.toMillis(c.failover.detection)
    for (const shard of this.shards) {
      if (shard.primary < 0 || this.nodes[shard.primary]!.up) continue
      shard.primary = -1
      if (shard.promotion === undefined) shard.promotion = this.fast.after(detection, promote, { cluster: this, shard })
    }
  }

  /** Nodes came back with their copies: a shard with no primary and no promotion coming takes the returning copy. */
  private recover(back: ReadonlyArray<DataNode>): void {
    if (back.length === 0) return
    for (const shard of this.shards) {
      if (shard.primary >= 0 || shard.promotion !== undefined) continue
      const copy = shard.copies.find((node) => this.nodes[node]!.up)
      if (copy !== undefined) this.elect(shard, copy)
    }
  }

  /** @internal The detection delay has passed: promote a live copy, if there is one. */
  promote(shard: Shard): void {
    shard.promotion = undefined
    if (shard.primary >= 0 || this.shards[shard.id] !== shard) return
    const copy = shard.copies.find((node) => this.nodes[node]!.up)
    if (copy === undefined) return
    this.promotions++
    this.elect(shard, copy)
  }

  private elect(shard: Shard, node: number): void {
    shard.primary = node
    const waiting = shard.waiting.splice(0)
    for (const waiter of waiting) waiter.timer.cancel()
    for (const waiter of waiting) waiter.resume()
  }
}

const promote = ({ cluster, shard }: { cluster: Cluster; shard: Shard }): void => cluster.promote(shard)
