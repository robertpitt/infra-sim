import { Effect, Schema } from "effect"
import * as Connector from "../Connector.ts"
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

export const TargetGroup = Connector.make({
  type: "core.target-group",
  title: "Target group",
  description: "A load balancer's target group: registers a fleet's units, checks their health, and picks one for each call (round robin, least outstanding requests, random or by key), with slow start, deregistration delay and cross-zone balancing.",
  icon: "balancer",
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
