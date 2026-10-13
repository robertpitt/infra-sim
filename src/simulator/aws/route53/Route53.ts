import { Effect } from "effect"
import * as Aws from "../internal/provider.ts"
import {
  CHOOSING_URL,
  Config,
  DOCS,
  GEO_URL,
  GEO_VALUES_URL,
  HEALTH_API_URL,
  HEALTH_URL,
  HEALTH_VALUES_URL,
  LATENCY_URL,
  ports,
  QUOTAS_URL,
  RECORD_API_URL,
  SIMPLE_URL,
  State,
  WEIGHTED_URL
} from "./internal/config.ts"
import { dashboard } from "./internal/dashboard.ts"
import { HealthCheckLedger, makeRuntime } from "./internal/runtime.ts"

/**
 * Amazon Route 53: DNS. One record name with its routing policy, each edge on its `out` port one record pointing at
 * an endpoint. Route 53 is not in the data path: callers ask their resolver, which caches the answer for the TTL, and
 * then connect to the endpoint directly. So the node adds no time of its own except a lookup when a cache has run out,
 * and a change of answer (a failover, a new weight) reaches the traffic only as caches expire. See `README.md`.
 */
export const Route53 = Aws.component({
  type: "aws.route53",
  service: "Route 53",
  title: "Route 53 record",
  description:
    "DNS routing between endpoints: simple, weighted, failover, latency and geolocation records, health checks that probe each endpoint from several regions, and resolvers that cache each answer for its TTL, so traffic moves only as their caches expire.",
  docs: DOCS,
  category: "network",
  // Route 53's data plane answers from edge locations everywhere and is built to keep answering through a regional outage.
  global: true,
  // Its callers' failures are the endpoints': they alarm there, not twice.
  quietAlarms: ["errors"],
  icon: "dns",
  accent: "#8c4fff",
  dashboard,
  limits: [
    { label: "Health checks", value: "200 active per account", adjustable: true, source: QUOTAS_URL, note: "The account quota route53HealthChecks. A record that asks for one past it has none, and is always healthy." },
    { label: "Records with the same name and type", value: "100 (weighted, latency, geolocation, multivalue)", adjustable: false, source: QUOTAS_URL, note: "Edges past the 100th are never answered." },
    { label: "Values in a simple record", value: "400", adjustable: false, source: QUOTAS_URL },
    { label: "Weight", value: "0 to 255", adjustable: false, source: RECORD_API_URL },
    { label: "TTL", value: "0 to 2,147,483,647 seconds; 60 s or less recommended with a health check", adjustable: false, source: RECORD_API_URL },
    { label: "Health check request interval", value: "10 or 30 seconds (default 30)", adjustable: false, source: HEALTH_API_URL },
    { label: "Failure threshold", value: "1 to 10 consecutive checks (default 3)", adjustable: false, source: HEALTH_API_URL },
    { label: "Health checker regions", value: "At least 3 of 8 (all 8 by default)", adjustable: false, source: HEALTH_API_URL },
    { label: "Healthy verdict", value: "More than 18% of health checkers report healthy", adjustable: false, source: HEALTH_URL },
    { label: "HTTP(S) check", value: "Connect within 4 s, then 2xx or 3xx within 2 s", adjustable: false, source: HEALTH_URL },
    { label: "TCP check", value: "Connect within 10 s", adjustable: false, source: HEALTH_URL },
    { label: "Health check request rate", value: "About one every 2 s at a 30 s interval", adjustable: false, source: HEALTH_VALUES_URL },
    { label: "Simple routing", value: "Values in random order, not health checked", adjustable: false, source: SIMPLE_URL },
    { label: "Weighted routing with health checks", value: "Zero-weight records only when every weighted record is unhealthy", adjustable: false, source: WEIGHTED_URL },
    { label: "Latency routing", value: "The record whose Region has the lowest latency to the caller", adjustable: false, source: LATENCY_URL, note: "The caller is where the node is placed; latency is the edge's." },
    { label: "No healthy record", value: "All records are treated as healthy", adjustable: false, source: CHOOSING_URL },
    { label: "Geolocation without a default record", value: "No answer for unmatched locations", adjustable: false, source: GEO_URL },
    { label: "Geolocation and health", value: "An unhealthy record falls back to the larger region, then the default", adjustable: false, source: GEO_VALUES_URL },
    { label: "Hosted zones, records per zone", value: "500 per account; 10,000 per zone", adjustable: true, source: QUOTAS_URL, note: "Not modelled: a node is one record." }
  ],
  highlights: [
    { rate: "queries", label: "queries/s" },
    { gauge: "unhealthyRecords", label: "unhealthy" },
    { gauge: "cachedUnhealthy", label: "cached to unhealthy", format: "percent" }
  ],
  config: Config,
  ports,
  state: State,
  make: (node) =>
    Effect.gen(function*() {
      const ledger = yield* node.shared("route53/health-checks", Effect.sync(() => new HealthCheckLedger()))
      return makeRuntime(node, ledger)
    })
})
