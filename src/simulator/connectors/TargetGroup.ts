import { Effect, Schema } from "effect"
import * as Connector from "../Connector.ts"
import { type Dashboard, gauge, rate, ratio } from "../Dashboard.ts"
import * as Edge from "../Edge.ts"
import * as Group from "../fleet/TargetGroup.ts"
import { shapeCall } from "./Link.ts"

/**
 * A load balancer's target group on an edge into a fleet (`common.service`, and the EC2, ECS and EKS fleets built on
 * `fleet/`): it registers the fleet's units as they come up, checks their health, and sends each call to one unit it
 * picks, through the edge's transport. See `fleet/TargetGroup.ts` for what it models.
 *
 * It fits any `invoke` port wired to a fleet, but a plain link fits too and comes first, so a client calling a service
 * directly gets the idealised balancer it always had; name this connector on the edge (`connector: core.target-group`)
 * to put a target group there, or let a load balancer's own connector (which names its component) be picked for it.
 *
 * Its defaults are assumptions, not any one product's: health checks every 10 seconds with a 5-second timeout, 3 in a
 * row either way, a 30-second deregistration delay. A provider's load balancer brings its own published defaults
 * (`Group.fields(defaults)`).
 */
export const Config = Schema.Struct({
  weight: Edge.Policy.fields.weight,
  request: Edge.Policy.fields.request,
  timeout: Edge.Policy.fields.timeout,
  cancelOnTimeout: Edge.Policy.fields.cancelOnTimeout,
  ...Group.fields()
})

/**
 * What the target group records on its edge, beside transport's (whose `calls` are its request count: a balancer doesn't
 * retry). It belongs to no provider, so it names no CloudWatch metric; the help says which of an Application Load
 * Balancer's target group metrics each stands for (HealthyHostCount, UnHealthyHostCount, RequestCountPerTarget,
 * HTTPCode_ELB_503_Count), and a provider's own target group connector names them.
 */
export const dashboard: Dashboard = {
  figures: [
    { label: "Healthy", metric: gauge("targets.healthy"), unit: "count" },
    { label: "Unhealthy", metric: gauge("targets.unhealthy"), unit: "count", tone: "bad" }
  ],
  panels: [
    {
      id: "target-health",
      title: "Target health",
      unit: "count",
      help: "Registered targets by health (a load balancer's healthy and unhealthy host counts): healthy ones get requests, new ones wait for their first passing check, unhealthy ones get none (unless every target is, and the group fails open), draining ones finish what they hold.",
      lines: [
        { label: "healthy", metric: gauge("targets.healthy"), tone: "ok" },
        { label: "unhealthy", metric: gauge("targets.unhealthy"), tone: "bad" },
        { label: "initial", metric: gauge("targets.initial"), tone: "warn" },
        { label: "draining", metric: gauge("targets.draining"), tone: "muted" }
      ]
    },
    {
      id: "requests-per-target",
      title: "Request count per target",
      unit: "perMinute",
      help: "Requests a minute over the healthy targets (a load balancer's RequestCountPerTarget): what a request-count target-tracking policy holds near its target.",
      lines: [{ label: "per target", metric: ratio(rate("calls"), gauge("targets.healthy"), 60), tone: "primary" }]
    },
    {
      id: "no-target",
      title: "No healthy target",
      unit: "perSecond",
      help: "Requests the balancer answered 503 itself because no target could take them (an ALB's HTTPCode_ELB_503_Count).",
      lines: [{ label: "503", metric: rate("noTarget"), tone: "bad" }]
    }
  ]
}

export const TargetGroup = Connector.make({
  type: "core.target-group",
  title: "Target group",
  description: "A load balancer's target group: registers a fleet's units, checks their health, and picks one for each call (round robin, least outstanding requests, random or by key), with slow start, deregistration delay and cross-zone balancing.",
  icon: "balancer",
  dashboard,
  from: { protocol: "invoke" },
  to: { protocol: "fleet" },
  config: Config,
  state: Group.State,
  make: (ctx) =>
    Effect.sync(() => {
      const group = new Group.TargetGroup({ to: ctx.to, fleet: ctx.target, sink: ctx.sink, fast: ctx.fast, meter: ctx.meter }, shapeCall)
      return {
        send: (message, done) => group.send(message, done),
        probe: Effect.sync(() => group.status())
      }
    })
})
