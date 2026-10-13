import { Effect } from "effect"
import type { Link } from "../../../Edge.ts"
import { type Cancel, noCancel } from "../../../Flow.ts"
import type { Call, CallFailure, Message } from "../../../Message.ts"
import type { TimerHandle } from "../../../VirtualTime.ts"
import type { Listener } from "./listener.ts"

/**
 * One request inside a load balancer, from the moment a node takes it until it is answered or abandoned: the node's
 * processing time (a timer), then the target group (one call through the edge) raced against the idle timeout (a timer).
 * The ALB and the NLB share this life; they differ only in what they make of the answer, of the idle timeout and of a
 * client giving up, which each says in its subclass (`Alb.ts`, `Nlb.ts`).
 */

/** What one request needs of its load balancer, made once per node so that a request is one small object. */
export interface Node {
  readonly fast: {
    readonly now: () => number
    readonly after: <A>(ms: number, fire: (arg: A) => void, arg: A) => TimerHandle
  }
  readonly listener: Listener
  /** Requests in flight. */
  active: number
}

/** A request through a load balancer node. Plain and synchronous: one per request, on the hot path. */
export abstract class Forwarded<N extends Node> {
  open = true
  timer: TimerHandle | undefined = undefined
  private cancelDown: Cancel = noCancel
  /** When the request left for the target group. */
  protected sentAt = 0

  constructor(
    readonly node: N,
    private readonly message: Message,
    private readonly link: Link,
    private readonly zone: string | undefined,
    /** The idle timeout: how long it waits for the target group's answer. */
    protected readonly waitMs: number,
    protected readonly resume: (effect: Call) => void
  ) {}

  /** The target group's answer, unless the request is already over. */
  protected abstract readonly answered: (failure: CallFailure | undefined) => void
  /** Nothing from the target within the idle timeout. */
  protected abstract timedOut(): void
  /** The client gave up first and closed its connection. */
  protected abstract abandoned(): void

  /** Through the target group on the edge, with the idle timeout running. The listener tells the edge which node it is. */
  forward(): void {
    this.timer = this.node.fast.after(this.waitMs, onIdle, this)
    this.sentAt = this.node.fast.now()
    const listener = this.node.listener
    listener.zone = this.zone
    const cancel = this.link.send(this.message, this.answered)
    listener.zone = undefined
    if (this.open) this.cancelDown = cancel
  }

  /** The node's own processing is done: forward. */
  processed(): void {
    this.timer = undefined
    if (this.open) this.forward()
  }

  /** Nothing from the target within the idle timeout. The target is not told, and keeps working. */
  idle(): void {
    this.timer = undefined
    if (!this.open) return
    this.close()
    this.cancelDown()
    this.cancelDown = noCancel
    this.timedOut()
  }

  /** The client gave up first and closed its connection. */
  abandon(): void {
    if (!this.open) return
    this.close()
    this.cancelDown()
    this.cancelDown = noCancel
    this.abandoned()
  }

  protected close(): void {
    this.open = false
    this.timer?.cancel()
    this.timer = undefined
    this.node.active--
  }
}

const onIdle = (r: Forwarded<Node>): void => r.idle()
const onProcessed = (r: Forwarded<Node>): void => r.processed()

/**
 * Start `r` (made inside an `Effect.callback`): after the node's processing time `delay`, or at once. Answers what the
 * callback answers: abandoning the request when the caller gives up.
 */
export const start = <N extends Node>(r: Forwarded<N>, delay: number): Effect.Effect<void> => {
  if (delay > 0) r.timer = r.node.fast.after(delay, onProcessed, r)
  else r.forward()
  return Effect.sync(() => r.abandon())
}
