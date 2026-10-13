import type { Bucket, Limiter } from "../../../Limiter.ts"
import type { TimerHandle } from "../../../VirtualTime.ts"
import type { Account } from "../../internal/account.ts"

type After = <A>(ms: number, fire: (arg: A) => void, arg: A) => TimerHandle

/** A state transition waiting for a token. `go` enters the state; cancelling leaves the line. */
export class Waiter {
  /** Set once the waiter has been let through or has left the line. */
  done = false
  constructor(
    private readonly gate: TransitionGate,
    readonly go: () => void
  ) {}

  cancel(): void {
    if (this.done) return
    this.done = true
    this.gate.left()
  }
}

/**
 * The account's StateTransition token bucket in one Region, with a line in front of it.
 *
 * Step Functions doesn't fail a Standard execution whose transition is throttled: it slows it down (CloudWatch counts
 * `ExecutionThrottled`). So a transition that finds the bucket empty waits its turn, in the order it arrived, and is let
 * through as tokens refill. A transition that arrives while others are waiting joins the line even if a token has just
 * come back, so nobody overtakes. One timer serves the whole line: it fires when the next token is due.
 */
export class TransitionGate {
  private readonly line: Array<Waiter | undefined> = []
  private head = 0
  private timer: TimerHandle | undefined
  /** Transitions waiting right now, across every state machine in the Region. */
  waiting = 0
  private bucketFor: Account | undefined
  private bucket: Bucket = { rate: 1, burst: 1 }

  constructor(
    private readonly limiter: Limiter,
    private readonly key: string,
    private readonly account: () => Account,
    private readonly after: After
  ) {}

  /** The bucket as the account quotas say right now, rebuilt only when they change. */
  private current(): Bucket {
    const a = this.account()
    if (a !== this.bucketFor) {
      this.bucketFor = a
      this.bucket = { rate: a.sfnStateTransitionRate, burst: a.sfnStateTransitionBurst }
    }
    return this.bucket
  }

  /** Take a token now if one is free and nobody is waiting. No allocation: the common case. */
  tryNow(): boolean {
    return this.waiting === 0 && this.limiter.takeUnsafe(this.key, this.current())
  }

  /** Join the line; `go` runs when a token is this transition's. */
  enqueue(go: () => void): Waiter {
    const waiter = new Waiter(this, go)
    this.line.push(waiter)
    this.waiting++
    if (this.timer === undefined) this.arm()
    return waiter
  }

  /** A waiter gave up its place (its execution ended). */
  left(): void {
    this.waiting--
  }

  /**
   * Arm the timer for when the bucket next holds a whole token, rounded up to a whole millisecond: a wait of a sliver of
   * a millisecond is lost when added to a large virtual time, and the line would wake at the same instant forever.
   * Tokens keep accruing in the bucket meanwhile, so the rounding costs no throughput.
   */
  private arm(): void {
    const bucket = this.current()
    const level = this.limiter.levelUnsafe(this.key, bucket)
    const ms = level >= 1 ? 0 : Math.ceil(((1 - level) / bucket.rate) * 1000)
    this.timer = this.after(ms, drain, this)
  }

  /** Let through as many as there are tokens for, first come first served. */
  release(): void {
    this.timer = undefined
    const bucket = this.current()
    while (this.head < this.line.length) {
      const waiter = this.line[this.head]!
      if (waiter.done) {
        this.line[this.head++] = undefined
        continue
      }
      if (!this.limiter.takeUnsafe(this.key, bucket)) break
      this.line[this.head++] = undefined
      waiter.done = true
      this.waiting--
      waiter.go()
    }
    // Drop the part of the line already served, now and then, so it doesn't grow without bound.
    if (this.head === this.line.length) {
      this.line.length = 0
      this.head = 0
    } else if (this.head > 1_024 && this.head * 2 > this.line.length) {
      this.line.splice(0, this.head)
      this.head = 0
    }
    if (this.waiting > 0 && this.timer === undefined) this.arm()
  }
}

const drain = (gate: TransitionGate): void => gate.release()

/**
 * What every state machine in one placement shares (built once per placement through `node.shared`): the open Standard
 * executions, counted against the account's quota, and the state transition line.
 */
export interface Region {
  /** Standard executions open in this account and Region, every state machine's together. */
  openStandard: number
  readonly transitions: TransitionGate
}

export const makeRegion = (limiter: Limiter, placement: string, account: () => Account, after: After): Region => ({
  openStandard: 0,
  transitions: new TransitionGate(limiter, `${placement}/sfn.transitions`, account, after)
})
