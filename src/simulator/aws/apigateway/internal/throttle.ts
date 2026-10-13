import type { Limiter } from "../../../Limiter.ts"
import { bucketOf, SALT_CLIENT, SALT_ROUTE } from "./hash.ts"
import type { Plan } from "./plan.ts"

/** What stopped a request, or `Admitted`. The order is the order the checks run in. */
export const Admit = {
  Admitted: 0,
  /** The client's own usage-plan rate. */
  Client: 1,
  /** The client has used its quota for the period. */
  Quota: 2,
  /** The stage's limit for the route the request is for. */
  Stage: 3,
  /** The account's regional limit. */
  Account: 4
} as const
export type Admission = (typeof Admit)[keyof typeof Admit]

/** What the throttle needs from the node: no more than this, so it can be tested on its own. */
export interface ThrottleHost {
  readonly id: string
  readonly limiter: Limiter
  readonly now: () => number
  /** Key of the account's bucket, shared by every gateway in the placement. */
  readonly accountKey: string
}

export interface Throttle {
  /** Run a request with this `key` through the layers, most specific first. Takes tokens as it goes. */
  readonly admit: (plan: Plan, key: number) => Admission
  /** Tokens left in the lowest route bucket the stage has touched (0 when the stage has no limit). */
  readonly stageLevel: (plan: Plan) => number
  readonly accountLevel: (plan: Plan) => number
}

/**
 * AWS applies its throttles in a fixed order: the usage plan (per client and method), then the stage's method settings,
 * then the account, then AWS's own regional limit. Each is a token bucket, and a request stopped by one does not spend
 * from the ones after it. A request that passes an earlier layer and fails a later one has spent that earlier token
 * (AWS does not publish whether it does; this is simpler and errs on the side of throttling).
 *
 * Per-route and per-client buckets are made on first use and never more than the settings allow (300 routes, 10,000
 * API keys), so memory is bounded however long the run.
 *
 * Quota windows are aligned to the start of the simulation: AWS aligns them to the calendar (assumed).
 */
export const makeThrottle = (host: ThrottleHost): Throttle => {
  const { limiter, now } = host
  const routeKeys: Array<string> = []
  const clientKeys: Array<string> = []
  let used = new Float64Array(0)
  let resetAt = new Float64Array(0)

  const routeKey = (route: number): string => routeKeys[route] ?? (routeKeys[route] = route === 0 ? `${host.id}/stage` : `${host.id}/stage/${route}`)
  const clientKey = (client: number): string => clientKeys[client] ?? (clientKeys[client] = `${host.id}/client/${client}`)

  /** Make room for `clients` quota counters, keeping what has been counted. */
  const grow = (clients: number): void => {
    if (clients <= used.length) return
    const nextUsed = new Float64Array(clients)
    const nextReset = new Float64Array(clients)
    nextUsed.set(used)
    nextReset.set(resetAt)
    used = nextUsed
    resetAt = nextReset
  }

  const admit = (plan: Plan, key: number): Admission => {
    const up = plan.usagePlan
    if (up !== undefined) {
      const client = bucketOf(key, SALT_CLIENT, up.clients)
      if (up.bucket !== undefined && !limiter.takeUnsafe(clientKey(client), up.bucket)) return Admit.Client
      if (up.quota > 0) {
        grow(up.clients)
        const t = now()
        if (t >= resetAt[client]!) {
          used[client] = 0
          resetAt[client] = (Math.floor(t / up.periodMs) + 1) * up.periodMs
        }
        if (used[client]! >= up.quota) return Admit.Quota
        used[client]!++
      }
    }
    if (plan.stage !== undefined) {
      const route = plan.routes > 1 ? bucketOf(key, SALT_ROUTE, plan.routes) : 0
      if (!limiter.takeUnsafe(routeKey(route), plan.stage)) return Admit.Stage
    }
    return limiter.takeUnsafe(host.accountKey, plan.account) ? Admit.Admitted : Admit.Account
  }

  return {
    admit,
    stageLevel: (plan) => {
      if (plan.stage === undefined) return 0
      let lowest = Infinity
      for (let r = 0; r < plan.routes; r++) lowest = Math.min(lowest, limiter.levelUnsafe(routeKey(r), plan.stage))
      return lowest
    },
    accountLevel: (plan) => limiter.levelUnsafe(host.accountKey, plan.account)
  }
}
