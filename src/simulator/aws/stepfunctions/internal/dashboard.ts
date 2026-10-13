import { type Dashboard, dist, gauge, latencyPanel, rate, sum } from "../../../Dashboard.ts"

/**
 * A state machine's dashboard, as the Step Functions console and CloudWatch show one: executions started, succeeded,
 * failed and timed out, how long they take and how many are running, state transitions against the StateTransition
 * quota (and those it throttles: ExecutionThrottled), StartExecution throttling, and the retries, catches and Map
 * iterations inside executions. Names follow CloudWatch's
 * (https://docs.aws.amazon.com/step-functions/latest/dg/procedure-cw-metrics.html).
 */
export const dashboard: Dashboard = {
  figures: [
    { label: "Started", metric: rate("started"), unit: "perSecond", cloudwatch: "ExecutionsStarted" },
    { label: "Succeeded", metric: rate("succeeded"), unit: "perSecond", cloudwatch: "ExecutionsSucceeded" },
    { label: "Failed", metric: rate("failed"), unit: "perSecond", tone: "bad", cloudwatch: "ExecutionsFailed" },
    { label: "Running", metric: gauge("running"), unit: "count" },
    { label: "Throttled transitions", metric: rate("transitionsThrottled"), unit: "perSecond", tone: "warn", cloudwatch: "ExecutionThrottled" },
    { label: "Execution time p95", metric: dist("executionTime", "p95"), unit: "ms", cloudwatch: "ExecutionTime" }
  ],
  panels: [
    {
      id: "executions",
      title: "Executions",
      unit: "perSecond",
      cloudwatch: ["ExecutionsStarted", "ExecutionsSucceeded", "ExecutionsFailed", "ExecutionsTimedOut"],
      help: "Executions started (an asynchronous Express workflow's duplicate runs included) and how they ended.",
      lines: [
        { label: "started", metric: rate("started"), tone: "primary" },
        { label: "succeeded", metric: rate("succeeded"), tone: "ok" },
        { label: "failed", metric: rate("failed"), tone: "bad" },
        { label: "timed out", metric: rate("timedOut"), tone: "warn" }
      ]
    },
    latencyPanel("execution-time", "Execution time", "executionTime", ["ExecutionTime"]),
    {
      id: "running",
      title: "Running executions",
      unit: "count",
      cloudwatch: ["OpenExecutionCount"],
      help: "This state machine's executions in progress, and the Standard executions open in the account and Region (every state machine's), which the open-executions quota counts.",
      lines: [
        { label: "running", metric: gauge("running"), tone: "primary" },
        { label: "open in account", metric: gauge("openExecutions"), tone: "muted" }
      ]
    },
    {
      id: "transitions",
      title: "State transitions",
      unit: "perSecond",
      cloudwatch: ["ConsumedCapacity (StateTransition)", "ExecutionThrottled", "ProvisionedRefillRate (StateTransition)"],
      help: "States entered and retries, and those that had to wait for a token, against the rate the account's StateTransition bucket refills at (shared by every Standard state machine in the Region; Express workflows aren't throttled). A throttled transition waits: the execution slows down, it doesn't fail.",
      lines: [
        { label: "transitions", metric: rate("transitions"), tone: "primary" },
        { label: "throttled", metric: rate("transitionsThrottled"), tone: "bad" },
        { label: "refill rate", metric: gauge("transitionRefillRate"), tone: "muted", dashed: true }
      ]
    },
    {
      id: "waiting",
      title: "Transitions waiting",
      unit: "count",
      help: "This state machine's transitions in line for a StateTransition token right now.",
      lines: [{ label: "waiting", metric: gauge("waitingForTransition"), tone: "warn" }]
    },
    {
      id: "start-throttling",
      title: "Starts refused and duplicated",
      unit: "perSecond",
      cloudwatch: ["ThrottledEvents (StartExecution)"],
      help: "Starts refused by the StartExecution bucket or the open-executions quota, inputs over 256 KiB, and the extra runs an asynchronous Express workflow (at-least-once) makes now and then.",
      lines: [
        { label: "throttled", metric: rate("throttled"), tone: "bad" },
        { label: "input too large", metric: rate("fail.Rejected"), tone: "warn" },
        { label: "duplicates", metric: rate("duplicates"), tone: "muted" }
      ]
    },
    {
      id: "error-handling",
      title: "Retries and catches",
      unit: "perSecond",
      help: "Task retries by the states' retriers, executions sent down the fallback path by a catcher, the compensation states run on it, and executions failed at the 25,000-event history quota.",
      lines: [
        { label: "retries", metric: rate("retries"), tone: "warn" },
        { label: "caught", metric: rate("caught"), tone: "accent" },
        { label: "compensations", metric: rate("compensations"), tone: "teal" },
        { label: "history full", metric: rate("historyExceeded"), tone: "bad" }
      ]
    },
    {
      id: "map",
      title: "Map iterations",
      unit: "perSecond",
      help: "Map state items started, and the child executions a Distributed Map started for them.",
      lines: [
        { label: "iterations", metric: rate("iterations"), tone: "primary" },
        { label: "child executions", metric: rate("childExecutions"), tone: "accent" }
      ]
    }
  ]
}

/**
 * A Task state's integration, after transport's charts: how its calls ended, by the error a retrier or catcher matches
 * (States.Timeout, a throttle, a task failure), as Step Functions' service integration metrics count them.
 */
export const taskDashboard: Dashboard = {
  figures: [{ label: "Timed out", metric: rate("fail.Timeout"), unit: "perSecond", tone: "bad", cloudwatch: "ServiceIntegrationsTimedOut" }],
  panels: [
    {
      id: "outcomes",
      title: "Task outcomes",
      unit: "perSecond",
      cloudwatch: ["ServiceIntegrationsSucceeded", "ServiceIntegrationsFailed", "ServiceIntegrationsTimedOut"],
      help: "Task calls that succeeded, and those that failed by the error the state's Retry and Catch match: States.Timeout (past TimeoutSeconds), a throttle, or the resource failing or being down.",
      lines: [
        { label: "succeeded", metric: rate("ok"), tone: "ok" },
        { label: "timed out", metric: rate("fail.Timeout"), tone: "warn" },
        { label: "throttled", metric: rate("fail.Throttled"), tone: "accent" },
        { label: "failed", metric: sum(rate("fail.Failed"), rate("fail.Unavailable")), tone: "bad" }
      ]
    }
  ]
}
