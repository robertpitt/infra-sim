import { Duration } from "effect"
import type { Bucket } from "../../../Limiter.ts"
import type { Account } from "../../internal/account.ts"
import { type Config, ON_DEMAND_BASELINE, PARTITION } from "./config.ts"
import type { Ledger } from "./ledger.ts"
import { OnDemandScaler } from "./scaling.ts"

/**
 * What a table, and each of its global secondary indexes, can do right now: throughput per direction, how that is
 * enforced (a token bucket) and what a throttle by it looks like. It is worked out once per change of settings,
 * account quotas, the set of tables or an on-demand ceiling, never per request: with dozens of tables sharing an
 * account this is the hot path, and `Capacity` is the thing the component memoises.
 */

export type Op = "read" | "write"

/** One direction of one resource (the table or one index). */
export interface Direction {
  /** Units per second it can sustain. */
  readonly rate: number
  /** The bucket that enforces it: `rate` refill, with banked burst capacity (provisioned) or a short smoothing (on-demand). */
  readonly bucket: Bucket
  /** The error a request gets when this resource is out of throughput. */
  readonly throttle: string
  /** The error a request gets when the partition it lands on is out of throughput (a hot key). */
  readonly keyRange: string
}

export interface Resource {
  readonly read: Direction
  readonly write: Direction
  /** Partitions behind it: what a request's key is spread over. */
  readonly partitions: number
}

export interface Capacity {
  readonly table: Resource
  /** One entry per global secondary index (they are all alike; each has its own buckets and, on-demand, its own peak). */
  readonly indexes: ReadonlyArray<Resource>
  readonly onDemand: boolean
}

/** The scalers behind on-demand capacity, one per direction of the table and of each index. */
export class Scalers {
  /** Bumped whenever any scaler's ceiling may have moved. */
  readonly changes = { n: 0 }
  readonly table = { read: new OnDemandScaler(this.changes), write: new OnDemandScaler(this.changes) }
  private readonly indexes: Array<{ read: OnDemandScaler; write: OnDemandScaler }> = []

  index(i: number): { read: OnDemandScaler; write: OnDemandScaler } {
    while (this.indexes.length <= i) this.indexes.push({ read: new OnDemandScaler(this.changes), write: new OnDemandScaler(this.changes) })
    return this.indexes[i]!
  }
}

export const partitionCount = (explicit: number, readRate: number, writeRate: number): number =>
  explicit > 0 ? explicit : Math.max(1, Math.ceil(Math.max(readRate / PARTITION.read, writeRate / PARTITION.write)))

interface Inputs {
  readonly id: string
  readonly c: Config
  readonly account: Account
  readonly ledger: Ledger
  readonly scalers: Scalers
  readonly now: number
}

/** How many indexes the table really has: what is asked for, within the account's per-table index quota. */
export const indexCount = (c: Config, account: Account): number => Math.min(c.gsi.count, account.dynamodbIndexesPerTable)

export const buildCapacity = ({ id, c, account, ledger, scalers, now }: Inputs): Capacity => {
  const onDemand = c.mode === "on-demand"
  const indexes = indexCount(c, account)
  const tableQuota = { read: account.dynamodbTableReadUnits, write: account.dynamodbTableWriteUnits }
  const accountQuota = { read: account.dynamodbAccountReadUnits, write: account.dynamodbAccountWriteUnits }
  const requested = {
    table: { read: c.readCapacity, write: c.writeCapacity },
    // An index asks for the table's capacity unless told otherwise: AWS advises indexes at least as wide as the table.
    index: { read: c.gsi.readCapacity > 0 ? c.gsi.readCapacity : c.readCapacity, write: c.gsi.writeCapacity > 0 ? c.gsi.writeCapacity : c.writeCapacity }
  }

  // The ledger holds the table and its indexes together, each clamped to the per-table quota; on-demand holds nothing.
  if (onDemand) ledger.claim(id, 0, 0)
  else {
    const held = (op: Op) => Math.min(requested.table[op], tableQuota[op]) + indexes * Math.min(requested.index[op], tableQuota[op])
    ledger.claim(id, held("read"), held("write"))
  }

  /** Provisioned throughput of the table and its indexes in one direction: what the account has left, in order. */
  const provisioned = (op: Op): { table: number; indexes: Array<number> } => {
    let left = Math.max(0, accountQuota[op] - ledger.heldBefore(id, op))
    const share = (asked: number): number => {
      const units = Math.max(1, Math.min(asked, tableQuota[op], left))
      left = Math.max(0, left - units)
      return units
    }
    const table = share(requested.table[op])
    const each: Array<number> = []
    for (let i = 0; i < indexes; i++) each.push(share(requested.index[op]))
    return { table, indexes: each }
  }
  const granted = onDemand ? undefined : { read: provisioned("read"), write: provisioned("write") }

  const direction = (op: Op, kind: "Table" | "Index", provisionedUnits: number, scaler: OnDemandScaler, max: number, warm: number): Direction => {
    const label = `${kind}${op === "read" ? "Read" : "Write"}`
    if (!onDemand) {
      return {
        rate: provisionedUnits,
        bucket: { rate: provisionedUnits, burst: provisionedUnits * Math.max(1, c.burstSeconds) },
        throttle: `ProvisionedThroughputExceededException (${label}ProvisionedThroughputExceeded)`,
        keyRange: `ProvisionedThroughputExceededException (${label}KeyRangeThroughputExceeded)`
      }
    }
    const quota = tableQuota[op]
    // A new table, or one pre-warmed, absorbs at least this much at once; the ceiling doubles with its previous peak.
    scaler.configure(Math.min(quota, Math.max(ON_DEMAND_BASELINE[op], warm)), Duration.toMillis(c.onDemand.scaleInterval))
    const scaled = Math.min(quota, scaler.ceiling(now))
    const capped = max > 0 && max <= scaled
    const rate = capped ? max : scaled
    return {
      rate,
      // An on-demand table has no banked capacity to speak of: only a short smoothing of sub-second jitter.
      bucket: { rate, burst: rate / 10 },
      throttle: capped
        ? `ThrottlingException (${label}MaxOnDemandThroughputExceeded)`
        : scaled >= quota
        ? `RequestLimitExceeded (${label}AccountLimitExceeded)`
        : `ThrottlingException (${label}: beyond double the previous peak, still scaling out)`,
      keyRange: `ThrottlingException (${label}KeyRangeThroughputExceeded)`
    }
  }

  const resource = (read: Direction, write: Direction, explicit: number): Resource => ({
    read,
    write,
    partitions: partitionCount(explicit, read.rate, write.rate)
  })

  const table = resource(
    direction("read", "Table", granted?.read.table ?? 0, scalers.table.read, c.onDemand.maxReadUnits, c.onDemand.warmReadUnits),
    direction("write", "Table", granted?.write.table ?? 0, scalers.table.write, c.onDemand.maxWriteUnits, c.onDemand.warmWriteUnits),
    c.partitions
  )
  const each: Array<Resource> = []
  for (let i = 0; i < indexes; i++) {
    const s = scalers.index(i)
    each.push(
      resource(
        direction("read", "Index", granted?.read.indexes[i] ?? 0, s.read, c.gsi.maxReadUnits, 0),
        direction("write", "Index", granted?.write.indexes[i] ?? 0, s.write, c.gsi.maxWriteUnits, 0),
        0
      )
    )
  }
  return { table, indexes: each, onDemand }
}
