import { Schema } from "effect"
import type * as Edge from "../../Edge.ts"
import type { CallFailure } from "../../Message.ts"
import * as Setting from "../../Setting.ts"
import {
  D,
  DISTRIBUTED_MAP_CONCURRENCY,
  ERRORS,
  INLINE_MAP_CONCURRENCY,
  MAX_DELAY_LIMIT_MS,
  QUOTAS,
  RETRY_FIELD_MAX,
  STANDARD_MAX_DURATION_MS,
  STATES_LANGUAGE
} from "./limits.ts"

/**
 * The error names a retrier or catcher can match (`ErrorEquals`), as the simulator's five failures map onto them:
 *
 *  - a throttle (429) is `Lambda.TooManyRequestsException`, `DynamoDB.ProvisionedThroughputExceededException` and the like;
 *  - an outage (503) is a service error: `Lambda.ServiceException`, `Lambda.AWSLambdaException`, `Lambda.SdkClientException`;
 *  - a function error (500) is the task's own error: `Lambda.Unknown`, `Sandbox.Timedout` (the function's own timeout),
 *    or an error name the code throws;
 *  - a refusal (4xx) is a client error such as `Lambda.InvalidRequestContentException`;
 *  - the edge's timeout is the task's `TimeoutSeconds` running out: `States.Timeout`.
 *
 * `States.ALL` matches every one; `States.TaskFailed` matches all but `States.Timeout` (`concepts-error-handling.html`).
 */
export const ERROR_MATCHES = ["States.ALL", "States.TaskFailed", "States.Timeout", "service", "throttling", "function"] as const
export type ErrorMatch = (typeof ERROR_MATCHES)[number]

const ERROR_LABELS: Record<ErrorMatch, string> = {
  "States.ALL": "States.ALL (every error)",
  "States.TaskFailed": "States.TaskFailed (all but States.Timeout)",
  "States.Timeout": "States.Timeout (TimeoutSeconds ran out)",
  service: "Service errors and throttling (Lambda.ServiceException, Lambda.TooManyRequestsException...)",
  throttling: "Throttling only (Lambda.TooManyRequestsException...)",
  function: "The task's own error (Lambda.Unknown, Sandbox.Timedout, a custom error)"
}

/** Whether a failed task's error name is one `ErrorEquals` lists. */
export const matches = (match: ErrorMatch, failure: CallFailure): boolean => {
  switch (match) {
    case "States.ALL":
      return true
    case "States.TaskFailed":
      return failure._tag !== "Timeout"
    case "States.Timeout":
      return failure._tag === "Timeout"
    case "service":
      return failure._tag === "Throttled" || failure._tag === "Unavailable"
    case "throttling":
      return failure._tag === "Throttled"
    case "function":
      return failure._tag === "Failed"
  }
}

const errorEquals = (help: string) => Setting.choice(ERROR_MATCHES, { default: "States.ALL", label: "ErrorEquals", labels: ERROR_LABELS, help })

/**
 * A state's `Retry` field, with one retrier. The defaults are the States Language's (`concepts-error-handling.html`): one
 * second before the first retry, three retries, the interval doubling, no cap, no jitter. A state with no `Retry` field
 * isn't retried at all, so it is off until switched on.
 */
const Retrier = Setting.group(
  {
    enabled: Setting.bool({
      default: false,
      help: "Give this state a Retry field. Without one, Step Functions doesn't retry a failed state: the error goes to the catcher, or fails the execution. Each retry is a state transition, throttled like one."
    }),
    errorEquals: errorEquals("Which errors this retrier retries; any other goes straight to the catcher. AWS recommends retrying Lambda's service errors and throttling on every Lambda task."),
    interval: Setting.duration({
      default: "1 second",
      min: "1 second",
      max: RETRY_FIELD_MAX * 1000,
      label: "IntervalSeconds",
      help: "Wait before the first retry.",
      limit: Setting.hard(ERRORS, "A positive whole number of seconds, at most 99,999,999.")
    }),
    maxAttempts: Setting.int({
      default: 3,
      min: 0,
      max: RETRY_FIELD_MAX,
      unit: "retries",
      label: "MaxAttempts",
      help: "Retries after the first try (so 3 means up to four tries). 0 never retries.",
      limit: Setting.hard(ERRORS)
    }),
    backoffRate: Setting.number({
      default: 2,
      min: 1,
      max: 10,
      step: 0.1,
      label: "BackoffRate",
      help: "Each wait is the one before times this.",
      limit: Setting.hard(STATES_LANGUAGE, "The States Language requires at least 1.0. The upper bound of 10 is this form's, not AWS's.")
    }),
    maxDelay: Setting.duration({
      default: 0,
      min: 0,
      max: MAX_DELAY_LIMIT_MS,
      label: "MaxDelaySeconds",
      help: "The longest a wait may grow to. 0 means no MaxDelaySeconds: the waits grow without limit.",
      limit: Setting.hard(ERRORS, "Above 0 and below 31,622,401 seconds when set.")
    }),
    jitter: Setting.choice(["NONE", "FULL"], {
      default: "NONE",
      label: "JitterStrategy",
      help: "FULL draws each wait at random between zero and its full length, so executions that failed together don't retry together. AWS's default is NONE."
    })
  },
  { label: "Retry" }
)

/** A state's `Catch` field, with one catcher whose `Next` is the first state on the `catch` port. */
const Catcher = Setting.group(
  {
    enabled: Setting.bool({
      default: false,
      help: "Give this state a Catch field: an error its retrier didn't resolve sends the execution down the fallback path (the states wired to the `catch` port) instead of failing it."
    }),
    errorEquals: errorEquals("Which errors are caught. Any other fails the execution.")
  },
  { label: "Catch" }
)

const ONE_YEAR = STANDARD_MAX_DURATION_MS

/** A Wait state in front of the state, so a workflow can pause between steps without a state of its own. */
const wait = Setting.duration({
  default: 0,
  min: 0,
  max: ONE_YEAR,
  label: "Wait before (Wait state)",
  help: "A Wait state that runs just before this one: a state transition, then a pause of this long. 0 for none. A Standard workflow can wait up to a year, an Express one five minutes (the execution's own limit).",
  limit: Setting.hard(`${D}state-wait.html`)
})

/**
 * What an edge on the `out` port is: one state of the workflow. The `out` edges run in the order they are wired, each
 * one a Task (or a Map) calling what the edge leads to.
 */
export const State = Schema.Struct({
  state: Setting.choice(["task", "map"], {
    default: "task",
    label: "State type",
    labels: { task: "Task", map: "Map: a task per item" },
    help: "Task calls what this edge leads to once with the execution's input. Map calls it once for each item of the input (the message's records), several at a time."
  }),
  parallel: Setting.bool({
    default: false,
    label: "Parallel with the state before",
    help: "This state and the one wired before it run at once, as branches of one Parallel state, which waits for all of them; the first to fail stops it. A run of states with this on are all branches of the same Parallel state."
  }),
  map: Setting.group(
    {
      mode: Setting.choice(["inline", "distributed"], {
        default: "inline",
        labels: { inline: "Inline", distributed: "Distributed" },
        help: `Inline: iterations run inside this execution, at most ${INLINE_MAP_CONCURRENCY} at once, and their events fill its history. Distributed: each item is a child workflow execution with a history of its own, up to ${DISTRIBUTED_MAP_CONCURRENCY.toLocaleString("en-US")} at once. Express workflows can't use Distributed mode; there it runs as Inline.`
      }),
      items: Setting.int({
        default: 0,
        min: 0,
        max: 1_000_000,
        unit: "items",
        label: "Items",
        help: "How many items the Map iterates over (the array its ItemsPath selects). 0 takes the input's records: a batch from a queue is many, a client's request is one. Simulated inputs carry no arrays, so set a number to stand for the one in the input. The upper bound is this form's."
      }),
      maxConcurrency: Setting.int({
        default: 0,
        min: 0,
        max: DISTRIBUTED_MAP_CONCURRENCY,
        unit: "iterations",
        label: "MaxConcurrency",
        help: `Iterations at once. 0 places no limit of its own: Inline mode still runs at most ${INLINE_MAP_CONCURRENCY}, Distributed ${DISTRIBUTED_MAP_CONCURRENCY.toLocaleString("en-US")}. Lower it to stay inside what the task (a Lambda function's concurrency) can take.`,
        limit: Setting.hard(`${D}state-map-distributed.html`)
      }),
      childType: Setting.choice(["express", "standard"], {
        default: "express",
        labels: { express: "Express", standard: "Standard" },
        label: "Child executions",
        help: "Distributed mode only: the type of each child workflow execution (ExecutionType). Express children start at up to 1,000 a second and use no state transition quota; Standard ones at up to 100 a second, and their transitions are throttled like the parent's."
      }),
      toleratedFailure: Setting.ratio({
        default: 0,
        label: "ToleratedFailurePercentage",
        help: "Distributed mode only: the share of items that may fail before the Map Run fails. 0 fails it on the first failed item; 100% never does. Inline mode fails on the first failed iteration."
      })
    },
    { label: "Map state" }
  ),
  wait,
  retrier: Retrier,
  catcher: Catcher
})
export type StateSettings = typeof State.Type
/** An edge leaving the `out` port, as the component reads it. */
export type StateEdge = Edge.Config & StateSettings

/**
 * What an edge on the `catch` port is: one state of the fallback path a catcher sends the execution down, run in the
 * order they are wired. In a saga these are the compensating steps.
 */
export const Fallback = Schema.Struct({
  undoes: Setting.text({
    default: "",
    label: "Compensates",
    placeholder: "node id of a state, e.g. charge-card",
    help: "The state this one undoes, by the id of the node its `out` edge leads to: it runs only if the execution had reached that state when it failed (the failing state included, since it may have half happened). Empty, or an id no state of this workflow leads to, runs it whatever failed. Wire the compensations in the order they should run, usually the reverse of the states they undo."
  }),
  wait,
  retrier: Retrier
})
export type FallbackSettings = typeof Fallback.Type
export type FallbackEdge = Edge.Config & FallbackSettings

/** The state machine's own settings. */
export const Config = Schema.Struct({
  workflowType: Setting.choice(["standard", "express"], {
    default: "standard",
    label: "Type",
    labels: { standard: "Standard", express: "Express" },
    help: "Standard: exactly-once, up to a year, StartExecution answered at once, state transitions throttled by the account's quota, a 25,000-event history. Express: at-least-once (asynchronous) or at-most-once (synchronous), up to five minutes, a much higher start rate, no transition quota. A synchronous caller waits for an Express execution's result (StartSyncExecution); a Standard one is answered at once. AWS doesn't let a state machine change type."
  }),
  timeout: Setting.duration({
    default: 0,
    min: 0,
    max: ONE_YEAR,
    label: "Execution timeout (TimeoutSeconds)",
    help: "The state machine's TimeoutSeconds: an execution still running this long fails with States.Timeout. 0 for none, which leaves the type's own maximum: a year (Standard) or five minutes (Express), whichever is shorter applies.",
    limit: Setting.hard(QUOTAS, "Standard executions run for at most a year, Express ones five minutes.")
  }),
  afterCatch: Setting.choice(["fail", "succeed"], {
    default: "fail",
    label: "Fallback path ends in",
    labels: { fail: "A Fail state", succeed: "A Succeed state" },
    help: "Where the states on the catch port lead: a saga usually ends in a Fail state once it has compensated, so the execution still counts (and answers) as failed."
  }),
  startLatency: Setting.latency({
    mean: "25 millis",
    cv: 0.3,
    label: "StartExecution response time",
    help: "How long StartExecution takes to answer with the new execution's ARN (Standard, and asynchronous Express). A synchronous Express caller hears when the execution ends instead. AWS publishes no figure; an assumption."
  }),
  transitionLatency: Setting.latency({
    mean: "20 millis",
    cv: 0.5,
    label: "State transition time",
    help: "How long Step Functions takes to move into a state, on top of what the state does. AWS publishes no figure; an assumption."
  }),
  duplicateRate: Setting.ratio({
    default: 0,
    label: "Duplicate executions (asynchronous Express)",
    help: "Asynchronous Express workflows are at-least-once: an execution may run more than once. The share of them that do (each runs exactly twice here). AWS publishes no rate, so 0 by default; raise it to see what a task that isn't idempotent does. Standard (exactly-once) and synchronous Express (at-most-once) never duplicate."
  })
})
export type Settings = typeof Config.Type
