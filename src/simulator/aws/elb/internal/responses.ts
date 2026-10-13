import { REFUSED_UNIT_GONE } from "../../../fleet/Fleet.ts"
import { isNoTarget } from "../../../fleet/TargetGroup.ts"
import { type CallFailure, Failed, Rejected, Timeout, Unavailable } from "../../../Message.ts"

/**
 * What an Application Load Balancer answers when its target didn't give it a good response (Troubleshoot your Application
 * Load Balancers): the load balancer's own 5xx, or the target's response passed on.
 *
 *  - **503**: the target group had no target for the request (no registered target, or none in an empty zone with
 *    cross-zone off).
 *  - **502**: the target refused or reset the connection, closed it with the request outstanding (its zone went down, it
 *    was cut off at the end of its deregistration delay), or isn't there; for a Lambda target, any failure of the function
 *    (an error, its own timeout, a throttle).
 *  - **504**: the target sent nothing within the idle timeout (the component's timer).
 *  - **the target's own response** otherwise: its 500 (a `Failed`), its 503 (an `Unavailable` whose reason starts with a
 *    status, as a full backlog's does), its 429 and 4xx. ALB forwards valid responses from targets, errors included.
 */
export const Outcome = {
  /** The target's own error response, passed on: `HTTPCode_Target_5XX_Count` or `_4XX_`. */
  Target5xx: 0,
  Target4xx: 1,
  /** The load balancer's own errors: `HTTPCode_ELB_502_Count`, `_503_`, `_504_`. */
  Elb502: 2,
  Elb503: 3,
  Elb504: 4
} as const
export type Outcome = (typeof Outcome)[keyof typeof Outcome]

/** How a target's failure reads at the listener. `lambda`: the target is a Lambda function. */
export const outcomeOf = (failure: CallFailure, lambda: boolean): Outcome => {
  if (isNoTarget(failure)) return Outcome.Elb503
  if (lambda) return Outcome.Elb502
  switch (failure._tag) {
    case "Timeout":
      return Outcome.Elb504
    case "Throttled":
    case "Rejected":
      return Outcome.Target4xx
    case "Failed":
      return Outcome.Target5xx
    case "Unavailable":
      // A reason that starts with a status is an answer the target gave (a full backlog's 503); anything else is a
      // connection that failed: refused, reset, cut off.
      return startsWithStatus(failure.reason) ? Outcome.Target5xx : Outcome.Elb502
  }
}

const startsWithStatus = (reason: string): boolean => {
  const a = reason.charCodeAt(0)
  return a >= 49 && a <= 53 && isDigit(reason.charCodeAt(1)) && isDigit(reason.charCodeAt(2)) && !isDigit(reason.charCodeAt(3))
}
const isDigit = (c: number): boolean => c >= 48 && c <= 57

/** The load balancer's own failures, made once per node so a storm of them allocates nothing. */
export const albFailures = (node: string) => ({
  refused: Failed({ node, reason: "502 bad gateway: the target refused the connection" }),
  closed: Failed({ node, reason: "502 bad gateway: the target closed the connection" }),
  lambda: Failed({ node, reason: "502 bad gateway: the Lambda function failed" }),
  noTarget: Unavailable({ node, reason: "503 service unavailable: no registered target" }),
  noTargetGroup: Unavailable({ node, reason: "503 service unavailable: no target group" }),
  tooLarge: Rejected({ node, reason: "413 payload too large: Lambda targets take at most 1 MB" }),
  idle: (afterMs: number) => Timeout({ edge: node, after: afterMs }),
  rejected: Unavailable({ node, reason: "connection rejected: the load balancer is at capacity while it scales" }),
  nodeDown: Unavailable({ node, reason: "connection failed: the load balancer node in its zone is down" })
})
export type AlbFailures = ReturnType<typeof albFailures>

/** The 502 for a connection failure: refused (nothing there) or closed (it went away with the request on it). */
export const badGateway = (f: AlbFailures, failure: CallFailure): CallFailure =>
  failure._tag === "Unavailable" && (failure.reason === REFUSED_UNIT_GONE || failure.reason === "connection refused") ? f.refused : f.closed
