import * as Setting from "../../../Setting.ts"
import { docs } from "../../internal/docs.ts"

/**
 * Where every Elastic Load Balancing number comes from, and the numbers themselves. Each constant names the page that
 * says so (checked October 2026); the ones AWS doesn't publish are labelled assumptions.
 */

const ALB = `${docs.elb}application/`
const NLB = `${docs.elb}network/`

export const URL = {
  albDocs: `${ALB}introduction.html`,
  albAttributes: `${ALB}edit-load-balancer-attributes.html`,
  albSubnets: `${ALB}application-load-balancers.html`,
  albHealthChecks: `${ALB}target-group-health-checks.html`,
  albTargetGroups: `${ALB}load-balancer-target-groups.html`,
  albTargetGroupAttributes: `${ALB}edit-target-group-attributes.html`,
  albLambda: `${ALB}lambda-functions.html`,
  albTroubleshooting: `${ALB}load-balancer-troubleshooting.html`,
  albMetrics: `${ALB}load-balancer-cloudwatch-metrics.html`,
  albQuotas: `${ALB}load-balancer-limits.html`,
  albReservation: `${ALB}capacity-unit-reservation.html`,
  nlbDocs: `${NLB}introduction.html`,
  nlb: `${NLB}network-load-balancers.html`,
  nlbHealthChecks: `${NLB}target-group-health-checks.html`,
  nlbTargetGroupAttributes: `${NLB}edit-target-group-attributes.html`,
  nlbMetrics: `${NLB}load-balancer-cloudwatch-metrics.html`,
  nlbQuotas: `${NLB}load-balancer-limits.html`,
  howItWorks: `${docs.elb}userguide/how-elastic-load-balancing-works.html`,
  createTargetGroup: `${docs.elb}APIReference/API_CreateTargetGroup.html`,
  pricing: "https://aws.amazon.com/elasticloadbalancing/pricing/"
} as const

// ---------------------------------------------------------------------------------------------------------
// Published numbers
// ---------------------------------------------------------------------------------------------------------

/** The DNS records of a load balancer have a 60-second TTL (How Elastic Load Balancing works; target group health). */
export const DNS_TTL_MS = 60_000

/** An ALB must be enabled in at least two Availability Zones (Subnets for your load balancer). An NLB in one. */
export const ALB_MIN_ZONES = 2
export const NLB_MIN_ZONES = 1

/** ALB idle timeout: 60 s by default, 1 to 4,000 s (Edit attributes for your Application Load Balancer). */
export const ALB_IDLE_TIMEOUT_S = 60
export const ALB_IDLE_TIMEOUT_MAX_S = 4_000

/** NLB TCP idle timeout: 350 s by default, 60 to 6,000 s (Network Load Balancers, Connection idle timeout). */
export const NLB_IDLE_TIMEOUT_S = 350
export const NLB_IDLE_TIMEOUT_MIN_S = 60
export const NLB_IDLE_TIMEOUT_MAX_S = 6_000

/** A Lambda target takes request bodies and returns responses of at most 1 MB (Lambda functions as targets). */
export const LAMBDA_MAX_BODY_BYTES = 1024 * 1024
/**
 * The ALB waits for a Lambda target until it answers or times out; a function times out after at most 15 minutes, so
 * this bounds the wait if nothing ever answers (a black-holed edge).
 */
export const LAMBDA_MAX_WAIT_MS = 15 * 60_000

/** LCU reservations: at least 100 LCUs; at most 15,000 per ALB by default (quota); 0 per Region until raised (quota). */
export const MIN_RESERVED_LCU = 100
export const ALB_MAX_RESERVED_LCU = 15_000

/**
 * What one LCU covers (Elastic Load Balancing pricing). An ALB's capacity units: 25 new connections a second, 3,000
 * active connections, 1 GB processed an hour for instance, IP and container targets (0.4 GB for Lambda targets), 1,000
 * rule evaluations a second with the first 10 rules of a request free (and the dimension ignored with 10 or fewer
 * rules). An NLB's (TCP): 800 new connections a second, 100,000 active connections, 1 GB an hour.
 */
export const ALB_LCU = { newPerS: 25, active: 3_000, bytesPerHour: 1e9, lambdaBytesPerHour: 0.4e9, rulesPerS: 1_000, freeRules: 10 } as const
export const NLB_LCU = { newPerS: 800, active: 100_000, bytesPerHour: 1e9 } as const

/** Target groups per action (weighted forward): 5, hard. Rules per load balancer: 100 (ALB: adjustable; NLB: hard). */
export const TARGET_GROUPS_PER_ACTION = 5
export const MAX_RULES = 100

// ---------------------------------------------------------------------------------------------------------
// Assumptions: what AWS doesn't publish
// ---------------------------------------------------------------------------------------------------------

/**
 * How long ELB takes to notice that one of its nodes is down and take its address out of DNS: assumed immediate, so
 * what clients see is the 60-second TTL running out (AWS publishes neither its zonal health checks' timing nor a figure).
 */
export const NODE_DETECTION_MS = 0
/** How often a load balancer re-reads its zones' and target groups' health for DNS, and its own load: once a second. */
export const TICK_MS = 1_000
/** The utilisation an ALB scales to (capacity = demand ÷ this): assumed, leaving 40% headroom for a jump. */
export const TARGET_UTILIZATION = 0.7
/** How fast an ALB gives capacity back when traffic falls: it halves at most every ten minutes (assumed). */
export const SCALE_IN_HALF_LIFE_MS = 10 * 60_000

// ---------------------------------------------------------------------------------------------------------
// Settings shared by both load balancers
// ---------------------------------------------------------------------------------------------------------

/**
 * What a call through a load balancer does to its target: by default whatever the caller asked (a GET stays a read), since
 * a load balancer is a transparent hop. The same field as a plain link's, with that default.
 */
export const request = Setting.group(
  {
    operation: Setting.choice(["caller", "read", "write"], {
      default: "caller",
      labels: { caller: "What the caller asked (read or write)", read: "Read", write: "Write" },
      help: "What the request does to the target. By default whatever the client sent: a load balancer passes requests on unchanged."
    }),
    payload: Setting.int({ default: 0, min: 0, max: 1_000_000, unit: "KB", label: "Payload size", help: "Size of what the request carries. 0 keeps the size the client gave it." })
  },
  { label: "Request" }
)

/** Requests a client sends over one connection: how many new connections a request rate means, for LCUs (assumed). */
export const requestsPerConnection = Setting.int({
  default: 10,
  min: 1,
  max: 100_000,
  unit: "requests",
  label: "Requests per connection",
  help: "How many requests a client sends over one connection before opening another (keep-alive). It turns the request rate into new connections a second, one of the dimensions LCUs are counted in. An assumption: clients that reuse connections send many; 1 is a new connection per request."
})
