import type { Call, Message } from "./Message.ts"

/**
 * How two things exchange work across a port.
 *
 *  - `invoke`: the sender pushes a message and hears the outcome once (`Link.send`). A call, a publish, a put.
 *  - `pull`: the owner of the work holds it and a taker takes it (`Pull.take`). A queue and its consumers.
 *  - `fleet`: the receiver is a fleet of units (instances, tasks, pods) and offers them one by one (`Fleet`); what sits on
 *    the edge picks a unit for each call, the way a load balancer's target group does. A fleet accepts plain `invoke`
 *    calls too, and then balances them itself, ideally.
 *
 * A port speaks one protocol, and a connector bridges one protocol to another. That is what decides which connections
 * make sense: a queue's consumers port is `pull`, so whatever is wired to it needs a connector that pulls, and the
 * registry picks one (see `Connector.ts`). `pull` is offered by the source of an edge; `fleet` by its target.
 */
export type Protocol = "invoke" | "pull" | "fleet"

export const protocols: ReadonlyArray<Protocol> = ["invoke", "pull", "fleet"]

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
  /** Records with the first record's key: a hot key's share of the batch, which keeps landing on one partition. */
  let same = 0
  const visit = (r: LeasedRecord): void => {
    first ??= r.message
    count++
    bytes += r.bytes
    if (r.message.key === first.key) same++
    if (r.receives > attempt) attempt = r.receives
    order?.push(r)
  }
  for (const lease of leases) lease.each(visit)
  if (first === undefined) return undefined
  return { ...(first as Message), count, bytes: Math.min(maxBytes, bytes), attempt, invocation: "sync", batched: true, spread: (count - same) / count }
}

// ---------------------------------------------------------------------------------------------------------
// fleet
// ---------------------------------------------------------------------------------------------------------

/**
 * Where a unit is in its life. `requested` waits for capacity (an account quota, a zone to place it in); `starting` runs
 * through the phases its service gives it (launch, boot or image pull, application start); `grace` is up and serving
 * while its fleet ignores bad health reports (a health-check grace period); `inService` is up and serving; `draining`
 * finishes what it holds and takes nothing new; `terminated` is gone.
 */
export type UnitState = "requested" | "starting" | "grace" | "inService" | "draining" | "terminated"

/** One unit of a fleet (an instance, a task, a pod), as a balancer sees it. Only its fleet changes it. */
export interface Unit {
  /** Unique within its fleet, in launch order, from 1. */
  readonly id: number
  /** `i-3`, `task-3`, `pod-3`: what its service calls it. */
  readonly name: string
  /** The zone it runs in. `undefined` for a fleet that isn't spread over zones. */
  readonly zone: string | undefined
  readonly state: UnitState
  /** Virtual time it entered its state. */
  readonly since: number
}

/**
 * What a balancer hears about a unit: it came `up` (registered: started, ready to be sent work), began `draining` (send it
 * nothing new), or is `gone` (terminated). A unit dying is *not* announced: a balancer finds out the way a real one does,
 * by health checks or by failed calls.
 */
export type UnitChange = "up" | "draining" | "gone"

/** How a unit answers a health check right now. */
export type HealthAnswer =
  /** Nothing answers: the unit, its zone or its node is down. The check fails at once (connection refused). */
  | { readonly up: false }
  /** It answers after `ms` (a slow zone), healthy or not. */
  | { readonly up: true; readonly healthy: boolean; readonly ms: number }

/**
 * A fleet's units, offered one by one: what a node whose component is a fleet offers the connector on each edge into it
 * that speaks `fleet` (a target group). The connector picks a unit per call and sends the call through the edge's
 * transport addressed to it (`Wire.call(message, policy, done, unit)`); the fleet's node then runs it with `serve`.
 *
 * Everything is synchronous and cheap: a balancer reads it on every call.
 */
export interface Fleet {
  /** Visit the units that are up or draining, in launch order. */
  readonly each: (visit: (unit: Unit) => void) => void
  /** Hear about units coming up, draining and going. Returns a function that stops listening. */
  readonly watch: (listener: (unit: Unit, change: UnitChange) => void) => () => void
  /** How the unit would answer a health check now. The checker adds the network (see `Wire.ping`). */
  readonly check: (unit: Unit) => HealthAnswer
  /** Run one call on this unit: the balancer's choice. A unit that is gone or down refuses it (`Unavailable`). */
  readonly serve: (unit: Unit, message: Message) => Call
  /**
   * A balancer's health checks found the unit unhealthy (or healthy again). A fleet that replaces units on such reports
   * (an Auto Scaling group with ELB health checks, an ECS service) does so, unless the unit is in its grace period.
   */
  readonly report: (unit: Unit, healthy: boolean) => void
  /** Keep a draining unit for at least `ms` more, unless it finishes everything first: a deregistration delay. */
  readonly holdDraining: (unit: Unit, ms: number) => void
}
