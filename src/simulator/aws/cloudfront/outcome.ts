import { type CallFailure, Failed, Rejected, Throttled, Timeout, Unavailable } from "../../Message.ts"

/**
 * What an origin fetch came to, as one number: 0 for the object, an HTTP status for an error, and `CONNECT_FAILED`
 * when CloudFront could not connect at all. Numbers keep the miss path free of allocation.
 */
export type Outcome = number
export const OK: Outcome = 0
/** The origin refused or dropped every connection. The viewer sees 502; origin groups treat it as a 503. */
export const CONNECT_FAILED: Outcome = -502
/** No origin is wired (or none takes the request), so CloudFront cannot reach one: a 502. */
export const NO_ORIGIN: Outcome = 502

/** The HTTP status an outcome shows the viewer. */
export const statusOf = (outcome: Outcome): number => (outcome === CONNECT_FAILED ? 502 : outcome)

/**
 * The status of a failure an origin returned. Components say it in their reason ("503 Slow Down", "429 too many
 * requests"); when they don't, the kind decides. An unavailable origin that gives no status is a refused connection.
 */
export const outcomeOfFailure = (failure: CallFailure): Outcome => {
  const reason = failure._tag === "Timeout" ? "" : failure.reason
  const c0 = reason.charCodeAt(0)
  const c1 = reason.charCodeAt(1)
  const c2 = reason.charCodeAt(2)
  if (c0 >= 49 && c0 <= 53 && c1 >= 48 && c1 <= 57 && c2 >= 48 && c2 <= 57 && !(reason.charCodeAt(3) >= 48 && reason.charCodeAt(3) <= 57)) {
    return (c0 - 48) * 100 + (c1 - 48) * 10 + (c2 - 48)
  }
  switch (failure._tag) {
    case "Rejected":
      return 404
    case "Failed":
      return 500
    case "Throttled":
      return 503
    case "Unavailable":
      return CONNECT_FAILED
    case "Timeout":
      return 504
  }
}

/** What CloudFront caches: AWS's list of statuses cached for the error caching minimum TTL. 400, 403 and 405 only with a Cache-Control header, which is not modelled. */
export const isCachedError = (status: number): boolean => status === 404 || status === 414 || (status >= 500 && status <= 504)

/** An error CloudFront will serve a stale object over: 5xx and origin timeouts. 4xx replace the object. */
export const isServerError = (outcome: Outcome): boolean => outcome === CONNECT_FAILED || outcome >= 500

/** The failure a viewer gets for a status. */
export const failureFor = (node: string, outcome: Outcome, waited = 0): CallFailure => {
  const status = statusOf(outcome)
  switch (status) {
    case 429:
      return Throttled({ node, reason: "429 Too Many Requests" })
    case 503:
      return Unavailable({ node, reason: "503 Service Unavailable" })
    case 504:
      return Timeout({ edge: node, after: waited })
    case 502:
      return Failed({ node, reason: "502 Bad Gateway" })
  }
  return status >= 500 ? Failed({ node, reason: `${status} from the origin` }) : Rejected({ node, reason: `${status} from the origin` })
}
