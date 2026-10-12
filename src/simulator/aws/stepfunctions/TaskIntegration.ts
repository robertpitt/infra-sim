import { Duration, Effect, Schema } from "effect"
import * as Connector from "../../Connector.ts"
import * as Edge from "../../Edge.ts"
import type { Message } from "../../Message.ts"
import * as Setting from "../../Setting.ts"
import { docs } from "../docs.ts"
import { taskDashboard } from "./dashboard.ts"
import { DEFAULT_TASK_TIMEOUT_MS, RETRY_FIELD_MAX } from "./limits.ts"

/**
 * What a Task state's call is: one try, waited for up to `TimeoutSeconds`. Retries are not here, because Step Functions
 * makes them itself: they are state transitions (throttled, and in the history), matched by error name, with its own
 * backoff. So the edge has the state's `Retry` and `Catch` (the port's settings) and no plain-link retry policy to be
 * confused with them.
 */
export const Integration = Schema.Struct({
  timeout: Setting.duration({
    default: DEFAULT_TASK_TIMEOUT_MS,
    min: "1 second",
    max: RETRY_FIELD_MAX * 1000,
    label: "Task timeout (TimeoutSeconds)",
    help: "A task still running this long fails with States.Timeout (which a retrier or catcher can match). AWS's default is 99,999,999 seconds, about three years, so a task with no timeout waits for as long as its resource takes. Step Functions stops waiting; the work it started (a Lambda invocation) carries on.",
    limit: Setting.hard(`${docs.stepfunctions}state-task.html`, "A positive whole number of seconds; the default is 99,999,999.")
  }),
  request: Edge.Policy.fields.request
})
export type IntegrationSettings = typeof Integration.Type

const policies = new WeakMap<IntegrationSettings, Edge.CallPolicy>()
/** One try, abandoned (not cancelled) at the timeout. Memoised on the settings, which change only when edited. */
const policyOf = (c: IntegrationSettings): Edge.CallPolicy => {
  let p = policies.get(c)
  if (p === undefined) policies.set(c, (p = Edge.within(Duration.toMillis(c.timeout))))
  return p
}

/** The call does what the edge says to its resource (a DynamoDB GetItem reads), and carries what the edge says. */
const shape = (m: Message, c: IntegrationSettings): Message => {
  const operation = c.request.operation === "caller" ? m.operation : c.request.operation
  return operation === m.operation && c.request.payload === 0
    ? m
    : { ...m, operation, ...(c.request.payload > 0 ? { bytes: c.request.payload * 1024 } : {}) }
}

/**
 * The connector on every edge a state machine calls through: its Task states' service integrations (Lambda `invoke`,
 * DynamoDB, SQS, SNS, an HTTP Task...). The state machine decides when to call and what to do with the answer; this is
 * the call.
 */
export const TaskIntegration = Connector.make({
  type: "aws.stepfunctions.task",
  provider: "aws",
  title: "Task integration",
  description: "A Task state calling its resource: one try per attempt, waited for up to the task's TimeoutSeconds. The state's Retry and Catch are settings on the same edge.",
  icon: "workflow",
  docs: `${docs.stepfunctions}state-task.html`,
  from: { protocol: "invoke", component: "aws.stepfunctions" },
  to: { protocol: "invoke" },
  dashboard: taskDashboard,
  config: Integration,
  make: (ctx) =>
    Effect.sync(() => ({
      send: (message, done) => {
        const c = ctx.fast.settings()
        return ctx.sink.call(shape(message, c), policyOf(c), done)
      }
    }))
})
