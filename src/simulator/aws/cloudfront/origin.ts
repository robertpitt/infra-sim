import { Duration } from "effect"
import type { Fast } from "../../Component.ts"
import type { Config as EdgeConfig, Link } from "../../Edge.ts"
import type { CallFailure, Message } from "../../Message.ts"
import type { TimerHandle } from "../../VirtualTime.ts"
import type { Origin } from "./config.ts"
import { CONNECT_FAILED, OK, type Outcome, outcomeOfFailure } from "./outcome.ts"

/** An edge leaving the distribution's `out` port: one origin. */
export type OriginLink = Link<EdgeConfig & Origin>

/**
 * What CloudFront applies when an S3 bucket (not a website endpoint) is the origin. AWS lists the response timeout
 * as a custom-origin setting, so the default is used and a slow response is not retried.
 */
export const S3_RESPONSE_TIMEOUT_MS = 30_000

export interface Counter {
  n: number
}

/**
 * One request to one origin, as CloudFront makes it: up to `connectionAttempts` tries when the connection is refused
 * (and, for a GET to a custom origin, when the origin does not answer within the response timeout), a limit on the
 * whole exchange when a completion timeout is set, and an `Outcome` for whatever came back. The callee is never
 * cancelled: like CloudFront, it drops the connection and the origin carries on.
 */
export class OriginCall {
  private attempt = 0
  private readonly attempts: number
  private readonly readTimeoutMs: number
  private readonly retryOnTimeout: boolean
  private timer: TimerHandle | undefined
  private deadline: TimerHandle | undefined
  private finished = false

  constructor(
    private readonly fast: Pick<Fast<unknown>, "after">,
    private readonly link: OriginLink,
    private readonly config: EdgeConfig & Origin,
    private readonly message: Message,
    private readonly read: boolean,
    private readonly retries: Counter,
    private readonly done: (outcome: Outcome) => void
  ) {
    const s3 = config.originType === "s3"
    this.attempts = config.connectionAttempts
    this.readTimeoutMs = s3 ? S3_RESPONSE_TIMEOUT_MS : Duration.toMillis(config.responseTimeout)
    this.retryOnTimeout = read && !s3
  }

  start(): void {
    const completion = Duration.toMillis(this.config.responseCompletionTimeout)
    // The completion timeout may not be shorter than the response timeout (AWS requires at least as much).
    if (completion > 0) this.deadline = this.fast.after(Math.max(completion, this.readTimeoutMs), onDeadline, this)
    this.try()
  }

  private try(): void {
    const n = ++this.attempt
    this.timer = this.fast.after(this.readTimeoutMs, onTimeout, this)
    this.link.send(this.message, (failure) => this.result(n, failure))
  }

  private result(n: number, failure: CallFailure | undefined): void {
    if (this.finished || n !== this.attempt) return
    this.timer?.cancel()
    this.timer = undefined
    if (failure === undefined) return this.finish(OK)
    const outcome = outcomeOfFailure(failure)
    if (outcome === CONNECT_FAILED && this.attempt < this.attempts) {
      this.retries.n++
      return this.try()
    }
    this.finish(outcome)
  }

  timedOut(): void {
    this.timer = undefined
    if (this.finished) return
    if (this.retryOnTimeout && this.attempt < this.attempts) {
      this.retries.n++
      return this.try()
    }
    this.finish(504)
  }

  expired(): void {
    this.deadline = undefined
    if (!this.finished) this.finish(504)
  }

  private finish(outcome: Outcome): void {
    this.finished = true
    this.timer?.cancel()
    this.deadline?.cancel()
    this.timer = this.deadline = undefined
    this.done(outcome)
  }
}

const onTimeout = (call: OriginCall): void => call.timedOut()
const onDeadline = (call: OriginCall): void => call.expired()
