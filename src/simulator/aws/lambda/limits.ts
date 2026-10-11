import { docs } from "../docs.ts"

/** Base URL of the Lambda developer guide. Every limit below cites a page under it (see README.md). */
export const D = docs.lambda

/** Synchronous invocation payload, request and response: 6 MB (`gettingstarted-limits.html`). Lambda's "MB" is 1,024 KB. */
export const SYNC_PAYLOAD = 6 * 1024 * 1024
/** Asynchronous invocation payload: 1 MB (`gettingstarted-limits.html`). */
export const ASYNC_PAYLOAD = 1024 * 1024

/** Memory at which a function gets one full vCPU; CPU is proportional to memory (`configuration-memory.html`). */
export const ONE_VCPU_MB = 1769

/** Concurrency Lambda always keeps for functions without a reservation (`lambda-concurrency.html`, "Concurrency quotas"). */
export const MIN_UNRESERVED = 100

/**
 * The concurrency scaling rate: each function can add 1,000 execution environments every 10 seconds, refilled
 * continuously, never accruing more than 1,000 (`scaling-behavior.html`). A token bucket of 1,000 refilling at 100 a
 * second is exactly that.
 */
export const SCALE_UP = { rate: 100, burst: 1_000 }

/** The Init phase of an on-demand environment (and the SnapStart Restore phase) is limited to 10 s (`lambda-runtime-environment.html`). */
export const INIT_LIMIT_MS = 10_000

/** Each unit of concurrency allows 10 synchronous requests per second (`lambda-concurrency.html`, "Concurrency and requests per second"). */
export const REQUESTS_PER_CONCURRENCY = 10

/** Lambda can allocate up to 6,000 provisioned environments per function per minute (`lambda-concurrency.html`). */
export const PROVISIONED_PER_MINUTE = 6_000

/** The first retry of a throttled or failed-by-the-system asynchronous event comes after 1 s (`invocation-async-error-handling.html`). */
export const THROTTLE_RETRY_FIRST_MS = 1_000
/** The retry interval of a throttled asynchronous event grows exponentially to at most 5 minutes (`invocation-async-error-handling.html`). */
export const THROTTLE_RETRY_MAX_MS = 5 * 60_000
