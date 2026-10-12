# EventBridge Scheduler (`aws.scheduler`)

Amazon EventBridge Scheduler invokes a target (a Lambda function, an SQS queue, an SNS topic, an event bus, a Step
Functions state machine...) on a schedule: every so often (`rate`), at wall-clock times (`cron`), or once (`at`). It is a
source of traffic, and its most interesting behaviour is in crowds: thousands of schedules sharing a cron (a nightly job
per tenant) all come due in the same minute, and a *flexible time window* spreads them out. The component stands for any
number of schedules sharing one expression and target, so you can see that herd hit a database, see the region's
invocation quota hold the excess back, and see a 15-minute window turn it into a trickle. Failed invocations are retried
for up to a day and then dead-lettered, as on an event bus (the delivery machinery is shared with
[`../eventbridge`](../eventbridge/README.md)).

## Coverage

| Feature | Status | Notes |
| --- | --- | --- |
| **Schedules** | | |
| `rate(value unit)` | ✅ | Minutes, hours, days. A schedule with no start date starts at once; one that fell behind (disabled, or its rate shortened) goes now rather than catching up. |
| `cron(...)` | ✅ | All six fields with `,` `-` `*` `/` `?`, month and day names, `L`, `LW`, `nW` in day-of-month, `L`, `nL`, `n#k` in day-of-week. Exactly one of day-of-month and day-of-week must be `?`. Checked when the design is read. |
| `at(...)` | ✅ | Once, at that time on the clock. |
| The clock | 🟡 | `clock` is the wall time when the simulation starts (default 23:55 on a Monday, so a midnight cron fires five minutes in). Time zones are implied by it; daylight saving changes are not modelled. |
| Start and end dates | ❌ | A schedule runs for the whole simulation; `enabled` stops and starts it. |
| 60-second precision | ✅ | With the window OFF, an invocation lands in the minute it is due, spread evenly over it (where in the minute is an assumption). |
| Flexible time window | ✅ | 1 to 1,440 minutes: each invocation lands at a uniformly random moment in the window after it is due. |
| Many schedules (`schedules`) | ✅ | N schedules sharing the expression and target each get their own moment in the window; the moments are drawn in order (order statistics), one timer at a time, so a burst of a million costs no memory. |
| Schedules created at different times | ❌ | N rate schedules all start together. Schedules started at random times (a phase each) can be approximated with a flexible window as long as the rate. |
| Disabling | ✅ | A disabled schedule invokes nothing new, including the rest of a window under way; invocations already created carry on. |
| One-time schedules' cleanup (`ActionAfterCompletion`) | ❌ | |
| **Invocation** | | |
| Regional invocation quota | ✅ | One pacer per account and region, shared by every Scheduler node there: past the rate (1,000/s or 500/s) invocations wait their turn rather than failing (`InvocationThrottleCount`). The wait counts against the maximum event age. |
| Asynchronous invocation | ✅ | Invocations are `async`: a Lambda target queues them (AWS: Scheduler invokes Lambda asynchronously). |
| Input size | ✅ | `payload`, up to 256 KB (the schema refuses more). |
| Templated and universal targets | 🟡 | The target is whatever is wired; the API action and its own limits are that component's. |
| **Retries and dead letters** | | |
| Retry policy | ✅ | `maxRetries` 0 to 185 and `maxEventAge` 60 s to 24 h, default 185 and 24 h, whichever first. |
| Exponential backoff with jitter | 🟡 | Same model and defaults as the event bus (`retryBackoff`), an assumption: AWS publishes no delays. |
| Errors that are not retried | ✅ | `Rejected` (4xx) is final at once. |
| Dead-letter queue | ✅ | Wire the `dlq` port to an SQS queue: given-up invocations go there; with nothing wired they are dropped. |
| **Throttling and quotas** | | |
| Schedules per account | ✅ | Audited: the sum of `schedules` in a region against `schedulerSchedules` (10,000,000). |
| Schedule groups, control-plane API rates (`CreateSchedule`...) | ❌ | Only invocations happen in the simulation. |
| **As a source** | ✅ | Records `sent`, `ok`, `fail` and `latency` like a client, so `system.*` checks and the client alarms include it. |
| **Live edits** | ✅ | Read at least once a second: a new expression, clock, window or count takes effect at the next occurrence. |

## Settings

| Setting | Default | Range | Kind | What it models |
| --- | --- | --- | --- | --- |
| `enabled` | on | on/off | | The schedule's state. |
| `expression` | `rate(1 minute)` | `rate`, `cron`, `at` | hard syntax | `ScheduleExpression`. |
| `clock` | `2026-01-05T23:55:00` | `yyyy-mm-ddThh:mm[:ss]` | | The schedule's wall clock at the start of the simulation. |
| `schedules` | 1 | 1 to 10,000,000 | | Schedules sharing the expression and target. |
| `flexibleWindow` | 0 (OFF) | 0 to 1,440 min | hard | `FlexibleTimeWindow.MaximumWindowInMinutes`. |
| `payload` | 1 KB | 0 to 256 KB | hard | Size of the target's `Input`. |
| `retryPolicy.maxRetries` | 185 | 0 to 185 | hard | `MaximumRetryAttempts`. |
| `retryPolicy.maxEventAge` | 24 h | 60 s to 24 h | hard | `MaximumEventAgeInSeconds`, from when the invocation is created. |
| `retryBackoff.initial`, `.max` | 1 s, 16 min | 0 to 1 h, 0 to 24 h | assumed | The retry backoff (full jitter, doubling). |
| `maxPending` | 100,000 | 1 to 10,000,000 | assumed | Invocations held (delayed or retrying) before new ones are dropped as `overflow`. |

Account quotas (Region box): `schedulerInvocationRate`, `schedulerSchedules`.

## Limits

| Limit | Value | Kind | Source |
| --- | --- | --- | --- |
| Invocations per second, per account and Region | us-east-1, us-east-2, us-west-2, ap-northeast-1, ap-south-1, ap-southeast-1, ap-southeast-2, eu-central-1, eu-west-1, eu-west-2, sa-east-1 1,000; every other Region 500. "They still happen but they are delayed." | quota | https://docs.aws.amazon.com/scheduler/latest/UserGuide/scheduler-quotas.html |
| Schedules per account and Region | 10,000,000 (completed one-time schedules count) | quota | same |
| Schedule groups | 500 | quota (not modelled) | same |
| `CreateSchedule` rate | 5,000/s in the larger Regions, 250/s elsewhere | quota (not modelled) | same |
| Target `Input` | 256 KB, any target type | hard | same |
| Precision | 60 seconds: due at 1:00, invoked between 1:00:00 and 1:00:59 without a window | hard | https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html |
| Rate units | `minutes`, `hours`, `days` | hard | same |
| Cron fields | six: minutes, hours, day-of-month, month, day-of-week (1-7 or SUN-SAT), year (1970-2199); `*` not in both day fields | hard | same |
| Flexible time window | `OFF` or `FLEXIBLE` with 1 to 1,440 minutes | hard | https://docs.aws.amazon.com/scheduler/latest/APIReference/API_FlexibleTimeWindow.html |
| Retry policy ranges | `MaximumRetryAttempts` 0 to 185, `MaximumEventAgeInSeconds` 60 to 86,400 | hard | https://docs.aws.amazon.com/scheduler/latest/APIReference/API_RetryPolicy.html |
| Retry policy defaults | 185 retries, 24 hours | default | https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_scheduler_targets.ScheduleTargetBaseProps.html (the Scheduler guide gives only the maximums) |
| Dead-letter queue | a standard SQS queue (not FIFO) | hard | https://docs.aws.amazon.com/scheduler/latest/UserGuide/configuring-schedule-dlq.html |
| Lambda targets | invoked asynchronously | hard | https://docs.aws.amazon.com/lambda/latest/dg/with-eventbridge-scheduler.html |

## Behaviour

**When.** The node wakes at the expression's next occurrence, or after a second, whichever is first, and reads its
settings. `rate`: the first occurrence is at the start (or when enabled), then every period after the last. `cron`: the
first minute at or after now (and after the last occurrence) whose fields match, on the clock `clock + t`. `at`: once, if
it is still ahead.

**How many, and when exactly.** Each occurrence opens a window of `flexibleWindow` minutes, or of 60 seconds when it is
OFF, and invokes `schedules` times, each at an independent uniform moment in the window. The moments come in order: the
next of `r` remaining points in `[t, end)` is `t + (end − t)(1 − U^(1/r))`. So `N` schedules with a window of `W` make
about `N / W` invocations a second for `W`: 90,000 at midnight with the window OFF is 1,500 a second for a minute; with 15
minutes it is 100 a second.

**Quota.** Each invocation takes a token from the region's pacer (`schedulerInvocationRate`, burst one second's worth).
Past it the invocation waits its turn: 90,000 in a minute at 1,000 a second take a minute and a half, and the last one
waits about 30 seconds. An invocation whose wait would outlive `maxEventAge` is never attempted and is given up when its
age runs out.

**Retries, dead letters, a stuck target.** As on the event bus: retries with full-jitter exponential backoff until
`maxRetries` or `maxEventAge`, then the dead-letter queue or dropped; `Rejected` is not retried; at most `maxPending`
invocations are held. Note that a Lambda target accepts invocations asynchronously, so Scheduler sees success even when
the function later fails: those failures are the function's (its retries, its on-failure destination).

## Connections

A source: nothing calls it. Ports:

- `out` (Target, one): what each invocation calls, asynchronously. The edge's `timeout` is one attempt; leave its `retry`
  at 1 attempt, as the retry policy is the schedule's.
- `dlq` (Dead-letter queue, one): an SQS queue; wiring it is what gives the schedule a dead-letter queue.

CloudFormation import: not mapped yet. `importers/cloudformation/events.ts` turns an `AWS::Scheduler::Schedule` into a
constant-rate client at the expression's average rate; it could become this component, with `ScheduleExpression`,
`FlexibleTimeWindow`, `Target.RetryPolicy` and `Target.DeadLetterConfig` mapped across.

## Metrics and state

| Name | Meaning | CloudWatch |
| --- | --- | --- |
| `occurrences` | times the expression came due | none |
| `invocations` (also `sent`) | invocations created | none (per schedule) |
| `attempts` | every attempt | `InvocationAttemptCount` |
| `delivered` (also `ok`) | invocations the target accepted | none |
| `retries` | retry attempts | none |
| `failed` (also `fail`) | invocations given up | `InvocationDroppedCount` |
| `expired` | of those, given up for their age | (`EXHAUSTED_RETRY_CONDITION` = `MaximumEventAgeInSeconds`) |
| `deadLettered`, `deadLetterFailed` | moved to the DLQ, or not | `InvocationsSentToDeadLetterCount`, `InvocationsFailedToBeSentToDeadLetterCount` |
| `dropped` | given up with no DLQ: lost | none |
| `delayed` | invocations that waited for the quota | `InvocationThrottleCount` |
| `overflow` | dropped because `maxPending` was full | none (simulator bound) |
| `noTarget` | invocations with nothing wired to `out` | none |

`targetErrors` and `targetThrottled` are `TargetErrorCount` and `TargetErrorThrottledCount`: every attempt the target
answered with an error, and of those the throttled ones (the edge's `fail` and `fail.Throttled` count the same).
Distributions: `latency` (creation to success, as a client's), `startLatency` (creation to first attempt),
`successLatency`. Gauges: `pending`, `quotaWait` (ms a new invocation would wait for the regional quota),
`invocationQuota` (the region's invocation quota, shared by every schedule there).

Probe state: `next` (virtual ms of the next occurrence, −1 for none), `occurrences`, `windows` (occurrences still
invoking), `noTarget`, `pending`, the outcome totals above (not `targetErrors`, `targetThrottled`) and `quotaWait`.

The node's dashboard (`dashboard.ts`) charts these under CloudWatch's names. `InvocationsSentToDeadLetterCount_Truncated_*`
and the per-error-code `InvocationsFailedToBeSentToDeadLetterCount_<code>` aren't modelled.

## Not yet simulated

1. A design-level wall clock. Each Scheduler node has its own `clock`; one clock for the whole design (and for time-of-day
   traffic) would belong to the engine.
2. Start and end dates, time zones and daylight saving (a skipped or single run at the change).
3. Schedules created at different times: N rate schedules with independent phases (today they are aligned; a flexible
   window as long as the rate approximates them).
4. The real backoff schedule (AWS publishes none), and `Retry-After`.
5. Schedule groups and their quota, the control-plane API rates, `ActionAfterCompletion`, KMS.
6. The CloudFormation mapping (above).

## Assumptions

| Number | Value | Why |
| --- | --- | --- |
| Where in the minute or window | uniform | AWS says only "within" the minute or the window. |
| Retry backoff | full jitter, 1 s doubling to 16 min | As the event bus: 185 retries take about 24 hours. |
| Quota burst | one second's worth | AWS gives a rate only. |
| `maxPending` | 100,000 | A memory bound; AWS keeps retrying for up to 24 hours. |
| Default clock | 2026-01-05 23:55 | So a midnight cron fires in a short run. |

## References

- https://docs.aws.amazon.com/scheduler/latest/UserGuide/what-is-scheduler.html
- https://docs.aws.amazon.com/scheduler/latest/UserGuide/scheduler-quotas.html
- https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html
- https://docs.aws.amazon.com/scheduler/latest/UserGuide/managing-schedule-flexible-time-windows.html
- https://docs.aws.amazon.com/scheduler/latest/UserGuide/configuring-schedule-dlq.html
- https://docs.aws.amazon.com/scheduler/latest/UserGuide/monitoring-cloudwatch.html
- https://docs.aws.amazon.com/scheduler/latest/UserGuide/managing-targets-templated.html
- https://docs.aws.amazon.com/scheduler/latest/APIReference/API_FlexibleTimeWindow.html
- https://docs.aws.amazon.com/scheduler/latest/APIReference/API_RetryPolicy.html
- https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_scheduler_targets.ScheduleTargetBaseProps.html
- https://docs.aws.amazon.com/lambda/latest/dg/with-eventbridge-scheduler.html
