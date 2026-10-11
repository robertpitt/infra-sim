import type { Message } from "../../Message.ts"
import type { Deque } from "./Deque.ts"

/**
 * Where a message is in its life in the queue.
 *
 *  - `delayed`: sent with a delay queue's `DelaySeconds`; invisible until it ends (ApproximateNumberOfMessagesDelayed).
 *  - `ready`: can be received (ApproximateNumberOfMessagesVisible).
 *  - `hidden`: received and not yet deleted: in flight, invisible until its visibility timeout (ApproximateNumberOfMessagesNotVisible).
 *  - `gone`: deleted, expired or moved to a dead-letter queue. Nothing refers to it any more, but it may still be
 *    sitting in a queue as a tombstone until that queue is next read.
 */
export type Status = "delayed" | "ready" | "hidden" | "gone"

/**
 * One message in the queue. A call that carries `count` records (a batch send) makes `count` entries, because each
 * record is received, deleted, redelivered and dead-lettered on its own.
 */
export interface Entry {
  readonly id: number
  /**
   * The message as the sender made it. The records of one batch share it (it supplies the origin, the birth time and
   * the group), and `bytes` below is each record's own share of the size.
   */
  readonly message: Message
  readonly bytes: number
  /** FIFO only: the message group. Everything in a group is delivered in order, one message at a time. */
  readonly group: Group | undefined
  /** When this queue accepted it, or for a message moved here by a standard queue's redrive policy, when it first entered the source. Retention counts from here. */
  readonly enqueuedAt: number
  /** ApproximateReceiveCount. */
  receives: number
  /** Which receive call owns it now. A delete or a lapse from an older receive no longer counts (a newer receipt handle superseded it). */
  receipt: number
  status: Status
  /** The retention bucket it is filed in, and where in it. */
  bucket: Bucket
  slot: number
  /** Whether it counts towards ApproximateAgeOfOldestMessage. */
  aged: boolean
}

/** A FIFO message group: its waiting messages in order, and whether one of them is in flight. */
export interface Group {
  readonly id: string
  /** Waiting messages in order. May hold tombstones (expired before they were read); `waiting` counts the live ones. */
  readonly items: Deque<Entry>
  waiting: number
  /** Messages in flight. A FIFO group delivers nothing while any are. */
  hidden: number
  /** Every message of the group, whatever its state. The group object goes away when it reaches zero. */
  live: number
  /** Tombstones in `items`. */
  dead: number
  /** Whether the group is already waiting in the queue's list of groups that can be received from. */
  queued: boolean
  /** The group's send-rate bucket (a partition's limit), in API calls. */
  tokens: number
  tokensAt: number
}

/** The messages enqueued in one second, so retention can expire them without looking at the rest. */
export interface Bucket {
  readonly key: number
  items: Array<Entry>
  /** How many of them count towards the oldest-message age. */
  aged: number
  /** The earliest enqueue time of any message filed here (an upper bound once some have left: the age is approximate anyway). */
  minAt: number
  prev: Bucket | undefined
  next: Bucket | undefined
}
