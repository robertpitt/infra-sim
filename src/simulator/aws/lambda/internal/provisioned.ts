import type { TimerHandle } from "../../../VirtualTime.ts"
import { PROVISIONED_PER_MINUTE } from "./limits.ts"

/** The part of the engine's `node.fast` that provisioned concurrency needs: timers. */
type Timers = { readonly after: <A>(ms: number, fire: (arg: A) => void, arg: A) => TimerHandle }

/**
 * A function's provisioned concurrency: environments kept initialised, so a request that finds one never cold starts.
 *
 * Provisioned concurrency doesn't come online at once. After a change Lambda needs "a minute or two of preparation"
 * and then allocates up to 6,000 environments a minute, and none can be used until all are ready
 * (`lambda-concurrency.html`, "How Lambda allocates provisioned concurrency"). A design starts with what it asks for
 * already allocated, as a deployed function would; the delay is felt when it is raised while running. Lowering it
 * takes effect at once for idle environments, and busy ones retire when they finish.
 */
export class Provisioned {
  /** Environments ready: initialised and counted against the account. */
  allocated: number
  /** Of those, running a request right now. */
  busy = 0
  private target: number
  private timer: TimerHandle | undefined

  constructor(initial: number) {
    this.allocated = initial
    this.target = initial
  }

  /** Ready and idle: what a request can take without a cold start. Never negative. */
  get free(): number {
    return this.allocated > this.busy ? this.allocated - this.busy : 0
  }

  /** Claim an idle environment for a request. */
  take(): boolean {
    if (this.allocated <= this.busy) return false
    this.busy++
    return true
  }

  /** A request finished and its environment goes back (or retires, if the allocation was lowered meanwhile). */
  give(): void {
    this.busy--
  }

  /**
   * The function now wants `target` provisioned environments. Raising it starts an allocation, replacing any still
   * under way; lowering it applies immediately.
   */
  retarget(target: number, timers: Timers, warmupMs: number): void {
    if (target === this.target) return
    this.target = target
    this.timer?.cancel()
    this.timer = undefined
    if (target <= this.allocated) {
      this.allocated = target
      return
    }
    const delay = warmupMs + ((target - this.allocated) / PROVISIONED_PER_MINUTE) * 60_000
    this.timer = timers.after(delay, this.ready, undefined)
  }

  private readonly ready = (): void => {
    this.timer = undefined
    this.allocated = this.target
  }
}
