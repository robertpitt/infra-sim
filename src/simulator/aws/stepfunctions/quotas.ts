import * as Setting from "../../Setting.ts"
import { EXPRESS_START, OPEN_EXECUTIONS, QUOTAS, standardStart, stateTransitions } from "./limits.ts"

const rate = (o: { default: number; label: string; help: string; unit: string }) =>
  Setting.int({ ...o, min: 1, max: 10_000_000, limit: Setting.quota(QUOTAS, "Per account and Region. AWS may raise it at any time, and raises it on request.") })

/**
 * The account-level quotas this service contributes: Step Functions throttles StartExecution and state transitions with
 * token buckets per account and Region (`service-quotas.html`), and the large Regions (us-east-1, us-west-2, eu-west-1)
 * have bigger ones. Each bucket is two settings, its size (the burst) and its refill rate. Express workflows have their
 * own StartExecution bucket and no state transition one. They are merged into the provider's account form
 * (`../account.ts`).
 *
 * Not here: StartSyncExecution, which AWS says doesn't count against any account limit ("capacity on demand"), and the
 * reduced state transition quotas of new accounts, which AWS raises with usage (set them lower by hand to see it).
 */
export const quotas = (region: string) => {
  const start = standardStart(region)
  const transitions = stateTransitions(region)
  return {
    sfnStartExecutionBurst: rate({
      default: start.burst,
      unit: "calls",
      label: "Step Functions StartExecution bucket (Standard)",
      help: "How many Standard executions can be started at once from a full bucket. Past it, StartExecution is throttled (ThrottlingException)."
    }),
    sfnStartExecutionRate: rate({
      default: start.rate,
      unit: "calls/s",
      label: "Step Functions StartExecution refill (Standard)",
      help: "Standard executions started per second, sustained, across every state machine in this region."
    }),
    sfnStateTransitionBurst: rate({
      default: transitions.burst,
      unit: "transitions",
      label: "Step Functions state transition bucket (Standard)",
      help: "State transitions (states entered, and retries) a Standard workflow can make at once from a full bucket. Past it, executions are slowed down, not failed: each transition waits for a token (CloudWatch's ExecutionThrottled)."
    }),
    sfnStateTransitionRate: rate({
      default: transitions.rate,
      unit: "transitions/s",
      label: "Step Functions state transition refill (Standard)",
      help: "State transitions per second, sustained, across every Standard execution in this region. Express workflows have no such limit."
    }),
    sfnExpressStartBurst: rate({
      default: EXPRESS_START.burst,
      unit: "calls",
      label: "Step Functions StartExecution bucket (Express)",
      help: "Asynchronous Express executions that can be started at once from a full bucket. Synchronous ones (StartSyncExecution) don't count against it."
    }),
    sfnExpressStartRate: rate({
      default: EXPRESS_START.rate,
      unit: "calls/s",
      label: "Step Functions StartExecution refill (Express)",
      help: "Asynchronous Express executions started per second, sustained, across every Express state machine in this region."
    }),
    sfnOpenExecutions: Setting.int({
      default: OPEN_EXECUTIONS,
      min: 1,
      max: 100_000_000,
      unit: "executions",
      label: "Step Functions open executions (Standard)",
      help: "Standard executions that may be running at once in this region. Past it, StartExecution fails with ExecutionLimitExceeded. Express workflows don't count.",
      limit: Setting.quota(QUOTAS, "AWS raises it to millions on request.")
    })
  }
}
