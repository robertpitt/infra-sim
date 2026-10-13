import type { Bucket, Limiter } from "../../../Limiter.ts"
import type { Account } from "../../internal/account.ts"
import { FIFO_NORMAL_TPS, FIFO_PARTITION_TPS, type QueueConfig } from "./config.ts"
import type { Group } from "./types.ts"

/**
 * A FIFO queue's limit in API calls per second per action: 300 in normal mode, and in high-throughput mode the region's
 * quota (an account setting, so it is live and editable). One call carries up to ten messages, so a batched call is
 * how a FIFO queue reaches 3,000 messages a second.
 */
export const fifoRate = (c: QueueConfig, account: Account): number => (c.highThroughput ? account.sqsFifoHighThroughput : FIFO_NORMAL_TPS)

/** A token bucket for one action of one queue (sends, receives), at whatever rate the queue's mode sets right now. */
export class FifoRate {
  private bucket: Bucket | undefined

  constructor(private readonly key: string, private readonly limiter: Limiter) {}

  /** Spend `calls` API calls at `rate` per second (and a burst of the same size). */
  take(rate: number, calls: number): boolean {
    if (this.bucket === undefined || this.bucket.rate !== rate) this.bucket = { rate, burst: rate }
    return this.limiter.takeUnsafe(this.key, this.bucket, calls)
  }
}

/**
 * One FIFO partition takes 300 calls a second, and every message of a group lives on one partition, so a single group
 * cannot be sent to faster than that however high the queue's limit is. (AWS does not publish how groups map to
 * partitions, so this is the ceiling for one group, not a prediction of when a shared partition fills.) The bucket lives on
 * the group, so it is forgotten with the group once the group is empty.
 */
export const takePartition = (g: Group, calls: number, now: number): boolean => {
  g.tokens = g.tokensAt < 0 ? FIFO_PARTITION_TPS : Math.min(FIFO_PARTITION_TPS, g.tokens + ((now - g.tokensAt) * FIFO_PARTITION_TPS) / 1000)
  g.tokensAt = now
  const needed = Math.min(calls, FIFO_PARTITION_TPS)
  if (g.tokens < needed) return false
  g.tokens -= needed
  return true
}
