import type { Message } from "./Message.ts"

/**
 * How two things exchange work across a port.
 *
 *  - `invoke`: the sender pushes a message and hears the outcome once (`Link.send`). A call, a publish, a put.
 *  - `pull`: the owner of the work holds it and a taker takes it (`Pull.take`). A queue and its consumers.
 *
 * A port speaks one protocol, and a connector bridges one protocol to another. That is what decides which connections
 * make sense: a queue's consumers port is `pull`, so whatever is wired to it needs a connector that pulls, and the
 * registry picks one (see `Connector.ts`).
 */
export type Protocol = "invoke" | "pull"

export const protocols: ReadonlyArray<Protocol> = ["invoke", "pull"]

// ---------------------------------------------------------------------------------------------------------
// pull
// ---------------------------------------------------------------------------------------------------------

/** One record a lease handed out. */
export interface LeasedRecord {
  /** The message as its sender made it. Records of one batch send share it. */
  readonly message: Message
  /** This record's own size. */
  readonly bytes: number
  /** How many times it has been handed out, this time included. */
  readonly receives: number
}

/**
 * Records taken from a pull source, held until they are acknowledged or the lease runs out.
 *
 * The owner decides how long a lease lasts (a queue's visibility timeout) and what happens when it lapses (the records
 * come back, or move to a dead-letter queue). A record whose lease lapsed may be handed out again under a new lease;
 * from then on the old lease no longer owns it, so `each` skips it and `ack` leaves it alone. That is the whole
 * at-least-once story, and it lives entirely in the owner.
 */
export interface Lease {
  /** Records taken, when the lease was granted. */
  readonly count: number
  /** Their total size, when the lease was granted. */
  readonly bytes: number
  /** Visit each record this lease still owns. */
  readonly each: (visit: (record: LeasedRecord) => void) => void
  /**
   * Acknowledge (delete) what this lease still owns, except the records in `keep`: those stay taken and come back when
   * the lease runs out, as the records a consumer reported failed do.
   */
  readonly ack: (keep?: ReadonlySet<LeasedRecord>) => void
}

/** What a taker may rely on about a source. */
export interface PullTraits {
  /** Records come out in an order that matters (a FIFO queue's message groups). */
  readonly ordered: boolean
  /** The most one `take` returns, if the source has a limit (ten for an SQS ReceiveMessage). */
  readonly maxTake?: number
}

/**
 * Work offered to be taken: what a node with a `pull` port hands the connectors wired to it.
 *
 * Everything is synchronous and allocation-light, because a busy queue is taken from thousands of times a second.
 */
export interface Pull {
  /** Take up to `max` records, stopping once their size reaches `bytes`. Nothing receivable right now: `undefined`. */
  readonly take: (max: number, bytes: number) => Lease | undefined
  /** Whether a `take` may succeed now. Optimistic: `take` is the authority. */
  readonly available: () => boolean
  /** Records waiting to be taken, for a taker deciding how many workers it needs. */
  readonly backlog: () => number
  /** Hear when a `take` may succeed again (something arrived, a lease ended, a rate limit refilled). Returns a function that stops listening. */
  readonly ready: (listener: () => void) => () => void
  /** Takers waited on an empty source this many times (long polls that ended with nothing), for the owner's metrics. */
  readonly idle: (receives: number) => void
  readonly traits: PullTraits
}

/**
 * What several leases still own, as one call: the first record's message, carrying the batch's record count, its size
 * (capped at `maxBytes`) and the highest receive count among them. `undefined` if every record was taken back while the
 * taker waited.
 *
 * Pass `order` to have the records put in it in batch order, so that a reply naming records by position
 * (`ItemFailures`) can be matched back to them. Without it nothing is allocated per record.
 */
export const batchOf = (leases: ReadonlyArray<Lease>, maxBytes = Infinity, order?: Array<LeasedRecord>): Message | undefined => {
  let first: Message | undefined
  let count = 0
  let bytes = 0
  let attempt = 0
  const visit = (r: LeasedRecord): void => {
    first ??= r.message
    count++
    bytes += r.bytes
    if (r.receives > attempt) attempt = r.receives
    order?.push(r)
  }
  for (const lease of leases) lease.each(visit)
  if (first === undefined) return undefined
  return { ...(first as Message), count, bytes: Math.min(maxBytes, bytes), attempt, invocation: "sync", batched: true }
}
