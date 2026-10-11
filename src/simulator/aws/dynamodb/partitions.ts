import type { Op } from "./capacity.ts"

/**
 * Which partition a request lands on, and the names of the limiter buckets that enforce each partition's ceiling.
 *
 * A request's `key` is a hash of its partition key in [0, 1): equal keys always land on the same partition, so a hot
 * key keeps hitting one partition however large the table is, and AWS's hard 3,000 read / 1,000 write units a second
 * per partition is what stops it (bp-partition-key-design). Adaptive capacity and burst capacity let a partition use
 * more than its even share of the table's throughput, up to that ceiling and the table's total
 * (burst-adaptive-capacity), which is what checking the partition ceiling and the table's bucket separately models.
 */

/** Index of the partition (of `partitions`) a key falls on. */
export const partitionOf = (key: number, partitions: number): number => Math.min(partitions - 1, Math.floor(key * partitions))

/**
 * The key an index sees for an item of table key `key`. An index is partitioned by its own key attribute, which is
 * usually not the table's, but whatever the table's key space does (a hot key) is reflected in it, so the index key is a
 * fixed function of the table key. Multipliers are integers so a uniform key stays uniform; each index gets its own
 * function so their partitions don't line up. `values` > 0 means the index key has only that many distinct values.
 */
export const indexKeyOf = (key: number, index: number, values: number): number => {
  const mixed = (key * (7 + 2 * index) + 0.37 * index) % 1
  return values > 0 ? Math.floor(mixed * values) / values : mixed
}

/** Bucket names for the partitions of one table or index, made on first use and kept. */
export class PartitionKeys {
  private readonly names: Record<Op, Array<string>> = { read: [], write: [] }

  constructor(private readonly prefix: string) {}

  of(op: Op, partition: number): string {
    const list = this.names[op]
    return list[partition] ?? (list[partition] = `${this.prefix}/p${partition}/${op}`)
  }
}
