import type { CallFailure } from "../Message.ts"
import type { Unit, UnitState } from "../Protocol.ts"
import type { TimerHandle } from "../VirtualTime.ts"

/**
 * The pieces a fleet is made of: its units (`Member`), the calls they work on (`Ticket`), and the lines calls wait in
 * (`Line`). They are plain mutable objects owned by one `Fleet`; nothing else changes them. Kept apart from the fleet's
 * decisions (`Fleet.ts`) so each file reads on its own.
 */

/** One stage of a unit's start-up, with how long it takes: `launch`, `boot`, `pull image`, `start app`... */
export interface Phase {
  readonly name: string
  readonly ms: number
}

/**
 * A call's work on a fleet, as the component doing it sees it. The fleet calls `start` when a worker on a unit is the
 * call's (at once, or when its turn in a line comes); from then on the component does its work and tells the ticket
 * `release` (its worker is free) and `finish` (the call is over). If the call can't finish because its unit was lost
 * (its zone went down, it was cut off at the end of a drain, an injected zone error), the fleet calls `fail` instead,
 * once, and the ticket is already finished.
 */
export interface Job {
  readonly start: (ticket: Ticket) => void
  readonly fail: (failure: CallFailure) => void
}

/** Where a ticket is. */
export const WAITING_LINE = 0
export const WAITING_UNIT = 1
/** Holding a worker. */
export const RUNNING = 2
/** Its worker released, still on its unit (waiting on downstream calls). */
export const HELD = 3
export const DONE = 4

/**
 * One call's place in a fleet: in the fleet's line, in one unit's backlog, holding a worker, or still on the unit after
 * its worker is free. A unit keeps the tickets on it in an intrusive list, so losing a unit finds them all and a call
 * leaving costs nothing.
 */
export class Ticket {
  state = WAITING_LINE
  unit: Member | undefined = undefined
  prev: Ticket | undefined = undefined
  next: Ticket | undefined = undefined
  /** A slow zone's delay before the work starts. */
  delay: TimerHandle | undefined = undefined
  /** Whether an injected zone error fails it once the delay is over. */
  fails = false

  constructor(
    private readonly owner: TicketOwner,
    readonly job: Job
  ) {}

  /** The call's own work is done: its worker is free for the next call. It stays on its unit until `finish`. */
  release(): void {
    this.owner.releaseTicket(this)
  }

  /** The call is over (answered, failed or abandoned): gives back its worker or its place in line. Safe to call twice. */
  finish(): void {
    this.owner.finishTicket(this)
  }
}

/** What a ticket hands its `release` and `finish` to: its fleet. */
export interface TicketOwner {
  readonly releaseTicket: (t: Ticket) => void
  readonly finishTicket: (t: Ticket) => void
}

/**
 * Calls waiting, first come first served. A call that gives up while it waits is skipped when its turn comes (its state
 * is no longer a waiting one), so leaving is O(1).
 */
export class Line {
  private readonly items: Array<Ticket> = []
  private head = 0
  /** Calls waiting that haven't given up. */
  live = 0

  push(t: Ticket): void {
    this.items.push(t)
    this.live++
  }

  /** The next call still waiting, now taken out of the line. */
  shift(): Ticket | undefined {
    if (this.live === 0) {
      if (this.items.length > 0) this.clear()
      return undefined
    }
    while (this.head < this.items.length) {
      const t = this.items[this.head++]!
      if (t.state !== WAITING_LINE && t.state !== WAITING_UNIT) continue
      this.live--
      this.compact()
      return t
    }
    this.clear()
    return undefined
  }

  /** Everyone still waiting, emptying the line. */
  takeAll(): Array<Ticket> {
    const out: Array<Ticket> = []
    for (let t = this.shift(); t !== undefined; t = this.shift()) out.push(t)
    return out
  }

  private compact(): void {
    if (this.live === 0) this.clear()
    else if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items.splice(0, this.head)
      this.head = 0
    }
  }

  private clear(): void {
    this.items.length = 0
    this.head = 0
  }
}

/** One unit, as its fleet keeps it. What everyone else sees of it is `Unit`. */
export class Member implements Unit {
  state: UnitState = "requested"
  zone: string | undefined = undefined
  /** Up and reachable. False once it died (its zone went down, it crashed); its fleet notices after a while. */
  alive = true
  /** What its health endpoint says while it is up: a unit can answer and still be unwell. */
  healthy = true
  /** What a balancer last reported of its health. */
  reportedHealthy = true
  /** Its fleet found it dead while it was in its grace period: replaced when the grace ends. */
  detected = false
  /** Workers busy. */
  running = 0
  /** Calls addressed to it (by a balancer) waiting for one of its workers. Made on first use. */
  backlog: Line | undefined = undefined
  /** The calls on it: waiting in its backlog, holding a worker, or held while they call downstream. */
  first: Ticket | undefined = undefined
  last: Ticket | undefined = undefined
  attached = 0
  /** Its start-up phases, and which it is in. */
  phases: ReadonlyArray<Phase> = []
  phase = -1
  /** The timer of its current state: a start-up phase, the grace period, or the end of its drain. */
  timer: TimerHandle | undefined = undefined
  /** When its fleet will notice it died. */
  detection: TimerHandle | undefined = undefined
  /** Draining: when it is cut off, and whether nothing may extend that (an interruption's notice). */
  drainUntil = 0
  hardDrain = false
  /** It holds a unit of the account's capacity, to give back when it goes. */
  holdsCapacity = false
  /** It was placed on a host (`Options.hosts`), to give its room back when it goes. */
  onHost = false
  /** Things other than calls still on it (a host's tenants, `Fleet.hold`): a drain waits for them as it does for calls. */
  holds = 0
  /** Its place in the fleet's set of units with a free worker, or -1. */
  freeIndex = -1
  /** Balancers have been told it is up, so they must be told it is gone. */
  announced = false

  constructor(
    /** The fleet it belongs to: units are only ever handed back to their own fleet. */
    readonly owner: object,
    readonly id: number,
    readonly name: string,
    public since: number
  ) {}

  /** The start-up phase it is in, if it is starting. */
  get phaseName(): string | undefined {
    return this.state === "starting" ? this.phases[this.phase]?.name : undefined
  }

  /** It counts towards the desired number: not draining, not gone. */
  get live(): boolean {
    return this.state === "requested" || this.state === "starting" || this.state === "grace" || this.state === "inService"
  }

  /** Up and taking calls. */
  get serving(): boolean {
    return this.state === "grace" || this.state === "inService"
  }

  attach(t: Ticket): void {
    t.unit = this
    t.prev = this.last
    t.next = undefined
    if (this.last === undefined) this.first = t
    else this.last.next = t
    this.last = t
    this.attached++
  }

  detach(t: Ticket): void {
    if (t.prev === undefined) this.first = t.next
    else t.prev.next = t.next
    if (t.next === undefined) this.last = t.prev
    else t.next.prev = t.prev
    t.prev = t.next = undefined
    this.attached--
  }

  /** Every ticket on it, detached: what is lost when it is. */
  detachAll(): Array<Ticket> {
    const out: Array<Ticket> = []
    for (let t = this.first; t !== undefined; t = t.next) out.push(t)
    for (const t of out) t.prev = t.next = undefined
    this.first = this.last = undefined
    this.attached = 0
    this.backlog = undefined
    return out
  }
}
