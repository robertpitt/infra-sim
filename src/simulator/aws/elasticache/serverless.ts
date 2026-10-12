import type { Bucket, Limiter } from "../../Limiter.ts"
import { ECPU_BYTES, HASH_SLOTS } from "./config.ts"
import type { Derived } from "./derived.ts"

/** Scale out when the busiest second of the last interval used more than this share of what the cache supports. An assumption. */
const SCALE_AT = 0.5

/** ECPUs a simple command costs: 1 per KB transferred, and never less than 1 (WhatIs.corecomponents.html). */
export const ecpuOf = (bytes: number): number => (bytes > ECPU_BYTES ? bytes / ECPU_BYTES : 1)

/**
 * What an ElastiCache Serverless cache can do right now (Scaling-serverless.html): it starts at 30,000 ECPUs a second
 * (90,000 when reads go to replicas, or the pre-scaled minimum), may double every 2 to 3 minutes while traffic presses
 * on it, never above the configured maximum; and each hash slot serves at most 30,000 ECPUs a second (90,000 reading
 * from replicas) however large the cache has grown, so a hot key is throttled where it lives. Over either, the request
 * is throttled. Both are token buckets holding one second.
 *
 * AWS does not say when the cache scales or whether it scales back in; here it doubles when its busiest second in the
 * interval passed half of what it supports, and does not shrink during a run.
 */
export class ServerlessCapacity {
  ceiling: number
  private bucket: Bucket
  private readonly cacheKey: string
  private readonly slotKeys: Array<string> = []
  private readonly readKeys: Array<string> = []
  /** ECPUs asked for this second (served or not), and the busiest second since the last scaling decision. */
  private demand = 0
  private peak = 0
  private decidedAt = 0
  private slotBuckets: { read: Bucket; write: Bucket; separate: boolean } | undefined
  private slotFrom: Derived | undefined

  constructor(private readonly prefix: string, d: Derived) {
    this.cacheKey = `${prefix}/ecpu`
    this.ceiling = Math.min(d.ecpuMax, d.ecpuStart)
    this.bucket = { rate: this.ceiling, burst: this.ceiling }
  }

  /** Keep the ceiling within what the settings now allow: at least the start (or pre-scaled minimum), at most the maximum. */
  configure(d: Derived): void {
    const ceiling = Math.min(d.ecpuMax, Math.max(this.ceiling, d.ecpuStart))
    if (ceiling !== this.ceiling) this.setCeiling(ceiling)
  }

  /** Take `cost` ECPUs for a command on `slot`; false when the slot or the cache is out of throughput. */
  admit(limiter: Limiter, slot: number, cost: number, read: boolean, d: Derived): boolean {
    this.demand += cost
    if (this.slotFrom !== d) {
      this.slotFrom = d
      // Reading from replicas, reads have the replicas' throughput and writes the primary's; otherwise they share one.
      const separate = d.slotEcpuRead !== d.slotEcpuWrite
      this.slotBuckets = { read: { rate: d.slotEcpuRead, burst: d.slotEcpuRead }, write: { rate: d.slotEcpuWrite, burst: d.slotEcpuWrite }, separate }
    }
    const buckets = this.slotBuckets!
    const slotKey = read && buckets.separate ? this.keyOf(this.readKeys, "r", slot) : this.keyOf(this.slotKeys, "w", slot)
    if (!limiter.takeUnsafe(slotKey, read ? buckets.read : buckets.write, cost)) return false
    return limiter.takeUnsafe(this.cacheKey, this.bucket, cost)
  }

  /** Once a second: note the second's demand, and at the end of each interval decide whether to double. */
  tick(now: number, d: Derived): void {
    if (this.demand > this.peak) this.peak = this.demand
    this.demand = 0
    if (now - this.decidedAt < d.scaleIntervalMs) return
    this.decidedAt = now
    if (this.peak > this.ceiling * SCALE_AT && this.ceiling < d.ecpuMax) this.setCeiling(Math.min(d.ecpuMax, this.ceiling * 2))
    this.peak = 0
  }

  private setCeiling(ceiling: number): void {
    this.ceiling = ceiling
    this.bucket = { rate: ceiling, burst: ceiling }
  }

  /** Limiter keys per slot, made once each: a string per command would be garbage on the hot path. */
  private keyOf(keys: Array<string>, kind: string, slot: number): string {
    const s = slot < HASH_SLOTS ? slot : HASH_SLOTS - 1
    return keys[s] ?? (keys[s] = `${this.prefix}/slot/${kind}${s}`)
  }
}
