import { Schema } from "effect"
import * as Component from "../../../Component.ts"
import * as Setting from "../../../Setting.ts"
import { SECOND_MS } from "../../internal/units.ts"

/** Where AWS documents Route 53. Every limit below links to a page under here or the API reference. */
export const DOCS = "https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/"
const API = "https://docs.aws.amazon.com/Route53/latest/APIReference/"
export const QUOTAS_URL = `${DOCS}DNSLimitations.html`
/** The 18% rule, the HTTP and TCP timeouts, and "a new health check is healthy until there's enough data". */
export const HEALTH_URL = `${DOCS}dns-failover-determining-health-of-endpoints.html`
/** Request interval, failure threshold, health checker regions, and "about every two seconds". */
export const HEALTH_VALUES_URL = `${DOCS}health-checks-creating-values.html`
/** The ranges and defaults of a health check: interval 10 or 30 (30), threshold 1 to 10 (3), 3 to 8 checker regions. */
export const HEALTH_API_URL = `${API}API_HealthCheckConfig.html`
/** TTL, weight, failover and latency record fields. */
export const RECORD_API_URL = `${API}API_ResourceRecordSet.html`
/** How Route 53 picks a healthy record: no health check means healthy, none healthy means all healthy, failover. */
export const CHOOSING_URL = `${DOCS}health-checks-how-route-53-chooses-records.html`
export const SIMPLE_URL = `${DOCS}routing-policy-simple.html`
export const WEIGHTED_URL = `${DOCS}routing-policy-weighted.html`
export const LATENCY_URL = `${DOCS}routing-policy-latency.html`
export const GEO_URL = `${DOCS}routing-policy-geo.html`
/** Continent codes, the Default location, and falling back to a larger region when a record is unhealthy. */
export const GEO_VALUES_URL = `${DOCS}resource-record-sets-values-geo.html`
/** What a TTL does, and AWS's recommendation of 60 seconds or less for a record with a health check. */
export const TTL_URL = `${DOCS}resource-record-sets-values-shared.html`

/** A TTL is a 32-bit count of seconds: 0 to 2,147,483,647. */
export const MAX_TTL_MS = 2_147_483_647 * SECOND_MS
/** The TTL AWS recommends, at most, for a record with a health check. */
export const RECOMMENDED_HEALTH_CHECKED_TTL_MS = 60 * SECOND_MS
/** A weight is 0 to 255. */
export const MAX_WEIGHT = 255
/** Weighted, latency, geolocation (and multivalue) records with the same name and type: at most 100. */
export const MAX_POLICY_RECORDS = 100
/** A simple record holds at most 400 values ("Records in a record set"). */
export const MAX_SIMPLE_VALUES = 400

/** More than this share of the health checkers must call an endpoint healthy for Route 53 to call it healthy. */
export const HEALTHY_SHARE = 0.18
/** HTTP and HTTPS checks: a TCP connection within 4 seconds, then a 2xx or 3xx within 2 seconds of connecting. */
export const HTTP_CONNECT_TIMEOUT_MS = 4 * SECOND_MS
export const HTTP_RESPONSE_TIMEOUT_MS = 2 * SECOND_MS
/** TCP checks: a connection within 10 seconds. The longest any health checker waits. */
export const TCP_CONNECT_TIMEOUT_MS = 10 * SECOND_MS
/** The regions health checkers run in (the API's valid values). With none chosen, all of them check. */
export const CHECKER_REGIONS = ["us-east-1", "us-west-1", "us-west-2", "eu-west-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1", "sa-east-1"] as const

export const POLICIES = ["simple", "weighted", "failover", "latency", "geolocation"] as const
export type Policy = (typeof POLICIES)[number]

/** Route 53's continent codes, and `default` for the record that answers every location without its own. */
export const LOCATIONS = ["default", "AF", "AN", "AS", "EU", "NA", "OC", "SA"] as const
export type Location = (typeof LOCATIONS)[number]

/**
 * The continent the callers of a node are on, from the AWS Region the node is placed in (see "Where the callers are" in
 * the README). Route 53's own list puts the Middle East in Asia, and Australia and New Zealand in Oceania.
 */
export const continentOf = (region: string): Location | undefined => {
  if (region === "ap-southeast-2" || region === "ap-southeast-4" || region === "ap-southeast-6") return "OC"
  const prefix = region.slice(0, region.indexOf("-"))
  switch (prefix) {
    case "us":
    case "ca":
    case "mx":
      return "NA"
    case "sa":
      return "SA"
    case "eu":
      return "EU"
    case "af":
      return "AF"
    case "ap":
    case "me":
    case "il":
      return "AS"
  }
  return undefined
}

/**
 * Settings of the record (the group of records with one name and type, one routing policy) and of the resolvers that
 * cache its answers. See `README.md` for the source of every number.
 */
export const Config = Schema.Struct({
  policy: Setting.choice(POLICIES, {
    default: "simple",
    labels: {
      simple: "Simple (values in random order, no health checks)",
      weighted: "Weighted (by each record's weight)",
      failover: "Failover (primary, then secondary)",
      latency: "Latency (the endpoint nearest the callers)",
      geolocation: "Geolocation (by the callers' continent)"
    },
    help: "How Route 53 picks the record it answers with. Each edge on the out port is one record. Simple routing returns the values in random order and does not health-check them."
  }),
  ttl: Setting.duration({
    default: "60 seconds",
    min: 0,
    max: MAX_TTL_MS,
    label: "TTL",
    help: "How long resolvers cache an answer before asking Route 53 again. AWS recommends 60 seconds or less for records with a health check; 60 s is also the TTL of an alias to a load balancer. 0 means every call asks.",
    limit: Setting.hard(RECORD_API_URL, "0 to 2,147,483,647 seconds.")
  }),
  healthCheck: Setting.group(
    {
      type: Setting.choice(["http", "tcp"], {
        default: "http",
        labels: { http: "HTTP or HTTPS", tcp: "TCP" },
        help: "HTTP: a connection within 4 s, then a 2xx or 3xx within 2 s of connecting. TCP: only a connection, within 10 s, so an endpoint that answers every request with a 500 still passes."
      }),
      interval: Setting.choice(["30", "10"], {
        default: "30",
        labels: { "30": "Standard (30 seconds)", "10": "Fast (10 seconds, costs more)" },
        help: "Seconds between one health checker's response and its next request. Only 10 or 30 (hard); AWS's default is 30."
      }),
      failureThreshold: Setting.int({
        default: 3,
        min: 1,
        max: 10,
        label: "Failure threshold",
        help: "Consecutive checks a health checker must see fail (or pass) before it changes its mind. AWS's default is 3.",
        limit: Setting.hard(HEALTH_API_URL, "1 to 10, default 3.")
      }),
      regions: Setting.int({
        default: 8,
        min: 3,
        max: CHECKER_REGIONS.length,
        unit: "regions",
        label: "Health checker regions",
        help: "How many regions check each endpoint. With none chosen AWS uses all eight; you must keep at least three.",
        limit: Setting.hard(HEALTH_API_URL, "At least 3 of the 8 health checker regions; all 8 by default.")
      }),
      checkersPerRegion: Setting.int({
        default: 2,
        min: 1,
        max: 10,
        label: "Checkers per region",
        help: "AWS does not publish how many health checkers each region runs. It says that at a 30 second interval an endpoint gets a check about every two seconds, which is about 15 checkers, so 2 in each of 8 regions. An assumption."
      })
    },
    { label: "Health checks" }
  ),
  resolvers: Setting.group(
    {
      count: Setting.int({
        default: 1_000,
        min: 1,
        max: 100_000,
        label: "Resolver caches",
        help: "How many DNS caches (recursive resolvers, and the caches in clients' own stub resolvers) the callers are spread over. Each caches its own answer, and they expire at different times, so a change reaches the traffic gradually over one TTL. A weighted split is a split of these caches. An assumption."
      }),
      lookup: Setting.latency({
        mean: "20 millis",
        cv: 0.5,
        label: "Lookup time on a cache miss",
        help: "What a call waits when its resolver has no live answer and asks Route 53. Calls answered from a cache wait nothing: Route 53 is not in the data path. An assumption."
      }),
      ignoreTtlShare: Setting.ratio({
        default: 0,
        label: "Resolvers that ignore the TTL",
        help: "The share of caches that keep an answer longer than its TTL (some ISP resolvers, a JVM caching for the life of the process). They go on sending traffic to an endpoint after everyone else has moved. How many there are is an assumption."
      }),
      ignoreTtlFor: Setting.duration({
        default: "15 minutes",
        min: 0,
        max: "1 day",
        label: "They keep answers for",
        help: "How long a resolver that ignores the TTL keeps an answer. An assumption."
      })
    },
    { label: "Resolvers" }
  )
})
export type Config = typeof Config.Type

/**
 * What an edge leaving the `out` port is: one record, pointing at one endpoint. Which fields matter depends on the
 * routing policy; the others are ignored.
 */
export const RecordSettings = Schema.Struct({
  weight: Setting.int({
    default: 1,
    min: 0,
    max: MAX_WEIGHT,
    label: "Weight",
    help: "Weighted routing: this record's share is its weight over the total. 0 gets no traffic unless every record with a weight is unhealthy; all zero is an even split.",
    limit: Setting.hard(RECORD_API_URL, "0 to 255.")
  }),
  role: Setting.choice(["primary", "secondary"], {
    default: "primary",
    labels: { primary: "Primary", secondary: "Secondary" },
    help: "Failover routing: the secondary is answered while the primary is unhealthy and the secondary is not. A secondary without a health check is always healthy."
  }),
  location: Setting.choice(LOCATIONS, {
    default: "default",
    labels: {
      default: "Default (everywhere else)",
      AF: "Africa",
      AN: "Antarctica",
      AS: "Asia",
      EU: "Europe",
      NA: "North America",
      OC: "Oceania",
      SA: "South America"
    },
    help: "Geolocation routing: the continent this record answers. Without a default record, callers from anywhere else get no answer."
  }),
  healthCheck: Setting.bool({
    default: true,
    label: "Health check",
    help: "Associate a health check with this record. Route 53 probes the endpoint through this edge and stops answering with the record while it is unhealthy. A record without one is always healthy. Simple routing has no health checks."
  })
})
export type RecordSettings = typeof RecordSettings.Type

/** One record as the probe reports it. */
export const RecordState = Schema.Struct({
  edge: Schema.String,
  to: Schema.String,
  /** Whether a health check watches it (the policy uses them, the record asks for one and the account quota allows it). */
  healthChecked: Schema.Boolean,
  /** Whether Route 53 answers with it: true for a record without a health check. */
  healthy: Schema.Boolean,
  /** Health checkers that call the endpoint healthy right now, of how many. */
  checkersHealthy: Schema.Number,
  checkers: Schema.Number,
  /** When Route 53 last changed its mind about it, in ms of simulated time (0 if never). */
  changedAt: Schema.Number,
  /** The share of resolver caches holding a live answer that points here. */
  cachedShare: Schema.Number
})

/** What a probe reports. */
export const State = Schema.Struct({
  policy: Schema.String,
  ttlSeconds: Schema.Number,
  records: Schema.Array(RecordState),
  resolvers: Schema.Number,
  /** Resolver caches holding a live answer, and the share of those that point at an unhealthy record. */
  cached: Schema.Number,
  cachedUnhealthy: Schema.Number,
  /** Since the start: lookups that reached Route 53, calls answered from a cache, calls with no answer. */
  queries: Schema.Number,
  cacheHits: Schema.Number,
  noAnswer: Schema.Number,
  probes: Schema.Number,
  probeFailures: Schema.Number,
  /** Health checks this record holds, and the ones the account quota refused. */
  healthChecks: Schema.Number,
  healthChecksRefused: Schema.Number
})

/** The record's one output: the endpoints its records point at. */
export const ports = { out: Component.port.many("Records", RecordSettings) }
