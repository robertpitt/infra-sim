import type { Fast } from "../../../Component.ts"
import type { Pull, PullTraits } from "../../../Protocol.ts"
import type { TimerHandle } from "../../../VirtualTime.ts"
import type { Account } from "../../internal/account.ts"
import { API_BATCH, type QueueConfig } from "./config.ts"
import type { Deliveries, Delivery } from "./delivery.ts"
import type { Tallies } from "./metrics.ts"
import type { QueueStore } from "./store.ts"
import { type FifoRate, fifoRate } from "./throughput.ts"

export interface PullEnv {
  readonly store: QueueStore
  readonly fast: Fast<QueueConfig>
  readonly deliveries: Deliveries
  /** FIFO: the queue's limit on ReceiveMessage calls. */
  readonly receiveRate: FifoRate
  readonly tallies: Tallies
}

/**
 * The queue as its consumers see it: ReceiveMessage. Whatever consumes it (Lambda's event source mapping, a fleet of
 * workers) takes through this, and everything only the queue can know stays here: at most ten messages a receive, the
 * in-flight limit, FIFO's receive rate and message groups, and the visibility timeout each receive starts (see
 * `Deliveries`).
 */
export class QueuePull implements Pull {
  readonly traits: PullTraits
  private readonly listeners: Array<() => void> = []
  private rateTimer: TimerHandle | undefined

  constructor(private readonly env: PullEnv) {
    this.traits = { ordered: env.store.fifo, maxTake: API_BATCH }
  }

  take(max: number, bytes: number): Delivery | undefined {
    const { store, fast, deliveries } = this.env
    // At the in-flight limit a receive returns nothing.
    const room = Math.min(API_BATCH, max, fast.settings().inFlightLimit - store.counts.hidden)
    if (room <= 0) return undefined
    if (store.fifo && !this.takeReceiveToken()) return undefined
    return deliveries.receive(room, bytes)
  }

  available(): boolean {
    return this.env.store.hasWork() && this.env.store.counts.hidden < this.env.fast.settings().inFlightLimit
  }

  /** Messages waiting that a receive could return: none while every FIFO group is blocked. */
  backlog(): number {
    return this.env.store.hasWork() ? this.env.store.counts.ready : 0
  }

  ready(listener: () => void): () => void {
    this.listeners.push(listener)
    return () => {
      const i = this.listeners.indexOf(listener)
      if (i >= 0) this.listeners.splice(i, 1)
    }
  }

  /** NumberOfEmptyReceives. */
  idle(receives: number): void {
    this.env.tallies.emptyReceives.add(receives)
  }

  /** Something became receivable, or a group was released: let the consumers look. */
  readonly wake = (): void => {
    // A snapshot: a listener may take, and a take may end in a callback that wakes again.
    for (const listener of this.listeners.slice()) listener()
  }

  /** FIFO receives are limited to 300 a second (or the regional quota in high-throughput mode), like sends. */
  private takeReceiveToken(): boolean {
    const { fast, receiveRate } = this.env
    const rate = fifoRate(fast.settings(), fast.account() as Account)
    if (receiveRate.take(rate, 1)) return true
    // Tell the consumers when a token has refilled.
    this.rateTimer ??= fast.after(Math.max(1, Math.ceil(1000 / rate)), this.onRate, undefined)
    return false
  }

  private readonly onRate = (): void => {
    this.rateTimer = undefined
    this.wake()
  }
}
