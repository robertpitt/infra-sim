# Step Functions (`aws.stepfunctions`)

AWS Step Functions runs workflows: state machines whose states call other services (a Lambda function, a DynamoDB table,
a queue, an HTTP API), wait, run branches side by side, iterate over items, retry what fails and catch what can't be
retried. What matters for an architecture is less the workflow's logic than the machinery around it: the choice between
**Standard** and **Express** workflows, which decides how executions start, how long they may run, whether they can run
twice and which quotas bound them; the account's token buckets on starting executions and on state transitions, which slow
a busy Region's workflows down; retries that multiply the load on a struggling service; and catchers that run compensating
steps when a step of a distributed transaction fails (the saga pattern). This component lets you see those play out.

A state machine's **states are its outgoing connections**: each edge on the `out` port is one state, run in the order the
edges are wired, and calls what the edge leads to. The state's settings (Task or Map, Parallel with the state before, a
Wait before it, its `Retry` and `Catch`) live on the edge. The fallback path a catcher leads to is the edges on the
`catch` port. There are no Choice or Pass states: a workflow is a sequence, which is what most service orchestration is.

The code is split by mechanism:

| File | What it holds |
| --- | --- |
| `StepFunctions.ts` | The component: ports, state schema, admission (StartExecution and StartSyncExecution) |
| `config.ts` | The settings: the state machine's, a state's (the `out` port), a fallback state's (the `catch` port), error matching |
| `execution.ts` | One execution: the plan from the edges, the steps, the fallback path, timeouts, the end |
| `states.ts` | The states: state transitions (`Entry`), Task with its retrier, Wait, Parallel |
| `map.ts` | The Map state, Inline and Distributed, and its child executions |
| `region.ts` | What a Region's state machines share: the StateTransition token bucket's line, open Standard executions |
| `TaskIntegration.ts` | The connector on every edge a state machine calls through: one try per attempt, the task's `TimeoutSeconds` |
| `limits.ts` | Named constants with their sources |
| `quotas.ts`, `audit.ts` | The account-level quotas, and checks of a design |

## Standard versus Express

The type is the first decision, and AWS doesn't let a state machine change it. In this simulator:

| | Standard | Express |
| --- | --- | --- |
| Caller | Answered at once (StartExecution returns the execution's ARN); the workflow runs on its own | Asynchronous: answered at once. Synchronous (StartSyncExecution, any `sync` caller such as API Gateway or a client): waits for the result, and hears a failure if the execution fails or times out |
| Execution semantics | Exactly-once | Asynchronous at-least-once (some executions run twice: `duplicateRate`); synchronous at-most-once |
| Maximum duration | 1 year | 5 minutes |
| Start rate | StartExecution bucket: 1,300 and 300/s in us-east-1, us-west-2, eu-west-1; 800 and 150/s elsewhere | StartExecution bucket 6,000 and 6,000/s everywhere; StartSyncExecution counts against no account limit |
| State transitions | StateTransition bucket: 5,000 and 5,000/s in the large Regions, 800 and 800/s elsewhere; a throttled transition **waits** | No limit |
| Open executions | 1,000,000 per account and Region; past it, `ExecutionLimitExceeded` | No limit |
| Execution history | 25,000 events; past it the execution fails | No limit (nothing is kept) |
| Distributed Map | Yes | No: a Distributed Map runs as Inline |

The usual advice follows from the table: a Standard workflow for long-running, non-idempotent work (payments, orders)
where exactly-once matters, an Express workflow for short, high-volume, idempotent work, and a synchronous Express workflow
behind an API.

## Coverage

| Feature | Status | Notes |
| --- | --- | --- |
| **Workflows** | | |
| Task states calling any component | ✅ | Each `out` edge is a state; its call goes through the `aws.stepfunctions.task` connector (one try, `TimeoutSeconds`). The task is called synchronously (`lambda:invoke`'s RequestResponse) with the execution's input. |
| States run in order | ✅ | Edge order (the order in the design file). |
| Parallel state | ✅ | Consecutive states marked `parallel` (with the one before) are one Parallel state. It waits for all branches; the first to fail stops the others (their Lambda invocations run on) and fails it. |
| Map state, Inline | ✅ | The task once per item, at most 40 at once (`MaxConcurrency` lower); iterations' events fill the execution's history; the first failed iteration fails the state. |
| Map state, Distributed | 🟡 | Child executions with histories of their own, up to 10,000 at once, started at 1,000/s (Express children) or 100/s (Standard), `ToleratedFailurePercentage`. Not modelled: item readers (S3), item batching, result writers, the 1,000 open Map Runs quota, child executions counting against the open-executions quota. |
| Map items | ✅ | The input's records (a batch from a queue), or a fixed number standing for the input's array (`map.items`). |
| Wait states | ✅ | Per state (`wait`): a transition, then the pause. |
| Choice, Pass, Succeed and Fail states in the middle of a workflow | ❌ | A workflow is a sequence; a design with branches is drawn as two state machines. The fallback path ends in a Fail or Succeed state (`afterCatch`). |
| Nested workflows (a state machine calling another) | 🟡 | Wire one `aws.stepfunctions` to another: the inner one is started like any task (a Standard one answers at once, as `StartExecution` does; `.sync` waiting for it is not modelled). |
| **Error handling** | | |
| Retry: `ErrorEquals`, `IntervalSeconds`, `MaxAttempts`, `BackoffRate`, `MaxDelaySeconds`, `JitterStrategy` | ✅ | One retrier per state, with the States Language's defaults (1 s, 3, 2.0, no cap, NONE). Each retry is a state transition. |
| Several retriers per state, each counting its own attempts | ❌ | One retrier; its error match is a choice of the common sets (below). |
| Catch to a fallback path | ✅ | `catcher` on a state; the `catch` port's edges run in order. A compensation names the state it undoes (`undoes`) and runs only if the execution reached it. |
| Error names | 🟡 | The simulator's five failures map onto `States.ALL`, `States.TaskFailed`, `States.Timeout`, Lambda's service errors and throttling, and the task's own error. Custom error names, `States.HeartbeatTimeout`, `States.DataLimitExceeded` on outputs, `States.Runtime` are not modelled. |
| Task `TimeoutSeconds` | ✅ | On the edge (default 99,999,999 s). The task fails with `States.Timeout`; its resource keeps working. |
| `HeartbeatSeconds`, callbacks (`.waitForTaskToken`), `.sync` jobs, activities | ❌ | No task tokens or workers. |
| **Executions** | | |
| Standard: StartExecution answered at once | ✅ | After an assumed response time (`startLatency`). |
| Express: synchronous and asynchronous | ✅ | From the caller's `invocation`. |
| At-least-once asynchronous Express | ✅ | `duplicateRate` (assumed; AWS publishes no rate). |
| Execution timeout (1 year, 5 minutes, the state machine's `TimeoutSeconds`) | ✅ | `States.Timeout`; counted as `timedOut`. A synchronous caller hears `Failed`. |
| Input size (256 KiB) | ✅ | `Rejected` above it. Outputs between states aren't sized. |
| Execution history quota (25,000 events, Standard) | ✅ | Events counted per state (assumed counts, see Assumptions); an execution that would pass it fails (`historyExceeded`). |
| Idempotent StartExecution by name, redrive, StopExecution, versions and aliases | ❌ | Messages carry no execution names; nothing stops an execution from outside. |
| **Quotas and throttling** | | |
| StartExecution token buckets (Standard, Express), per account and Region | ✅ | Regional defaults; `Throttled` (`ThrottlingException`) past them. |
| StartSyncExecution unthrottled | 🟡 | AWS says capacity is on demand but "surges in workload may be throttled until capacity is available", with no figure: never throttled here. |
| StateTransition token bucket (Standard) | ✅ | Regional defaults. A transition with no token waits in a first-come line (CloudWatch's `ExecutionThrottled`); executions slow down rather than fail. |
| Open Standard executions (1,000,000) | ✅ | `Throttled` (`ExecutionLimitExceeded`) past it. |
| Reduced quotas of new accounts | 🟡 | AWS raises them automatically with usage and publishes no figures: set the account quotas lower by hand. |
| HTTP Task bucket (300 and 300/s), 60 s HTTP Task timeout | ❌ | A task calling an HTTP endpoint is an ordinary task here. |
| Other API quotas (DescribeExecution, SendTaskSuccess...) | ❌ | Nothing calls those APIs. |
| **Placement** | | |
| Regional, inside a Region box | ✅ | Not in a VPC: Step Functions runs outside customers' VPCs. |

## Settings

The state machine's own:

| Setting | Default | Range | Kind | Models |
| --- | --- | --- | --- | --- |
| `workflowType` | `standard` | `standard`, `express` | — | The type (see above). |
| `timeout` | 0 (none) | 0 to 1 year | hard | The state machine's `TimeoutSeconds`; the type's maximum applies whatever it says. |
| `afterCatch` | `fail` | `fail`, `succeed` | — | The state the fallback path ends in. |
| `startLatency` | 25 ms, cv 0.3 | | assumed | StartExecution's response time. |
| `transitionLatency` | 20 ms, cv 0.5 | | assumed | Time to move into a state, on top of the state's own work. |
| `duplicateRate` | 0 | 0 to 100% | assumed | Asynchronous Express executions that run twice. |

A state (an edge on the `out` port):

| Setting | Default | Range | Kind | Models |
| --- | --- | --- | --- | --- |
| `state` | `task` | `task`, `map` | — | Task, or Map over the items. |
| `parallel` | off | | — | A branch of one Parallel state with the state before. |
| `map.mode` | `inline` | `inline`, `distributed` | — | The Map's processing mode. |
| `map.items` | 0 (the input's records) | 0 to 1,000,000 | — | Items in the array the Map iterates over. The upper bound is the form's. |
| `map.maxConcurrency` | 0 (no limit of its own) | 0 to 10,000 | hard | `MaxConcurrency`. Inline never runs more than 40, Distributed 10,000. |
| `map.childType` | `express` | `express`, `standard` | — | A Distributed Map's `ExecutionType`. |
| `map.toleratedFailure` | 0 | 0 to 100% | — | `ToleratedFailurePercentage` (Distributed). |
| `wait` | 0 (none) | 0 to 1 year | hard | A Wait state before this one. |
| `retrier.enabled` | off | | — | A `Retry` field. |
| `retrier.errorEquals` | `States.ALL` | see below | — | Which errors it retries. |
| `retrier.interval` | 1 s | 1 s to 99,999,999 s | hard | `IntervalSeconds`. |
| `retrier.maxAttempts` | 3 | 0 to 99,999,999 | hard | `MaxAttempts` (retries; 0 never retries). |
| `retrier.backoffRate` | 2.0 | 1.0 to 10 | hard (min) | `BackoffRate`. The upper bound is the form's. |
| `retrier.maxDelay` | 0 (none) | 0 to 31,622,400 s | hard | `MaxDelaySeconds`. |
| `retrier.jitter` | `NONE` | `NONE`, `FULL` | — | `JitterStrategy`. |
| `catcher.enabled` | off | | — | A `Catch` field leading to the fallback path. |
| `catcher.errorEquals` | `States.ALL` | see below | — | Which errors it catches. |
| `timeout` | 99,999,999 s | 1 s to 99,999,999 s | hard | The task's `TimeoutSeconds` (the connector's). |
| `request` | write, as sent | | — | What the call does to its resource (a DynamoDB `GetItem` is a read) and carries. |

A fallback state (an edge on the `catch` port) has `undoes`, `wait`, `retrier`, `timeout` and `request`.

`errorEquals` is one of: `States.ALL` (every error); `States.TaskFailed` (every error but `States.Timeout`);
`States.Timeout` (the task's `TimeoutSeconds` ran out); `service` (throttles and service errors: what AWS's best practice
retries on every Lambda task, `Lambda.ServiceException`, `Lambda.AWSLambdaException`, `Lambda.SdkClientException`,
`Lambda.TooManyRequestsException`); `throttling` (429s only); `function` (the task's own error: `Lambda.Unknown`,
`Sandbox.Timedout`, a custom error). The simulator's failures map as `Throttled` → throttling, `Unavailable` → service
error, `Failed` → the task's own error, `Rejected` → a client error (matched by `States.ALL` and `States.TaskFailed`
only), `Timeout` (the edge's) → `States.Timeout`.

The account quotas, per Region (`quotas.ts`): `sfnStartExecutionBurst`, `sfnStartExecutionRate`,
`sfnStateTransitionBurst`, `sfnStateTransitionRate`, `sfnExpressStartBurst`, `sfnExpressStartRate`, `sfnOpenExecutions`.

## Limits

| Limit | Value | Kind | Source |
| --- | --- | --- | --- |
| Input or output of a task, state or execution | 256 KiB | hard | [service-quotas](https://docs.aws.amazon.com/step-functions/latest/dg/service-quotas.html) |
| Maximum execution time | 1 year (Standard), 5 minutes (Express) | hard | [service-quotas](https://docs.aws.amazon.com/step-functions/latest/dg/service-quotas.html) |
| Execution history | 25,000 events (Standard), unlimited (Express) | hard | [service-quotas](https://docs.aws.amazon.com/step-functions/latest/dg/service-quotas.html), [best practices](https://docs.aws.amazon.com/step-functions/latest/dg/sfn-best-practices.html) |
| StartExecution, Standard | bucket 1,300, refill 300/s (us-east-1, us-west-2, eu-west-1); 800, 150/s elsewhere | quota | [service-quotas](https://docs.aws.amazon.com/step-functions/latest/dg/service-quotas.html) |
| StartExecution, Express | bucket 6,000, refill 6,000/s, every Region | quota | [service-quotas](https://docs.aws.amazon.com/step-functions/latest/dg/service-quotas.html) |
| StartSyncExecution | no account limit; surges may be throttled (no figure) | — | [service-quotas](https://docs.aws.amazon.com/step-functions/latest/dg/service-quotas.html), [choosing-workflow-type](https://docs.aws.amazon.com/step-functions/latest/dg/choosing-workflow-type.html) |
| StateTransition, Standard | bucket 5,000, refill 5,000/s (large Regions); 800, 800/s elsewhere | quota | [service-quotas](https://docs.aws.amazon.com/step-functions/latest/dg/service-quotas.html) |
| StateTransition, Express | unlimited | — | [service-quotas](https://docs.aws.amazon.com/step-functions/latest/dg/service-quotas.html) |
| Open executions (Standard) | 1,000,000 per account and Region | quota | [service-quotas](https://docs.aws.amazon.com/step-functions/latest/dg/service-quotas.html) |
| Inline Map concurrency | 40 | hard | [state-map-inline](https://docs.aws.amazon.com/step-functions/latest/dg/state-map-inline.html) |
| Distributed Map concurrency | 10,000 child executions (and the default) | hard | [state-map-distributed](https://docs.aws.amazon.com/step-functions/latest/dg/state-map-distributed.html), [service-quotas](https://docs.aws.amazon.com/step-functions/latest/dg/service-quotas.html) |
| Distributed Map dispatch | 1,000/s Express children, 100/s Standard | hard | [service-quotas](https://docs.aws.amazon.com/step-functions/latest/dg/service-quotas.html) |
| Retrier defaults | `IntervalSeconds` 1, `MaxAttempts` 3, `BackoffRate` 2.0, no `MaxDelaySeconds`, `JitterStrategy` NONE | hard | [error handling](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html) |
| `BackoffRate` minimum | 1.0 | hard | [States Language specification](https://states-language.net/spec.html) |
| `IntervalSeconds`, `MaxAttempts` maximum | 99,999,999 | hard | [error handling](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html) |
| `MaxDelaySeconds` | above 0, below 31,622,401 | hard | [error handling](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html) |
| Task `TimeoutSeconds` default | 99,999,999 s | hard | [state-task](https://docs.aws.amazon.com/step-functions/latest/dg/state-task.html) |
| Wait state | up to 1 year (Standard), 5 minutes (Express) | hard | [state-wait](https://docs.aws.amazon.com/step-functions/latest/dg/state-wait.html) |
| Express: no Distributed Map, `.sync` or `.waitForTaskToken` | | hard | [choosing-workflow-type](https://docs.aws.amazon.com/step-functions/latest/dg/choosing-workflow-type.html), [state-map-distributed](https://docs.aws.amazon.com/step-functions/latest/dg/state-map-distributed.html) |

## Behaviour

**An execution.** On a call, the state machine admits the execution (input size, then for Standard the open-executions
quota and the StartExecution bucket, for asynchronous Express the Express bucket), then runs the plan: the `out` edges in
order, consecutive `parallel` edges grouped into one Parallel state. Each state is entered by a **state transition**:
one token from the Region's StateTransition bucket (Standard only), then the assumed transition time, then the state's
history events. A Task calls its edge once per attempt; a Map calls it once per item. When the last state succeeds, so
does the execution. A Standard or asynchronous Express caller has its answer after `startLatency`; a synchronous Express
caller has it when the execution ends.

**Throttled transitions wait.** AWS doesn't fail a Standard execution whose transition is throttled; it delays it
(`ExecutionThrottled` in CloudWatch). Here a transition that finds the bucket empty joins a first-come line for the Region,
served as tokens refill. Under a sustained excess the line grows without bound and every execution slows down. New
executions' first transitions queue alongside the running executions' later ones, so completions fall below
`quota / transitions per execution`: with a line, a workflow of k transitions served at R/s while executions arrive at λ/s
completes λr^k a second, where r + r² + … + r^k = R/λ. For three transitions, λ = 50 and R = 100, that is 26.6 a second,
not 33 (a test checks it). The fix is the quota, or fewer states: combine steps into one Lambda function, or use Express.

**Retries.** A retrier's wait before retry n (from 0) is `IntervalSeconds × BackoffRate^n`, capped at `MaxDelaySeconds`,
and with `FULL` jitter drawn uniformly between 0 and that. `MaxAttempts` counts retries, so the default 3 makes four tries.
Each retry is a state transition (AWS: "Retries are treated as state transitions"), so retries cost quota and history.
The edge's own plain-link retry policy doesn't exist on these edges (their connector is `aws.stepfunctions.task`), so
nothing retries behind the state's back. Inside a Map the edge's retrier is the item task's `Retry`; AWS's `Retry` on the
Map state itself would run every item again, which is not modelled.

**Catch and the saga pattern.** A state that fails for good (its retrier gave up, or didn't match) is caught if its catcher
matches the error, and the execution goes down the fallback path: the `catch` edges in order, each a task with its own
retrier. A compensation with `undoes: <node id>` runs only if the execution had reached that state (the failing state
included, since it may have half happened); one without, or naming a node no state leads to, runs whatever failed. The path ends in a Fail state (the
execution is `failed`, and a synchronous caller hears it) or a Succeed state. A compensation that fails for good fails the
execution where it stands. Compensations are therefore wired in reverse order of what they undo, and should retry
generously: a saga that can't compensate leaves the system inconsistent.

**Map.** Inline: `min(MaxConcurrency or 40, 40)` iterations at once, each `MapIterationStarted`/`Succeeded` plus its task's
events in the execution's history, so a Standard Inline Map of about 3,570 items reaches the 25,000-event quota. The first
failed iteration fails the state and abandons the others. Distributed (Standard only): `min(MaxConcurrency or 10,000,
10,000)` child executions at once, the k-th started no sooner than `k / 1,000` s (Express children) or `k / 100` s
(Standard) after the Map Run began; Standard children's transitions take the Region's tokens, Express children's don't;
the Map Run fails when more than `ToleratedFailurePercentage × items` items have failed.

**Timeouts.** An execution past `min(timeout, type maximum)` ends `timedOut` (`States.Timeout`): its state in progress is
abandoned, and tasks already called carry on, as Lambda invocations do. A task past its `TimeoutSeconds` fails with
`States.Timeout`, which a retrier or catcher can match.

**What the caller sees.** Standard: success once admitted (or `Throttled`, `Rejected`). Asynchronous Express: the same.
Synchronous Express: success, or `Failed` with the execution's error (`ExecutionFailed: ...`, `ExecutionTimedOut`). AWS's
StartSyncExecution answers HTTP 200 with a `FAILED` status; the simulator makes it a failure so that a caller (API Gateway)
can count it. A caller that gives up doesn't stop the execution.

## Connections

- **In**: any caller. `message.invocation` decides StartExecution (async) or StartSyncExecution (sync, Express only; a
  Standard state machine treats a sync call as StartExecution, as AWS has no synchronous Standard start). A batch from a
  queue's poller is one execution whose records are a Map's items (EventBridge Pipes or Lambda in between, in reality).
- **`out`** (many): the states, in order. Settings above. The connector is `aws.stepfunctions.task`: it adds the task's
  `TimeoutSeconds` and the request shape, and transport's latency.
- **`catch`** (many): the fallback path, in order.
- The CloudFormation importer doesn't map `AWS::StepFunctions::StateMachine` yet.

## Metrics and state

Rates (per second; totals in the probe): `started` (`ExecutionsStarted`; duplicates included), `succeeded`, `failed`,
`timedOut`, `throttled` (StartExecution refused: the bucket or the open-executions quota), `transitions` (states entered and
retries), `transitionsThrottled` (`ExecutionThrottled`: transitions that had to wait), `retries`, `caught` (executions sent
down the fallback path), `compensations` (fallback states run), `duplicates`, `historyExceeded` (executions failed at the
history quota), `iterations` (Map items started), `childExecutions` (Distributed Map children).

Gauges: `running` (this state machine's open executions), `waitingForTransition` (its transitions in the line now),
`openExecutions` (OpenExecutionCount: Standard executions open in the account and Region), `transitionRefillRate` (the
StateTransition bucket's ProvisionedRefillRate).
Distribution: `executionTime` (`ExecutionTime`, ms, from start to end, for every outcome).

The node's dashboard (`dashboard.ts`) charts these under CloudWatch's names; a Task edge's (`aws.stepfunctions.task`)
breaks its calls down by the error a retrier matches (`fail.Timeout` is ServiceIntegrationsTimedOut). Not charted, because
not modelled: ExecutionsAborted and the redrive metrics, activities, Express billing metrics, the StateTransition bucket's
level (ConsumedCapacity against ProvisionedBucketSize), and the API throttling metrics for anything but StartExecution.

Probe state: the gauges, `openInRegion` (Standard executions open in the account and Region, every state machine's), and
every total above.

## Not yet simulated

1. **Choice states and branching.** Most real workflows branch on data. Messages carry no data to branch on; a Choice
   could be a share (as SNS filters are), with an edge setting naming the branch. It needs a graph of states rather than a
   sequence, so a different shape of settings.
2. **`.sync` and `.waitForTaskToken`.** Standard workflows waiting on a job or a callback (a nested Standard workflow, an
   ECS task, a human approval). Needs a task that waits for a reply from elsewhere and `HeartbeatSeconds`.
3. **Several retriers and catchers per state**, each with its own `ErrorEquals` and attempt count, and custom error names.
   Messages would need an error name, not just a failure tag.
4. **Distributed Map details**: the 1,000 open Map Runs quota (backlogged Map Runs wait), S3 item readers and batching,
   children counted against the open-executions quota, `Retry` on the Map state rerunning every item.
5. **StartSyncExecution throttling** during surges (AWS gives no figure), and the console's 60 s StartSyncExecution limit.
6. **HTTP Task** quota (300 and 300/s) and its 60 s timeout.
7. **Payload growth between states**: outputs aren't sized, so `States.DataLimitExceeded` from a large result can't happen.
8. **Execution names and idempotent StartExecution**; redrive of failed executions; StopExecution.
9. **Pricing**: Standard per transition, Express per request and GB-second.
10. **Design checks on edges**: a Distributed Map in an Express workflow, a compensation naming no state, two retry
    policies on one edge. Audits only see nodes today.

## Assumptions

- **State transition time** (`transitionLatency`, 20 ms, cv 0.5): AWS publishes no per-transition latency.
- **StartExecution response time** (`startLatency`, 25 ms, cv 0.3): not published.
- **Duplicate rate of asynchronous Express executions** (`duplicateRate`, 0): AWS says executions "could potentially run
  more than once", with no rate. A duplicate runs the whole execution again.
- **History events per state** (`limits.ts`, `EVENTS`): read off the event types in the API reference (`HistoryEvent`):
  execution 1 + 1 at the end, Task 2 + 3 per attempt, Wait 2, Parallel 4, Map 4, Inline iteration 2, Distributed Map 6, Fail
  1, Succeed 2.
- **One year** is 365 days.
- **Order of throttled transitions**: first come, first served. AWS doesn't say.
- **A synchronous Express failure is a `Failed` call**, though AWS answers 200 with a status.
- **The task call is synchronous** (`lambda:invoke` with its default `RequestResponse`).

## References

- [Step Functions service quotas](https://docs.aws.amazon.com/step-functions/latest/dg/service-quotas.html)
- [Choosing workflow type](https://docs.aws.amazon.com/step-functions/latest/dg/choosing-workflow-type.html)
- [Handling errors in Step Functions workflows](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html)
- [Task state](https://docs.aws.amazon.com/step-functions/latest/dg/state-task.html)
- [Parallel state](https://docs.aws.amazon.com/step-functions/latest/dg/state-parallel.html)
- [Wait state](https://docs.aws.amazon.com/step-functions/latest/dg/state-wait.html)
- [Map state, Inline mode](https://docs.aws.amazon.com/step-functions/latest/dg/state-map-inline.html)
- [Map state, Distributed mode](https://docs.aws.amazon.com/step-functions/latest/dg/state-map-distributed.html)
- [State machine structure](https://docs.aws.amazon.com/step-functions/latest/dg/statemachine-structure.html)
- [Best practices](https://docs.aws.amazon.com/step-functions/latest/dg/sfn-best-practices.html)
- [CloudWatch metrics](https://docs.aws.amazon.com/step-functions/latest/dg/procedure-cw-metrics.html)
- [HistoryEvent (API reference)](https://docs.aws.amazon.com/step-functions/latest/apireference/API_HistoryEvent.html)
- [Amazon States Language specification](https://states-language.net/spec.html)
