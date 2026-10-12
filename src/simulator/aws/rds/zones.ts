import type { Zones } from "../../Component.ts"

/**
 * Where a database's instances live, in the Availability Zones of its region, and which of them is the writer.
 *
 * AWS puts a database's instances in zones: the primary in one, a Multi-AZ DB instance's standby in another
 * (Concepts.MultiAZSingleStandby), a Multi-AZ DB cluster's two readable standbys in two others (multi-az-db-clusters-concepts),
 * and Aurora's readers wherever you create them, AWS recommending two or more zones (Concepts.AuroraHighAvailability).
 * The model:
 *
 * - **The failover group**: the instances that can become the writer. Member 0 is the original primary, in the node's
 *   zone (its `zone`, or the region's first); member k is in the k-th zone after it, round robin over the region's zones.
 *   A Single-AZ instance is member 0 alone; a Multi-AZ instance adds its standby (member 1, serving nothing); a Multi-AZ
 *   cluster has three members and Aurora one per reader besides the writer, and those serve reads while not the writer.
 * - **RDS read replicas** (not failover targets): replica i is in the (i + 1)-th zone after the original primary's, and
 *   stays there whatever the writer does.
 * - **The writer** is one member. A failover promotes another, the next one after it whose zone is up, which becomes the
 *   writer when the failover is done; the old writer becomes a reader (Aurora, a cluster) or the standby (an instance).
 *
 * In a place with no zones nothing is ever lost to one. Zone outages are read when faults change (`refresh`), so the
 * hot path asks flags, not the fault set.
 */

/** How many of each kind of instance a database has, from its settings (see `Derived`). */
export interface Shape {
  /** The failover group: the writer and the instances that can take over from it. */
  readonly members: number
  /** Whether members serve reads when they aren't the writer (Aurora Replicas, a cluster's standbys). */
  readonly readableMembers: boolean
  /** RDS read replicas: they serve reads and never become the writer. */
  readonly replicas: number
}

/** A zone's Slow and Errors faults, as a query on an instance there feels them. */
export interface ZoneEffect {
  readonly extraMs: number
  readonly errorRate: number
}

export const NO_EFFECT: ZoneEffect = { extraMs: 0, errorRate: 0 }

export class Topology {
  /** The member that is the writer. */
  writer = 0
  /** The member being promoted while a failover is under way, or -1 (a Single-AZ instance recovering in place). */
  promoting = -1
  /** Whether any zone is down: false keeps every question on the hot path one check. */
  anyDown = false
  /** Whether any zone has a Slow or Errors fault. */
  anyEffect = false
  private readonly home: number
  private readonly down: Uint8Array
  private readonly effects: Array<ZoneEffect>

  constructor(
    private readonly zones: Zones,
    /** The zone the original primary is in: the node's own, or else the region's first. */
    home: string | undefined
  ) {
    const at = home === undefined ? 0 : zones.all.indexOf(home)
    this.home = at < 0 ? 0 : at
    this.down = new Uint8Array(zones.all.length)
    this.effects = zones.all.map(() => NO_EFFECT)
  }

  /** The zone a member of the failover group is in (an index into the region's zones), or -1 in a place with none. */
  memberZone(member: number): number {
    const n = this.zones.all.length
    return n === 0 ? -1 : (this.home + member) % n
  }

  /** The zone an RDS read replica is in. */
  replicaZone(replica: number): number {
    const n = this.zones.all.length
    return n === 0 ? -1 : (this.home + 1 + replica) % n
  }

  /** The name of the zone the writer is in, if the region has zones. */
  writerZoneName(): string | undefined {
    const z = this.memberZone(this.writer)
    return z < 0 ? undefined : this.zones.all[z]
  }

  zoneDown(zone: number): boolean {
    return zone >= 0 && this.down[zone] === 1
  }

  memberDown(member: number): boolean {
    return this.anyDown && this.zoneDown(this.memberZone(member))
  }

  /** Read the zones' faults again: called whenever faults change anywhere. */
  refresh(): void {
    const all = this.zones.all
    this.anyDown = false
    this.anyEffect = false
    for (let z = 0; z < all.length; z++) {
      const e = this.zones.effect(all[z]!)
      this.down[z] = e.outage ? 1 : 0
      if (e.outage) this.anyDown = true
      if (e.extraMs > 0 || e.errorRate > 0) {
        this.anyEffect = true
        this.effects[z] = { extraMs: e.extraMs, errorRate: e.errorRate }
      } else this.effects[z] = NO_EFFECT
    }
  }

  /** The Slow and Errors faults of a zone. */
  effect(zone: number): ZoneEffect {
    return zone < 0 ? NO_EFFECT : this.effects[zone] ?? NO_EFFECT
  }

  /** A settings change shrank the failover group under the writer: the writer is member 0 again. */
  fit(s: Shape): void {
    if (this.writer >= s.members) this.writer = 0
    if (this.promoting >= s.members) this.promoting = -1
  }

  /** The member a failover promotes: the next one after the writer, in order, whose zone is up; -1 if there is none. */
  candidate(s: Shape): number {
    for (let j = 1; j < s.members; j++) {
      const k = (this.writer + j) % s.members
      if (!this.zoneDown(this.memberZone(k))) return k
    }
    return -1
  }

  /**
   * Reader instances serving: the readable members that aren't the writer or being promoted (`failingOver`) and the
   * read replicas, those whose zone is up.
   */
  readers(s: Shape, failingOver: boolean): number {
    let n = 0
    if (s.readableMembers) {
      for (let k = 0; k < s.members; k++) {
        if (k === this.writer || (failingOver && k === this.promoting) || this.zoneDown(this.memberZone(k))) continue
        n++
      }
    }
    for (let i = 0; i < s.replicas; i++) if (!this.zoneDown(this.replicaZone(i))) n++
    return n
  }

  /** Reader instances in a zone that is down. */
  lostReaders(s: Shape): number {
    if (!this.anyDown) return 0
    let n = 0
    if (s.readableMembers) for (let k = 0; k < s.members; k++) if (k !== this.writer && this.zoneDown(this.memberZone(k))) n++
    for (let i = 0; i < s.replicas; i++) if (this.zoneDown(this.replicaZone(i))) n++
    return n
  }

  /**
   * The zone of the reader that serves a query with routing hash `key` (in [0, 1)): the reader endpoint spreads
   * connections over the readers serving, so a key picks one of them. -1 when none serves.
   */
  readerZone(s: Shape, failingOver: boolean, key: number): number {
    const serving = this.readers(s, failingOver)
    if (serving === 0) return -1
    let pick = Math.min(serving - 1, Math.floor(key * serving))
    if (s.readableMembers) {
      for (let k = 0; k < s.members; k++) {
        if (k === this.writer || (failingOver && k === this.promoting)) continue
        const z = this.memberZone(k)
        if (this.zoneDown(z)) continue
        if (pick-- === 0) return z
      }
    }
    for (let i = 0; i < s.replicas; i++) {
      const z = this.replicaZone(i)
      if (this.zoneDown(z)) continue
      if (pick-- === 0) return z
    }
    return -1
  }
}
