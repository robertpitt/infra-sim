import { Effect } from "effect"
import type * as Component from "../../Component.ts"
import * as Distribution from "../../Distribution.ts"
import type { Link } from "../../Edge.ts"
import type { Job, Ticket } from "../../fleet/Fleet.ts"
import * as Flow from "../../Flow.ts"
import { type Call, type CallFailure, Failed, type Message } from "../../Message.ts"
import type { TimerHandle } from "../../VirtualTime.ts"
import type { Settings } from "./config.ts"

/** What a request needs of its group, made once per node so that a request is one small object. */
export interface RequestHost {
  readonly id: string
  readonly fast: Component.Fast<Settings>
  readonly out: ReadonlyArray<Link>
  /** Instances whose application is broken: they answer 500. */
  readonly broken: ReadonlySet<number>
  readonly totals: { served: number; errors: number; refused: number; lost: number }
}

/**
 * One request on an instance, as a state machine with one closure (for downstream answers): a worker (a vCPU) starts
 * it, the service time passes (`worked`), it calls downstream with the worker released, and is answered; or its instance
 * is lost (`fail`), or its caller gives up (`abandon`). The shape of `common.service`'s request.
 */
export class Request implements Job {
  ticket: Ticket | undefined = undefined
  finished = false
  private timer: TimerHandle | undefined = undefined
  private downstream: Flow.Cancel | undefined = undefined

  constructor(
    private readonly host: RequestHost,
    private readonly message: Message,
    private readonly resume: (effect: Call) => void
  ) {}

  start(ticket: Ticket): void {
    this.ticket = ticket
    const { fast } = this.host
    this.timer = fast.after(Distribution.latencyMs(fast.settings().serviceTime, fast.random), worked, this)
  }

  worked(): void {
    this.timer = undefined
    if (this.finished) return
    const { fast, totals, id, broken } = this.host
    const c = fast.settings()
    const ticket = this.ticket!
    const onBroken = broken.size > 0 && ticket.unit !== undefined && broken.has(ticket.unit.id)
    ticket.release()
    if (onBroken || (c.errorRate > 0 && fast.random.nextDoubleUnsafe() < c.errorRate)) {
      this.finished = true
      ticket.finish()
      totals.errors++
      return this.resume(Effect.fail(Failed({ node: id, reason: onBroken ? "500 the instance's application is broken" : "500 internal server error" })))
    }
    this.downstream = Flow.fanOut(c.fanOut, this.host.out, fast.random, this.message, this.answered)
  }

  private readonly answered = (failure: CallFailure | undefined): void => {
    this.finished = true
    this.ticket!.finish()
    if (failure !== undefined) {
      this.host.totals.errors++
      return this.resume(Effect.fail(Failed({ node: this.host.id, reason: `downstream: ${failure._tag}` })))
    }
    this.host.totals.served++
    this.resume(Effect.void)
  }

  /** Its instance was lost with it (terminated, its zone failed). The ticket is already finished. */
  fail(failure: CallFailure): void {
    if (this.finished) return
    this.finished = true
    this.stop()
    if (failure._tag === "Failed") this.host.totals.errors++
    else this.host.totals.lost++
    this.resume(Effect.fail(failure))
  }

  /** The caller gave up: give back the worker or the place in line, and stop the work. */
  abandon(): void {
    if (this.finished) return
    this.finished = true
    this.ticket?.finish()
    this.stop()
  }

  private stop(): void {
    this.timer?.cancel()
    this.timer = undefined
    this.downstream?.()
  }
}

const worked = (request: Request): void => request.worked()

