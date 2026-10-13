/**
 * Requests worked on by a fleet of replicas: a worker of the unit a request lands on is busy for the service time, then
 * the request calls downstream while still on its unit (its worker free), and answers. `common.service` is built on it,
 * and so are the AWS compute services that specialise it (EC2 Auto Scaling groups, ECS services, EKS workloads), each
 * telling it through a `WorkHost` where its settings are and which of its units are broken.
 */
import { Effect } from "effect"
import type * as Component from "../Component.ts"
import type { Link } from "../Edge.ts"
import type { Fleet } from "../fleet/Fleet.ts"
import type * as Flow from "../Flow.ts"
import { type Call, type CallFailure, type Message, type Reply, Unavailable } from "../Message.ts"
import type { Unit } from "../Protocol.ts"
import type * as Setting from "../Setting.ts"
import { Request } from "./internal/work.ts"

/** What a request needs of its service, made once per node so that a request is one small object. */
export interface WorkHost {
  readonly id: string
  readonly fast: Pick<Component.Fast<unknown>, "after" | "random">
  readonly out: ReadonlyArray<Link>
  /** The service time now. */
  readonly serviceTime: () => Setting.Latency
  readonly fanOut: () => Flow.FanOut
  /** The fraction of requests that fail after their work (500), drawn per request from the node's stream; at 0 (or none) nothing is drawn. */
  readonly errorRate?: () => number
  /** Whether the unit runs an application that answers every request with 500 (it fails its health checks). */
  readonly broken?: (unit: Unit) => boolean
  /** The reason a broken unit's 500 gives, if not "500 internal server error". */
  readonly brokenReason?: string
  /** Called as each call starts, before it waits for a worker. */
  readonly arrived?: () => void
  readonly totals: { served: number; errors: number; refused: number; lost: number }
}

/** The handler for calls into a fleet of replicas: plain calls (`unit` undefined) and calls a target group addressed to a unit. */
export const handler = (fleet: Fleet, host: WorkHost) => (message: Message, unit: Unit | undefined): Call =>
  Effect.callback<Reply, CallFailure>((resume) => {
    host.arrived?.()
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

/**
 * Registers per-zone gauges as a fleet spreads: `register` is called once for each zone the fleet spreads over, the first
 * time the returned function finds it there. Call that function once at the start and whenever the settings change.
 */
export const zoneGauges = (fleet: () => Pick<Fleet, "zonesList">, register: (zone: string) => void): () => void => {
  const seen = new Set<string>()
  return () => {
    for (const zone of fleet().zonesList()) {
      if (seen.has(zone)) continue
      seen.add(zone)
      register(zone)
    }
  }
}
