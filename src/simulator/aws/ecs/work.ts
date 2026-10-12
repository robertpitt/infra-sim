import { Effect } from "effect"
import type * as Component from "../../Component.ts"
import * as Distribution from "../../Distribution.ts"
import type { Link } from "../../Edge.ts"
import type { Fleet, Job, Ticket } from "../../fleet/Fleet.ts"
import * as Flow from "../../Flow.ts"
import { type Call, type CallFailure, Failed, type Message, type Reply, Unavailable } from "../../Message.ts"
import type { Unit } from "../../Protocol.ts"
import type * as Setting from "../../Setting.ts"

/**
 * One request's work on a task or a pod: a worker of the unit it runs on is busy for the service time, then it calls
 * downstream while still on the unit (its worker free), and answers. A unit running a broken version answers 500 after
 * its work. Written as a small class with a module-level timer callback, as `common.service`'s is, so a request is one
 * object: this is the hot path of every ECS and EKS design.
 */

/** What a request needs of its service, made once per node. */
export interface WorkHost {
  readonly id: string
  readonly fast: Pick<Component.Fast<unknown>, "after" | "random">
  readonly out: ReadonlyArray<Link>
  /** The service time now. */
  readonly serviceTime: () => Setting.Latency
  readonly fanOut: () => Flow.FanOut
  /** Whether the unit runs a version that answers every request with 500 (it fails its health checks). */
  readonly broken: (unit: Unit) => boolean
  readonly totals: { served: number; errors: number; refused: number; lost: number }
}

class Request implements Job {
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

  worked(): void {
    this.timer = undefined
    if (this.finished) return
    const ticket = this.ticket!
    // Its own part is done: the worker is free for the next request while this one calls downstream.
    ticket.release()
    if (ticket.unit !== undefined && this.host.broken(ticket.unit)) {
      this.finished = true
      ticket.finish()
      this.host.totals.errors++
      return this.resume(Effect.fail(Failed({ node: this.host.id, reason: "500 internal server error" })))
    }
    this.downstream = Flow.fanOut(this.host.fanOut(), this.host.out, this.host.fast.random, this.message, this.answered)
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

  /** Its unit was lost with it (or its zone failed it). The ticket is already finished. */
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

/** The handler for calls into a fleet of tasks or pods: plain calls (`unit` undefined) and calls a target group addressed to a unit. */
export const handler = (fleet: Fleet, host: WorkHost) => (message: Message, unit: Unit | undefined): Call =>
  Effect.callback<Reply, CallFailure>((resume) => {
    const request = new Request(host, message, resume)
    const admitted = fleet.admit(request, unit)
    if (typeof admitted === "string") {
      host.totals.refused++
      resume(Effect.fail(Unavailable({ node: host.id, reason: admitted })))
      return Effect.void
    }
    request.ticket = admitted
    return Effect.sync(() => request.abandon())
  })
