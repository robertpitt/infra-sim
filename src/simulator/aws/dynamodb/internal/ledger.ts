/**
 * The region's ledger of provisioned throughput: what every provisioned table (and its indexes) has asked of the
 * account, so that the total stays under the account quota. AWS: the account quota "apply to the sum of the
 * provisioned throughput capacity for all your account's tables and global secondary indexes in a given Region", and
 * only to provisioned tables (ServiceQuotas, "Throughput default quotas").
 *
 * Tables are served in creation order: each gets what the account quota has left after the tables created before it.
 * The ledger keeps an entry for every table, even one that is on-demand right now (it holds zero), so a table that
 * switches mode and back keeps its place instead of going to the back of the queue.
 */
export interface Claim {
  read: number
  write: number
}

export class Ledger {
  readonly claims = new Map<string, Claim>()
  /** Changes whenever a claim does, so each table knows when its share needs working out again. */
  version = 0

  /** Record what `id` asks for. Bumps the version only when something actually changed. */
  claim(id: string, read: number, write: number): void {
    const held = this.claims.get(id)
    if (held === undefined) {
      this.claims.set(id, { read, write })
      this.version++
    } else if (held.read !== read || held.write !== write) {
      held.read = read
      held.write = write
      this.version++
    }
  }

  /** What the tables created before `id` hold of one direction. */
  heldBefore(id: string, op: "read" | "write"): number {
    let before = 0
    for (const [other, held] of this.claims) {
      if (other === id) break
      before += held[op]
    }
    return before
  }
}
