import { Duration, Effect, Schema } from "effect"
import * as Connector from "../../Connector.ts"
import { shapeCall } from "../../connectors/Link.ts"
import * as Edge from "../../Edge.ts"
import * as Setting from "../../Setting.ts"
import { docs } from "../internal/docs.ts"
import { taskDashboard } from "./internal/dashboard.ts"
import { DEFAULT_TASK_TIMEOUT_MS, RETRY_FIELD_MAX } from "./internal/limits.ts"
import { memoByIdentity } from "../../internal/memo.ts"

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

/** One try, abandoned (not cancelled) at the timeout. Memoised on the settings, which change only when edited. */
const policyOf = memoByIdentity((c: IntegrationSettings): Edge.CallPolicy => Edge.within(Duration.toMillis(c.timeout)))

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
        return ctx.sink.call(shapeCall(message, c), policyOf(c), done)
      }
    }))
})
