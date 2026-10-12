import { Effect, Schema } from "effect"
import * as Component from "../../Component.ts"
import * as Distribution from "../../Distribution.ts"
import * as Flow from "../../Flow.ts"
import type { Bucket } from "../../Limiter.ts"
import * as Refuse from "../../kit/Refuse.ts"
import { bodyBytes, chance } from "../../kit/Shape.ts"
import { tallies, totals } from "../../kit/Tally.ts"
import { type CallFailure, Failed } from "../../Message.ts"
import { keyOf } from "../../Provider.ts"
import * as Aws from "../provider.ts"
import { Config, Fallback, State } from "./config.ts"
import { Execution, type Outcome, Planner, type Workflow } from "./execution.ts"
import {
  D,
  DISTRIBUTED_MAP_CONCURRENCY,
  ERRORS,
  HISTORY_LIMIT,
  INLINE_MAP_CONCURRENCY,
  MAX_PAYLOAD_BYTES,
  QUOTAS
} from "./limits.ts"
import { makeRegion } from "./region.ts"
import { type Machine, TALLIES } from "./states.ts"

/** Why a synchronous Express caller hears a failure: StartSyncExecution answers with the execution's status and error. */
const syncFailure = (node: string, outcome: Outcome, failure: CallFailure | undefined): CallFailure =>
  outcome === "timedOut"
    ? Failed({ node, reason: "ExecutionTimedOut: States.Timeout" })
    : Failed({ node, reason: `ExecutionFailed: ${failure === undefined ? "the fallback path ended in a Fail state" : "reason" in failure ? `${failure._tag}: ${failure.reason}` : failure._tag}` })

/** The account's StartExecution buckets, rebuilt only when the quotas change. */
const buckets = new WeakMap<Aws.Account, { readonly standard: Bucket; readonly express: Bucket }>()
const startBuckets = (a: Aws.Account) => {
  let b = buckets.get(a)
  if (b === undefined) {
    b = {
      standard: { rate: a.sfnStartExecutionRate, burst: a.sfnStartExecutionBurst },
      express: { rate: a.sfnExpressStartRate, burst: a.sfnExpressStartBurst }
    }
    buckets.set(a, b)
  }
  return b
}

/**
 * AWS Step Functions: a state machine whose `out` edges are its states, run in the order they are wired. Each state is a
 * Task calling what its edge leads to (a Lambda function, a table, a queue, an HTTP endpoint), or a Map calling it once
 * per item of the input; states can run side by side as a Parallel state, wait first, retry with the States Language's
 * retriers, and catch an error to the fallback path on the `catch` port, which is how a saga compensates.
 *
 * Standard workflows answer StartExecution at once and are bounded by the account's StartExecution and StateTransition
 * token buckets (a throttled transition waits for a token), the open-executions quota and a 25,000-event history.
 * Express workflows start far faster, have no transition quota, stop at five minutes, and are either asynchronous
 * (at-least-once) or synchronous (StartSyncExecution: the caller waits for the result). README.md documents each
 * mechanism against AWS's pages.
 */
export const StepFunctions = Aws.component({
  type: "aws.stepfunctions",
  service: "Step Functions",
  title: "Step Functions state machine",
  description:
    "Runs a workflow: its outgoing connections are the states, called in order, in parallel or once per item, with retries, a catch path for compensations, and the Standard and Express quotas on starts and state transitions.",
  docs: QUOTAS,
  category: "messaging",
  icon: "workflow",
  accent: "#ff4f8b",
  limits: [
    { label: "Input and output", value: "256 KiB per execution, state and task", adjustable: false, source: QUOTAS },
    { label: "Execution duration", value: "1 year (Standard), 5 minutes (Express)", adjustable: false, source: QUOTAS, note: "Past it the execution fails with States.Timeout." },
    { label: "Execution history", value: `${HISTORY_LIMIT.toLocaleString("en-US")} events (Standard), unlimited (Express)`, adjustable: false, source: QUOTAS },
    { label: "State transitions", value: "token bucket per account and Region (Standard): 5,000 and 5,000/s in us-east-1, us-west-2, eu-west-1, 800 and 800/s elsewhere; Express unlimited", adjustable: true, source: QUOTAS, note: "Set in the account quotas. Throttled transitions wait." },
    { label: "StartExecution", value: "Standard 1,300 and 300/s in the large Regions, 800 and 150/s elsewhere; Express 6,000 and 6,000/s", adjustable: true, source: QUOTAS, note: "Set in the account quotas. StartSyncExecution counts against no account limit." },
    { label: "Open executions", value: "1,000,000 Standard per account and Region", adjustable: true, source: QUOTAS },
    { label: "Inline Map concurrency", value: `${INLINE_MAP_CONCURRENCY} iterations`, adjustable: false, source: `${D}state-map-inline.html` },
    { label: "Distributed Map concurrency", value: `${DISTRIBUTED_MAP_CONCURRENCY.toLocaleString("en-US")} child executions, started at up to 1,000/s (Express) or 100/s (Standard)`, adjustable: false, source: QUOTAS, note: "Standard workflows only." },
    { label: "Retriers", value: "IntervalSeconds 1, MaxAttempts 3, BackoffRate 2.0, no MaxDelaySeconds, JitterStrategy NONE by default", adjustable: false, source: ERRORS }
  ],
  highlights: [
    { gauge: "running", label: "running" },
    { rate: "transitions", label: "transitions/s" },
    { rate: "failed", label: "failed/s" }
  ],
  config: Config,
  ports: {
    out: Component.port.many("States", State),
    catch: Component.port.many("Catch (fallback path)", Fallback)
  },
  state: Schema.Struct({
    /** Executions of this state machine running now. */
    running: Schema.Number,
    /** Of this state machine's state transitions, those waiting for a StateTransition token now. */
    waitingForTransition: Schema.Number,
    /** Standard executions open in this account and Region, every state machine's together. */
    openInRegion: Schema.Number,
    started: Schema.Number,
    succeeded: Schema.Number,
    failed: Schema.Number,
    timedOut: Schema.Number,
    throttled: Schema.Number,
    transitions: Schema.Number,
    transitionsThrottled: Schema.Number,
    retries: Schema.Number,
    caught: Schema.Number,
    compensations: Schema.Number,
    duplicates: Schema.Number,
    historyExceeded: Schema.Number,
    iterations: Schema.Number,
    childExecutions: Schema.Number
  }),
  make: (node) =>
    Effect.gen(function*() {
      const { fast } = node
      const placement = keyOf(node.placement)
      const account = (): Aws.Account => fast.account() as Aws.Account
      const region = yield* node.shared("stepfunctions", Effect.sync(() => makeRegion(node.limiter, placement, account, fast.after)))
      const machine: Machine = { id: node.id, fast, region, tally: tallies(node.meter, TALLIES), waiting: 0 }
      const workflow: Workflow = {
        machine,
        planner: new Planner(node.out("out")),
        fallbacks: node.out("catch"),
        executionTime: node.meter.sampler("executionTime"),
        running: 0
      }
      const { tally } = machine
      const standardKey = `${placement}/sfn.start.standard`
      const expressKey = `${placement}/sfn.start.express`

      node.meter.gaugeUnsafe("running", () => workflow.running)
      node.meter.gaugeUnsafe("waitingForTransition", () => machine.waiting)

      const refuse = (reason: string) => {
        tally.throttled.add(1)
        return Refuse.throttled(node.id, reason)
      }

      return {
        call: (message) => {
          if (bodyBytes(message) > MAX_PAYLOAD_BYTES) {
            return Refuse.rejected(node.id, "400 InvalidExecutionInput: the input is over 256 KiB (States.DataLimitExceeded)")
          }
          const c = fast.settings()
          const express = c.workflowType === "express"
          const sync = express && message.invocation === "sync"
          // Admission, before anything is held: the open-executions quota, then the StartExecution bucket.
          if (!express) {
            const a = account()
            if (region.openStandard >= a.sfnOpenExecutions) return refuse("400 ExecutionLimitExceeded: the account's open Standard executions are at their quota")
            if (!node.limiter.takeUnsafe(standardKey, startBuckets(a).standard)) return refuse("400 ThrottlingException: StartExecution rate exceeded")
          } else if (!sync && !node.limiter.takeUnsafe(expressKey, startBuckets(account()).express)) {
            return refuse("400 ThrottlingException: StartExecution rate exceeded (Express)")
          }
          if (!sync) {
            // StartExecution answers with the execution's ARN at once; the execution runs on its own.
            new Execution(workflow, message, !express, undefined).start()
            // An asynchronous Express execution is at-least-once: now and then it runs twice.
            if (express && chance(fast.random, c.duplicateRate)) {
              tally.duplicates.add(1)
              new Execution(workflow, message, false, undefined).start()
            }
            return Flow.wait(fast, Distribution.latencyMs(c.startLatency, fast.random))
          }
          // StartSyncExecution: the caller waits for the result. If it hangs up, the execution runs on, unheard.
          return Effect.callback<void, CallFailure>((resume) => {
            let listening = true
            new Execution(workflow, message, false, (outcome, failure) => {
              if (listening) resume(outcome === "succeeded" ? Effect.void : Effect.fail(syncFailure(node.id, outcome, failure)))
            }).start()
            return Effect.sync(() => {
              listening = false
            })
          })
        },
        probe: Effect.sync(() => ({
          running: workflow.running,
          waitingForTransition: machine.waiting,
          openInRegion: region.openStandard,
          ...totals(tally)
        }))
      }
    })
})
