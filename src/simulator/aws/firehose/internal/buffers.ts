import type { TimerHandle } from "../../../VirtualTime.ts"

/**
 * What a Firehose stream holds: records as counts on their way through, the buffers they gather in, and the per-buffer
 * state of delivery (see `delivery.ts`).
 */

/** Records on their way through: how many, how big, and when the oldest was born and arrived. */
export interface Chunk {
  records: number
  bytes: number
  born: number
  arrived: number
}

/** A buffer that has been flushed: one object (or HTTP request) to deliver. */
export interface Delivery extends Chunk {
  attempts: number
  /** When the first failed attempt ended, or -1: the retry duration counts from here. */
  failingSince: number
}

/** Records gathering towards one delivery or one transformation batch, with the timer that flushes them. */
export class Gather implements Chunk {
  records = 0
  bytes = 0
  born = Number.POSITIVE_INFINITY
  arrived = Number.POSITIVE_INFINITY
  timer: TimerHandle | undefined

  add(c: Chunk): void {
    this.records += c.records
    this.bytes += c.bytes
    if (c.born < this.born) this.born = c.born
    if (c.arrived < this.arrived) this.arrived = c.arrived
  }

  /** Empty it, handing back what it held. */
  take(): Chunk {
    const c = { records: this.records, bytes: this.bytes, born: this.born, arrived: this.arrived }
    this.timer?.cancel()
    this.timer = undefined
    this.records = 0
    this.bytes = 0
    this.born = Number.POSITIVE_INFINITY
    this.arrived = Number.POSITIVE_INFINITY
    return c
  }
}

/** One buffer's worth of state: a Direct PUT stream has one, a Kinesis-sourced stream one per source shard. */
export class Lane {
  readonly transformBuffer = new Gather()
  readonly transformQueue: Array<Chunk> = []
  transformInflight = 0
  readonly buffer = new Gather()
  readonly pending: Array<Delivery> = []
  /** The delivery being made or waiting out a retry: the lane delivers in order, one at a time. */
  head: Delivery | undefined
  retry: TimerHandle | undefined

  constructor(readonly name: string) {}

  /** The head delivery has failed and is being retried: a Kinesis source stops reading this shard meanwhile. */
  get failing(): boolean {
    return this.head !== undefined && this.head.failingSince >= 0
  }

  get idle(): boolean {
    return this.head === undefined && this.pending.length === 0 && this.buffer.records === 0 && this.transformBuffer.records === 0 && this.transformQueue.length === 0 && this.transformInflight === 0
  }
}

/** A stable key for a Firehose stream's objects: they share the time-based prefix (YYYY/MM/DD/HH) of one stream. */
export const keyOf = (id: string): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return (h >>> 0) / 4294967296
}
