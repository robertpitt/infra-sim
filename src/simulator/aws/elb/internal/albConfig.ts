import { Schema } from "effect"
import * as Setting from "../../../Setting.ts"
import { ALB_IDLE_TIMEOUT_MAX_S, ALB_IDLE_TIMEOUT_S, ALB_MAX_RESERVED_LCU, ALB_MIN_ZONES, MAX_RULES, requestsPerConnection, URL } from "./config.ts"

/** An Application Load Balancer's settings: its zones, its listener's routing, its idle timeout, and its capacity. */
export const AlbConfig = Schema.Struct({
  zones: Setting.int({
    default: 3,
    min: ALB_MIN_ZONES,
    max: 6,
    unit: "zones",
    label: "Availability Zones",
    help: "Zones the load balancer has a node in: the first ones of its region (a, b, c...). Clients spread over the nodes through DNS. A zone outage takes its node away; with cross-zone off a node only sends to targets in its own zone. An ALB needs at least two.",
    limit: Setting.hard(URL.albSubnets, "At least two Availability Zones.")
  }),
  routing: Setting.choice(["weighted", "rules"], {
    default: "weighted",
    labels: { weighted: "Weighted target groups (one forward action)", rules: "Listener rules (path or host conditions)" },
    label: "Routing",
    help: "How a request picks its target group (an edge). Weighted: at random by the edges' weights, as a forward action to several target groups does (blue/green, canary). Rules: by the request's key, an edge's weight being the share of requests its rule matches, so one path (key) always reaches the same target group."
  }),
  rules: Setting.int({
    default: 0,
    min: 0,
    max: MAX_RULES,
    unit: "rules",
    label: "Listener rules",
    help: "Rules the listener evaluates for each request (besides the default rule). Only their cost is modelled: past 10, rule evaluations count towards LCUs.",
    limit: Setting.quota(URL.albQuotas, "100 rules per Application Load Balancer, excluding default rules.")
  }),
  idleTimeout: Setting.duration({
    default: `${ALB_IDLE_TIMEOUT_S} seconds`,
    min: "1 second",
    max: `${ALB_IDLE_TIMEOUT_MAX_S} seconds`,
    label: "Idle timeout",
    help: "How long the load balancer waits for its target to start answering before it gives up with 504 (the target keeps working). Lambda targets are waited for until they answer.",
    limit: Setting.hard(URL.albAttributes, "1 to 4,000 seconds; 60 by default.")
  }),
  overhead: Setting.latency({
    mean: "1 millis",
    cv: 0.5,
    label: "Load balancer processing time",
    help: "Time the load balancer itself adds to a request (request and response processing time in its access logs). AWS publishes no figure: an assumption."
  }),
  requestsPerConnection,
  capacity: Setting.group(
    {
      model: Setting.bool({
        default: true,
        label: "Model scaling",
        help: "Give the load balancer a capacity that follows its traffic with a lag, so a sudden surge finds it short and some connections are rejected while it scales. AWS publishes how capacity is counted (LCUs) but not how fast it scales: the numbers below are assumptions. Off: unlimited capacity."
      }),
      reserved: Setting.int({
        default: 0,
        min: 0,
        max: ALB_MAX_RESERVED_LCU,
        unit: "LCU",
        label: "LCU reservation",
        help: "Capacity reserved ahead of an event: the load balancer never has less. 0 is none; a reservation is at least 100 LCUs. Needs the Region's reserved-LCU quota raised (it is 0 by default).",
        limit: Setting.quota(URL.albQuotas, "At least 100 LCUs; at most 15,000 per ALB by default (adjustable).")
      }),
      minimum: Setting.int({
        default: 10,
        min: 1,
        max: 1_000_000,
        unit: "LCU",
        label: "Minimum capacity",
        help: "The capacity the load balancer keeps however quiet it is, and starts with if it has no traffic. An assumption: AWS doesn't publish it. (It starts scaled to the traffic of its first second.)"
      }),
      scaleUpPerMinute: Setting.number({
        default: 2,
        min: 1.1,
        max: 100,
        step: 0.1,
        unit: "× a minute",
        label: "Scale-up rate",
        help: "How much capacity can grow in a minute while demand is above it: 2 is doubling every minute. An assumption: AWS doesn't publish how fast an ALB scales."
      })
    },
    { label: "Capacity (LCUs)" }
  )
})
export type AlbSettings = typeof AlbConfig.Type
