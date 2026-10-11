import { READ_UNIT_BYTES, WRITE_UNIT_BYTES } from "./config.ts"

/**
 * Capacity unit maths (read-write-operations): each item is rounded up to the next 4 KB for reads and 1 KB for writes,
 * then the units are added up. A batch is the sum of its rounded items, not the rounded sum. An item of zero bytes
 * still costs one unit: DynamoDB has no smaller charge.
 */

export type ReadConsistency = "eventual" | "strong" | "transactional"

/** What one 4 KB read costs: half a unit eventually consistent, one strongly consistent, two in a transaction. */
export const readFactor = (consistency: ReadConsistency): number => (consistency === "strong" ? 1 : consistency === "transactional" ? 2 : 0.5)

/** Read units for `count` items of `itemBytes` each. */
export const readUnits = (itemBytes: number, count: number, consistency: ReadConsistency): number =>
  Math.max(1, Math.ceil(itemBytes / READ_UNIT_BYTES)) * readFactor(consistency) * count

/** Write units for `count` items of `itemBytes` each; a transactional write is two writes, prepare and commit. */
export const writeUnits = (itemBytes: number, count: number, transactional: boolean): number =>
  Math.max(1, Math.ceil(itemBytes / WRITE_UNIT_BYTES)) * (transactional ? 2 : 1) * count

/** Bytes one entry occupies in an index: the whole item when no projection is set, else the stated size. */
export const entryBytes = (configured: number, itemBytes: number): number => (configured > 0 ? configured : itemBytes)

/**
 * Index write units one table write costs in total, for `indexes` alike indexes. A write touches an index with
 * probability `share`; one that moves the entry (changes the index key) is a delete plus a put, two writes. The
 * result is the expected cost, taken as a fractional charge so a busy table sees the average without noise.
 */
export const indexWriteUnits = (entry: number, count: number, share: number, keyChangeShare: number): number =>
  Math.max(1, Math.ceil(entry / WRITE_UNIT_BYTES)) * count * share * (1 + keyChangeShare)

/**
 * Read units of a Query on an index. Index entries are read eventually consistently, and a Query is one read of
 * everything it returns: the sizes are added up and rounded up to 4 KB once (AWS's example: 8 entries of 2,000 bytes
 * are 16 KB, so 0.5 x 4 = 2 units). `count` is how many entries the query returns.
 */
export const indexReadUnits = (entry: number, count: number): number => Math.max(1, Math.ceil((entry * count) / READ_UNIT_BYTES)) * 0.5
