import { docs } from "../../internal/docs.ts"

/** Base URL of the Step Functions developer guide. Every number below cites a page under it (see README.md). */
export const D = docs.stepfunctions
/** The service quotas page, where most of the numbers are. */
export const QUOTAS = `${D}service-quotas.html`
/** The States Language reference for retriers and catchers. */
export const ERRORS = `${D}concepts-error-handling.html`
/** The Amazon States Language specification, which AWS publishes; it says what the guide leaves out (BackoffRate's minimum). */
export const STATES_LANGUAGE = "https://states-language.net/spec.html"

/**
 * Maximum input or output of a task, a state or an execution: 256 KiB, for both workflow types (`service-quotas.html`,
 * "Quotas related to task executions"). A hard quota.
 */
export const MAX_PAYLOAD_BYTES = 256 * 1024

/** A Standard execution runs for at most one year, then fails with `States.Timeout` (`service-quotas.html`). Read as 365 days. */
export const STANDARD_MAX_DURATION_MS = 365 * 24 * 60 * 60 * 1000
/** An Express execution runs for at most five minutes, then fails with `States.Timeout` (`service-quotas.html`). */
export const EXPRESS_MAX_DURATION_MS = 5 * 60 * 1000

/**
 * A Standard execution's history holds at most 25,000 events. If event 25,000 isn't `ExecutionSucceeded`, the execution
 * fails (`service-quotas.html`; `sfn-best-practices.html`, "Starting new executions to avoid reaching the history quota").
 * Express workflows have no limit.
 */
export const HISTORY_LIMIT = 25_000

/** An Inline Map state runs at most 40 iterations at once (`state-map-inline.html`). */
export const INLINE_MAP_CONCURRENCY = 40
/** A Distributed Map runs at most 10,000 child workflow executions at once, and that is its default (`state-map-distributed.html`). */
export const DISTRIBUTED_MAP_CONCURRENCY = 10_000
/**
 * How fast a Distributed Map starts its child executions: Express ones at up to 1,000 a second, Standard ones at up to
 * 100 (`service-quotas.html`, "Maximum number of parallel child executions within a single Map Run").
 */
export const DISTRIBUTED_DISPATCH_PER_SECOND = { express: 1_000, standard: 100 } as const

/** A Task's `TimeoutSeconds` when none is given: 99,999,999 seconds, about three years (`state-task.html`). */
export const DEFAULT_TASK_TIMEOUT_MS = 99_999_999 * 1000
/** `IntervalSeconds` and `MaxAttempts` of a retrier go up to 99,999,999 (`concepts-error-handling.html`). */
export const RETRY_FIELD_MAX = 99_999_999
/** `MaxDelaySeconds` must be above 0 and below 31,622,401 seconds (`concepts-error-handling.html`). */
export const MAX_DELAY_LIMIT_MS = 31_622_400 * 1000

/**
 * The Regions whose default StartExecution and StateTransition buckets are the large ones: US East (N. Virginia), US West
 * (Oregon) and Europe (Ireland). Every other Region gets the smaller figures (`service-quotas.html`).
 */
export const LARGE_REGIONS: ReadonlySet<string> = new Set(["us-east-1", "us-west-2", "eu-west-1"])

/** Standard StartExecution token bucket: 1,300 refilling 300 a second in the large Regions, 800 refilling 150 elsewhere. */
export const standardStart = (region: string) => (LARGE_REGIONS.has(region) ? { burst: 1_300, rate: 300 } : { burst: 800, rate: 150 })
/** Express StartExecution token bucket: 6,000 refilling 6,000 a second, in every Region. */
export const EXPRESS_START = { burst: 6_000, rate: 6_000 }
/** Standard StateTransition token bucket: 5,000 refilling 5,000 a second in the large Regions, 800 and 800 elsewhere. Express has none. */
export const stateTransitions = (region: string) => (LARGE_REGIONS.has(region) ? { burst: 5_000, rate: 5_000 } : { burst: 800, rate: 800 })
/** Open Standard executions per account and Region: 1,000,000; past it StartExecution fails with `ExecutionLimitExceeded`. Not Express. */
export const OPEN_EXECUTIONS = 1_000_000

/**
 * History events each kind of state writes into a Standard execution's history. AWS publishes the event types
 * (`API_HistoryEvent` in the API reference) but not a count per state, so these are read off the types an ordinary run of
 * each state produces. An assumption, and close enough to see where the 25,000 quota bites.
 */
export const EVENTS = {
  /** `ExecutionStarted`; the closing `ExecutionSucceeded`, `ExecutionFailed` or `ExecutionTimedOut` is one more. */
  execution: 1,
  /** `TaskStateEntered` and `TaskStateExited`. */
  taskState: 2,
  /** One try of the task: `TaskScheduled`, `TaskStarted`, then `TaskSucceeded`, `TaskFailed` or `TaskTimedOut`. */
  taskAttempt: 3,
  /** `WaitStateEntered`, `WaitStateExited`. */
  wait: 2,
  /** `ParallelStateEntered`, `ParallelStateStarted`, `ParallelStateSucceeded`, `ParallelStateExited`. */
  parallel: 4,
  /** `MapStateEntered`, `MapStateStarted`, `MapStateSucceeded`, `MapStateExited`. */
  map: 4,
  /** `MapIterationStarted`, `MapIterationSucceeded`: an Inline Map's iterations live in the parent's history. */
  iteration: 2,
  /** The Map state's own four plus `MapRunStarted` and `MapRunSucceeded`; the children keep histories of their own. */
  distributedMap: 6,
  /** `FailStateEntered`. */
  fail: 1,
  /** `SucceedStateEntered`, `SucceedStateExited`. */
  succeed: 2
} as const
