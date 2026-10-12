import { Duration, Effect, Schema } from "effect"
import * as Connector from "../../Connector.ts"
import * as Edge from "../../Edge.ts"
import { shapeCall } from "../../connectors/Link.ts"
import * as Group from "../../fleet/TargetGroup.ts"
import type { Message } from "../../Message.ts"
import * as Setting from "../../Setting.ts"
import { request, URL } from "./config.ts"
import { type Listener, listenerOf } from "./listener.ts"

/**
 * The connectors on a load balancer's edges. Each edge leaving a load balancer's `out` port is one target group:
 *
 *  - into a fleet (EC2 Auto Scaling, ECS, EKS, `common.service`): a target group over the core one (`fleet/TargetGroup.ts`)
 *    with AWS's defaults and AWS's ranges, which registers the fleet's units, checks their health across the edge and
 *    picks one per request;
 *  - into a Lambda function (ALB only): a target group of type `lambda`, which invokes the function;
 *  - into anything else: an IP target, one address the load balancer forwards to.
 *
 * None of them has a timeout or retries: a load balancer doesn't retry a request, and its own idle timeout (the
 * component's) decides when it stops waiting. Each keeps the caller's read or write (`request.operation: caller`), since
 * a load balancer passes a request on as it came.
 */

// ---------------------------------------------------------------------------------------------------------
// Health checks, with AWS's ranges
// ---------------------------------------------------------------------------------------------------------

/** A target group's health checks: AWS's ranges (CreateTargetGroup), with the defaults of the load balancer's kind. */
const healthCheck = (d: { readonly interval: number; readonly timeout: number; readonly healthy: number; readonly unhealthy: number }, source: string) =>
  Setting.group(
    {
      interval: Setting.duration({
        default: `${d.interval} seconds`,
        min: "5 seconds",
        max: "300 seconds",
        label: "Interval",
        help: "Time between checks of one target (HealthCheckIntervalSeconds).",
        limit: Setting.hard(source, "5 to 300 seconds.")
      }),
      timeout: Setting.duration({
        default: `${d.timeout} seconds`,
        min: "2 seconds",
        max: "120 seconds",
        label: "Timeout",
        help: "A check with no answer in this long fails (HealthCheckTimeoutSeconds). Never longer than the interval.",
        limit: Setting.hard(source, "2 to 120 seconds.")
      }),
      healthyThreshold: Setting.int({
        default: d.healthy,
        min: 2,
        max: 10,
        unit: "checks",
        label: "Healthy threshold",
        help: "Passes in a row before an unhealthy target is healthy again. A newly registered target needs only one.",
        limit: Setting.hard(source, "2 to 10.")
      }),
      unhealthyThreshold: Setting.int({
        default: d.unhealthy,
        min: 2,
        max: 10,
        unit: "checks",
        label: "Unhealthy threshold",
        help: "Failures in a row before a target is unhealthy and gets no new requests.",
        limit: Setting.hard(source, "2 to 10.")
      })
    },
    { label: "Health checks" }
  )

const deregistrationDelay = (source: string) =>
  Setting.duration({
    default: "300 seconds",
    min: 0,
    max: "3600 seconds",
    label: "Deregistration delay",
    help: "How long a target the fleet lets go (scaled in, replaced) is kept to finish its requests; it gets no new ones, and goes sooner if it finishes them. A request still on it when the delay runs out fails (502 at an ALB).",
    limit: Setting.hard(source, "0 to 3,600 seconds.")
  })

const replaceUnhealthy = Setting.bool({
  default: true,
  label: "Fleet replaces unhealthy targets",
  help: "Tell the fleet when a target fails its health checks, so it replaces it: what an ECS service does, and an Auto Scaling group whose health check type is ELB (the fleet decides whether it listens)."
})

// ---------------------------------------------------------------------------------------------------------
// ALB target group
// ---------------------------------------------------------------------------------------------------------

export const AlbGroupConfig = Schema.Struct({
  weight: Edge.Policy.fields.weight,
  request,
  algorithm: Setting.choice(["round-robin", "least-outstanding", "random"], {
    default: "round-robin",
    labels: { "round-robin": "Round robin", "least-outstanding": "Least outstanding requests", random: "Weighted random" },
    label: "Routing algorithm",
    help: "Round robin (the default) takes targets in turn; least outstanding requests picks the one with the fewest requests in flight; weighted random picks at random. Anomaly mitigation (weighted random only) is not modelled."
  }),
  slowStart: Setting.duration({
    default: 0,
    min: 0,
    max: "900 seconds",
    label: "Slow start",
    help: "A target that just became healthy gets a share of requests growing linearly to a full one over this long. 0 is off; otherwise 30 to 900 seconds. Round robin only: AWS refuses it with least outstanding requests or weighted random, and the simulator ignores it there.",
    limit: Setting.hard(URL.albTargetGroups, "0 (off), or 30 to 900 seconds.")
  }),
  stickiness: Setting.bool({
    default: false,
    label: "Sticky sessions",
    help: "Send a client (a message key) back to the same target while it stays registered and healthy. Modelled as a hash of the key over the targets, so a change of targets moves some clients; the cookie's duration is not modelled. Not with cross-zone off or weighted random (AWS refuses both)."
  }),
  crossZone: Setting.bool({
    default: true,
    label: "Cross-zone load balancing",
    help: "On (the ALB default): every load balancer node sends to targets in every zone. Off: each node only to targets in its own zone, so a zone with fewer targets gives each more, and a zone with none answers 503."
  }),
  deregistrationDelay: deregistrationDelay(URL.albTargetGroups),
  replaceUnhealthy,
  healthCheck: healthCheck({ interval: 30, timeout: 5, healthy: 5, unhealthy: 2 }, URL.albHealthChecks)
})
type AlbGroupSettings = typeof AlbGroupConfig.Type

/** The shortest slow start AWS accepts: anything from 1 to 29 seconds counts as 30. */
const MIN_SLOW_START_MS = 30_000

const albGroupSettings = (c: AlbGroupSettings): Group.Settings => {
  const slowMs = Duration.toMillis(c.slowStart)
  return {
    ...c,
    algorithm: c.stickiness ? "flow-hash" : c.algorithm,
    // Slow start only with round robin, and at least 30 seconds.
    slowStart: c.algorithm === "round-robin" && !c.stickiness && slowMs > 0 ? Duration.millis(Math.max(MIN_SLOW_START_MS, slowMs)) : Duration.zero,
    // An ALB always fails open, and health checks of instance and IP targets can't be turned off.
    failOpen: true,
    healthCheck: { ...c.healthCheck, enabled: true },
    timeout: Duration.infinity,
    cancelOnTimeout: false
  }
}

// ---------------------------------------------------------------------------------------------------------
// NLB target group
// ---------------------------------------------------------------------------------------------------------

export const NlbGroupConfig = Schema.Struct({
  weight: Edge.Policy.fields.weight,
  request,
  crossZone: Setting.bool({
    default: false,
    label: "Cross-zone load balancing",
    help: "Off (the NLB default): each load balancer node sends only to targets in its own zone. On: to targets in every zone (and cross-zone data transfer is charged)."
  }),
  deregistrationDelay: deregistrationDelay(URL.nlbTargetGroupAttributes),
  replaceUnhealthy,
  healthCheck: healthCheck({ interval: 30, timeout: 10, healthy: 5, unhealthy: 2 }, URL.nlbHealthChecks)
})
type NlbGroupSettings = typeof NlbGroupConfig.Type

const nlbGroupSettings = (c: NlbGroupSettings): Group.Settings => ({
  ...c,
  // An NLB keeps each connection on one target: a hash of the flow, here the message's key.
  algorithm: "flow-hash",
  slowStart: Duration.zero,
  failOpen: true,
  healthCheck: { ...c.healthCheck, enabled: true },
  timeout: Duration.infinity,
  cancelOnTimeout: false
})

// ---------------------------------------------------------------------------------------------------------
// The connectors
// ---------------------------------------------------------------------------------------------------------

/** `map` applied to the edge's settings, again only when they are replaced: the target group reads them per request. */
const mapped = <A, B>(read: () => A, map: (a: A) => B): (() => B) => {
  let from: A | undefined
  let to: B
  return () => {
    const a = read()
    if (a !== from) {
      from = a
      to = map(a)
    }
    return to
  }
}

/**
 * A target group on an edge from a load balancer into a fleet. It registers itself with the load balancer's listener (for
 * DNS failover) and sends each request to the zone the listener says it arrived in. `RequestCountPerTarget` is a gauge
 * on the edge: requests a minute per healthy target (per registered target when none is healthy), at the current rate.
 */
const targetGroup = <C extends Connector.Settings>(o: {
  readonly type: string
  readonly component: string
  readonly title: string
  readonly description: string
  readonly docs: string
  readonly config: C
  readonly settings: (c: C["Type"]) => Group.Settings
}) =>
  Connector.make({
    type: o.type,
    provider: "aws",
    title: o.title,
    description: o.description,
    icon: "balancer",
    docs: o.docs,
    // Naming the port makes it more specific than the load balancer's IP-target connector, which also fits a fleet.
    from: { protocol: "invoke", component: o.component, port: "out" },
    to: { protocol: "fleet" },
    config: o.config,
    state: Group.State,
    make: (ctx) =>
      Effect.gen(function*() {
        const listener = yield* listenerOf(ctx.shared, ctx.from)
        const settings = mapped(ctx.fast.settings, o.settings)
        const attached = listener.attached
        const group = new Group.TargetGroup(
          { to: ctx.to, fleet: ctx.target, sink: ctx.sink, fast: { ...ctx.fast, settings }, meter: ctx.meter, ...(attached ? { zones: () => listener.zones } : {}) },
          shapeCall
        )
        if (attached) {
          listener.groups.set(ctx.id, { crossZone: () => settings().crossZone, healthyIn: (z) => group.healthyIn(z), registeredIn: (z) => group.registeredIn(z) })
        }
        let sent = 0
        let lastSent = 0
        let lastAt = ctx.fast.now()
        ctx.meter.gaugeUnsafe("requestCountPerTarget", () => {
          const now = ctx.fast.now()
          const perMinute = now > lastAt ? ((sent - lastSent) * 60_000) / (now - lastAt) : 0
          lastSent = sent
          lastAt = now
          const healthy = group.healthyIn(undefined)
          return perMinute / Math.max(1, healthy > 0 ? healthy : group.registeredIn(undefined))
        })
        return {
          send: (message: Message, done?: Edge.Done) => {
            sent++
            return group.send(message, done, attached ? listener.zone : undefined)
          },
          probe: Effect.sync(() => group.status())
        }
      })
  })

/** A target that is one address: an IP target, a Lambda function. One try, the caller's operation, no timeout of its own. */
const direct = (o: {
  readonly type: string
  readonly component: string
  readonly title: string
  readonly description: string
  readonly docs: string
  readonly to: Connector.ToEnd<"invoke">
  readonly port?: string
  readonly register?: (listener: Listener, edge: string) => void
}) =>
  Connector.make({
    type: o.type,
    provider: "aws",
    title: o.title,
    description: o.description,
    icon: "balancer",
    docs: o.docs,
    from: { protocol: "invoke", component: o.component, ...(o.port === undefined ? {} : { port: o.port }) },
    to: o.to,
    config: Schema.Struct({ weight: Edge.Policy.fields.weight, request }),
    make: (ctx) =>
      Effect.gen(function*() {
        if (o.register !== undefined) {
          const listener = yield* listenerOf(ctx.shared, ctx.from)
          if (listener.attached) o.register(listener, ctx.id)
        }
        const { fast, sink } = ctx
        return { send: (message: Message, done?: Edge.Done) => sink.call(shapeCall(message, fast.settings()), Edge.once, done) }
      })
  })

export const AlbTargetGroup = targetGroup({
  type: "aws.alb.target-group",
  component: "aws.alb",
  title: "ALB target group",
  description: "An Application Load Balancer's target group into a fleet: registers its units, checks their health every 30 s (5 passes, 2 failures), picks one per request (round robin, least outstanding requests, weighted random), with slow start, sticky sessions, a 300 s deregistration delay and cross-zone on.",
  docs: URL.albTargetGroups,
  config: AlbGroupConfig,
  settings: albGroupSettings
})

export const NlbTargetGroup = targetGroup({
  type: "aws.nlb.target-group",
  component: "aws.nlb",
  title: "NLB target group",
  description: "A Network Load Balancer's target group into a fleet: registers its units, checks them over TCP every 30 s (10 s timeout, 5 passes, 2 failures), keeps each flow on one target by a hash of its key, with a 300 s deregistration delay and cross-zone off.",
  docs: URL.nlbTargetGroupAttributes,
  config: NlbGroupConfig,
  settings: nlbGroupSettings
})

export const AlbLambdaTarget = direct({
  type: "aws.alb.lambda-target",
  component: "aws.alb",
  port: "out",
  title: "Lambda target",
  description: "An Application Load Balancer's target group of type lambda: each request invokes the function synchronously and waits for it (no idle timeout); bodies over 1 MB are refused with 413, and a function error or throttle is a 502.",
  docs: URL.albLambda,
  to: { protocol: "invoke", component: "aws.lambda" },
  register: (listener, edge) => void listener.lambdas.add(edge)
})

export const AlbIpTarget = direct({
  type: "aws.alb.ip-target",
  component: "aws.alb",
  title: "IP target",
  description: "An Application Load Balancer forwarding to one address (a target group of type ip with one target): the request as the client sent it, no retries.",
  docs: URL.albTargetGroups,
  to: { protocol: "invoke" }
})

export const NlbIpTarget = direct({
  type: "aws.nlb.ip-target",
  component: "aws.nlb",
  title: "IP or ALB target",
  description: "A Network Load Balancer forwarding connections to one address: an IP target, or an Application Load Balancer (a target group of type alb). The connection as the client opened it.",
  docs: URL.nlb,
  to: { protocol: "invoke" }
})

/** Every ELB connector, the target groups first (a fleet would fit the IP-target connectors too). */
export const connectors = [AlbTargetGroup, AlbLambdaTarget, AlbIpTarget, NlbTargetGroup, NlbIpTarget] as const
