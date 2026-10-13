/**
 * The writer being unavailable while a failover (or a recovery) runs, and the endpoint's DNS name moving when it is done.
 *
 * What starts one is the database's business (`Database`): its primary failing (an Outage on the node, as it begins) or
 * the primary's Availability Zone going down. From then the writer is unavailable for the failover time of the
 * deployment (a Multi-AZ standby taking over, an Aurora reader being promoted, or a single instance being recovered), and
 * the endpoint's DNS name moves to the new primary when it is done. Clients that cache DNS keep reaching the old one
 * for a while after (`stale`).
 */
export class Failover {
  /** Until when the writer is unavailable. */
  until = 0
  /** When the endpoint last moved to a new primary (its DNS record changed): the end of the last failover. */
  movedAt = Number.NEGATIVE_INFINITY

  /** The writer is unavailable at `now`. */
  down(now: number): boolean {
    return now < this.until
  }

  /** A failover begins at `now` and lasts `durationMs` (one already under way is replaced: its target was lost). */
  begin(now: number, durationMs: number): void {
    this.until = now + durationMs
    this.movedAt = this.until
  }

  /**
   * Whether a request at `now` from a client that caches DNS for `ttlMs` still reaches the old primary. Each client's
   * cache expires at its own moment, so after the move the share still pointing at the old primary falls from all of
   * them to none over one TTL; `u` is a uniform draw.
   */
  stale(now: number, ttlMs: number, u: number): boolean {
    if (ttlMs <= 0 || now < this.movedAt) return false
    const since = now - this.movedAt
    return since < ttlMs && u < 1 - since / ttlMs
  }
}
