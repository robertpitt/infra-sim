/**
 * The request state machine behind `Work.handler`, for `common.service` and the AWS compute services built like it
 * (EC2 Auto Scaling groups, ECS services, EKS workloads). It is the hot path of every one of those designs, so it is a
 * small class with a module-level timer callback: a request is one object, with no closures of its own beyond the one
 * downstream calls answer.
 */
import { Effect } from "effect"
import * as Distribution from "../../Distribution.ts"
import type { Job, Ticket } from "../../fleet/Fleet.ts"
import * as Flow from "../../Flow.ts"
import { type Call, type CallFailure, Failed, type Message } from "../../Message.ts"
import type { WorkHost } from "../Work.ts"

const INTERNAL_ERROR = "500 internal server error"

/**
 * One request's work, as a state machine: a worker starts it (`start`), the service time passes (`worked`), it calls
 * downstream with the worker released and is answered (`answered`); or its unit is lost (`fail`), or its caller gives
 * up (`abandon`).
 */
export class Request implements Job {
  ticket: Ticket | undefined = undefined
  finished = false
  private timer: { readonly cancel: () => void } | undefined = undefined
  private downstream: Flow.Cancel | undefined = undefined

  constructor(
    private readonly host: WorkHost,
    private readonly message: Message,
    private readonly resume: (effect: Call) => void
  ) {}

  start(ticket: Ticket): void {
    this.ticket = ticket
    const { fast } = this.host
    this.timer = fast.after(Distribution.latencyMs(this.host.serviceTime(), fast.random), worked, this)
  }

  /** The service time is over. */
  worked(): void {
    this.timer = undefined
    if (this.finished) return
    const host = this.host
    const ticket = this.ticket!
    const onBroken = host.broken !== undefined && ticket.unit !== undefined && host.broken(ticket.unit)
    // The worker's own part is done: it is free for the next request while this one calls downstream. Releasing it may
    // start the next request, which draws its service time before this one draws its error.
    ticket.release()
    const errorRate = host.errorRate === undefined ? 0 : host.errorRate()
    if (onBroken || (errorRate > 0 && host.fast.random.nextDoubleUnsafe() < errorRate)) {
      this.finished = true
      ticket.finish()
      host.totals.errors++
      return this.resume(Effect.fail(Failed({ node: host.id, reason: onBroken ? host.brokenReason ?? INTERNAL_ERROR : INTERNAL_ERROR })))
    }
    this.downstream = Flow.fanOut(host.fanOut(), host.out, host.fast.random, this.message, this.answered)
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

  /** Its unit was lost with it (terminated, its zone failed, or its zone failed it: an injected error). The ticket is already finished. */
  fail(failure: CallFailure): void {
    if (this.finished) return
    this.finished = true
    this.stop()
    if (failure._tag === "Failed") this.host.totals.errors++
    else this.host.totals.lost++
    this.resume(Effect.fail(failure))
  }

  /** The caller gave up: give back the worker or the place in line, and stop the work (the callee doesn't keep going). */
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
