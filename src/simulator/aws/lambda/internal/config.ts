import { Schema } from "effect"
import * as Setting from "../../../Setting.ts"
import { D } from "./limits.ts"

/**
 * A function's settings. Names are stable: saved designs, `examples/*.yaml`, the SQS component and the CloudFormation
 * importer use them. New settings default to AWS-faithful behaviour only where that leaves existing designs unchanged;
 * the others are switched off and say so.
 */
export const Config = Schema.Struct({
  memory: Setting.int({
    default: 128,
    min: 128,
    max: 10_240,
    unit: "MB",
    label: "Memory",
    help: "CPU is proportional to memory: one full vCPU at 1,769 MB.",
    limit: Setting.hard(`${D}configuration-memory.html`)
  }),
  timeout: Setting.duration({
    default: "3 seconds",
    min: "1 second",
    max: "15 minutes",
    label: "Timeout",
    help: "The invocation is killed when it runs this long, and its execution environment is discarded.",
    limit: Setting.hard(`${D}configuration-timeout.html`)
  }),
  duration: Setting.latency({ mean: "100 millis", cv: 0.5, label: "Handler duration", help: "How long the handler takes at 1,769 MB or more, excluding cold starts." }),
  cpuBound: Setting.ratio({
    default: 0.5,
    label: "CPU-bound share",
    help: "How much of the handler's time is CPU work, which slows down below 1,769 MB. The rest (waiting on I/O) doesn't. A modelling choice, not an AWS figure."
  }),
  coldStart: Setting.group(
    {
      init: Setting.latency({
        mean: "300 millis",
        cv: 0.5,
        label: "Init duration",
        help: "Creating an environment and running initialisation code. AWS says 'under 100 ms to over 1 s' and gives no model, so this is an assumption. An init that runs past the 10 s limit is retried inside the first invocation, under the function timeout."
      }),
      idleTtl: Setting.duration({
        default: "10 minutes",
        min: "1 minute",
        max: "6 hours",
        label: "Idle lifetime",
        help: "How long an unused environment stays warm. AWS doesn't publish this number; it says only 'some time'. An assumption."
      }),
      maxLifetime: Setting.duration({
        default: 0,
        min: 0,
        max: "48 hours",
        label: "Maximum lifetime",
        help: "Lambda retires environments every few hours, even busy ones, so each one is eventually replaced by a cold start. AWS publishes no number, so 0 (the default) turns this off; try a few hours. An assumption."
      }),
      snapStart: Setting.bool({
        default: false,
        label: "SnapStart",
        help: "Resume new environments from a snapshot taken when the version was published, instead of running Init. Has no effect with provisioned concurrency, which AWS doesn't support alongside it."
      }),
      restore: Setting.latency({
        mean: "200 millis",
        cv: 0.5,
        label: "Restore duration",
        help: "Resuming an environment from a snapshot (SnapStart). AWS says only 'as low as sub-second', so this is an assumption."
      })
    },
    { label: "Cold starts" }
  ),
  reserved: Setting.group(
    {
      enabled: Setting.bool({ default: false, help: "Hold back part of the regional concurrency for this function, which also caps it. 0 throttles it entirely." }),
      concurrency: Setting.int({
        default: 100,
        min: 0,
        max: 1_000_000,
        unit: "executions",
        label: "Reserved concurrency",
        limit: Setting.hard(`${D}configuration-concurrency.html`, "All reservations together can total at most the regional concurrency minus 100; the simulator warns, and clamps the shared pool, rather than refusing.")
      })
    },
    { label: "Reserved concurrency" }
  ),
  provisioned: Setting.int({
    default: 0,
    min: 0,
    max: 1_000_000,
    unit: "executions",
    label: "Provisioned concurrency",
    help: "Execution environments kept initialised, so these never cold start. Counts against the regional concurrency, and can't exceed the reservation (it is clamped to it).",
    limit: Setting.quota(`${D}provisioned-concurrency.html`)
  }),
  provisionedAllocation: Setting.duration({
    default: "90 seconds",
    min: 0,
    max: "1 hour",
    label: "Provisioned allocation delay",
    help: "When provisioned concurrency is raised while running, the new environments become ready after this long, plus the time to allocate them at 6,000 a minute. AWS says 'a minute or two of preparation', so 90 s is a midpoint assumption. A design starts with its provisioned concurrency already allocated."
  }),
  rpsLimit: Setting.bool({
    default: false,
    label: "Enforce requests-per-second limit",
    help: "AWS allows 10 synchronous requests per second for each unit of concurrency (so 10,000 rps at the default 1,000), and answers 429 beyond it. Off by default; turn it on to see short, hot functions hit the request-rate ceiling before the concurrency one."
  }),
  errorRate: Setting.ratio({ default: 0, label: "Baseline error rate", help: "Chance that an invocation ends in an unhandled error (or, per record, see Batches)." }),
  fanOut: Setting.choice(["sequential", "parallel", "weighted", "none"], {
    default: "sequential",
    label: "Downstream calls",
    help: "After the handler runs: call every output one after another, all at once, pick one by weight, or call none."
  }),
  batchCalls: Setting.choice(["each", "once"], {
    default: "each",
    label: "Batch downstream calls",
    labels: { each: "One per record", once: "One per batch" },
    help: "When invoked with a batch of records (from SQS), call downstream once per record, or once carrying the whole batch."
  }),
  batch: Setting.group(
    {
      duration: Setting.choice(["invocation", "record"], {
        default: "invocation",
        label: "Handler duration is",
        labels: { invocation: "Per invocation", record: "Per record" },
        help: "With a batch of records, take the handler duration once, or once for every record in the batch."
      }),
      errors: Setting.choice(["invocation", "record", "report"], {
        default: "invocation",
        label: "Error rate is",
        labels: { invocation: "Per invocation", record: "Per record", report: "Reported" },
        help: "With a batch of records, roll the error rate once, or once per record. Per record, any failing record fails the whole batch. Reported: the handler catches each record's error (and each record's failed downstream call) and returns the failed records as batch item failures, so the invocation succeeds; only an event source mapping with 'Report batch item failures' on acts on them, otherwise they are deleted with the rest."
      })
    },
    { label: "Batches (event source mapping)" }
  ),
  async: Setting.group(
    {
      maxRetries: Setting.int({
        default: 2,
        min: 0,
        max: 2,
        label: "Retries",
        help: "How many times a failed asynchronous invocation is retried.",
        limit: Setting.hard(`${D}invocation-async-configuring.html`)
      }),
      firstRetryDelay: Setting.duration({
        default: "1 minute",
        min: 0,
        max: "6 hours",
        label: "Delay before first retry",
        help: "AWS waits one minute between the first and second attempt. Only retries after function errors (including timeouts) wait; throttled events back off from 1 s to 5 minutes instead."
      }),
      secondRetryDelay: Setting.duration({ default: "2 minutes", min: 0, max: "6 hours", label: "Delay before second retry", help: "AWS waits two minutes between the second and third attempt." }),
      maxEventAge: Setting.duration({
        default: "6 hours",
        min: "1 minute",
        max: "6 hours",
        label: "Max event age",
        help: "Events not processed within this (because of throttling, or retries) are discarded to the failure destination.",
        limit: Setting.hard(`${D}invocation-async-configuring.html`, "AWS accepts 60 seconds to 6 hours.")
      })
    },
    { label: "Asynchronous invocation" }
  )
})

export type Settings = typeof Config.Type

/**
 * What a function holds back from the regional pool: its reservation if it has one, otherwise its provisioned
 * concurrency. Provisioned concurrency lives inside a reservation, so with both it is the reservation that counts.
 */
export const claimOf = (c: Settings): number => (c.reserved.enabled ? c.reserved.concurrency : c.provisioned)

/** The provisioned environments the function actually gets: AWS refuses more than the reservation, so it is clamped to it. */
export const provisionedOf = (c: Settings): number => (c.reserved.enabled ? Math.min(c.provisioned, c.reserved.concurrency) : c.provisioned)
