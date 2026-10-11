import { Duration, Effect, Schema } from "effect"
import * as Component from "../Component.ts"
import * as Distribution from "../Distribution.ts"
import * as Flow from "../Flow.ts"
import { type CallFailure, Failed, type Message, Rejected, Throttled } from "../Message.ts"
import * as Setting from "../Setting.ts"
import type { TimerHandle } from "../VirtualTime.ts"
import { WarmPool } from "../WarmPool.ts"
import * as Aws from "./provider.ts"

const D = Aws.docs.lambda
const SYNC_PAYLOAD = 6 * 1024 * 1024
const ASYNC_PAYLOAD = 1024 * 1024
/** Memory at which a function gets one full vCPU. CPU is proportional to memory. */
const ONE_VCPU_MB = 1769
/** Always kept free of reservations. */
const MIN_UNRESERVED = 100
/** New execution environments a single function can add: 1,000 per 10 seconds. */
const SCALE_UP = { rate: 100, burst: 1_000 }

/** Per-region bookkeeping every Lambda function in the placement shares. */
interface Region {
  /** Executions currently running on the shared, unreserved pool. */
  unreservedInUse: number
  /** What each function holds back from the pool: its reservation, or its provisioned concurrency. */
  readonly claims: Map<string, number>
  /** Changes whenever a claim does, so each function knows when to work out its standing again. */
  version: number
}

const Config = Schema.Struct({
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
        help: "Creating an environment and running initialisation code. AWS says 'under 100 ms to over 1 s' and gives no model, so this is an assumption."
      }),
      idleTtl: Setting.duration({
        default: "10 minutes",
        min: "1 minute",
        max: "6 hours",
        label: "Idle lifetime",
        help: "How long an unused environment stays warm. AWS doesn't publish this number; it says only 'some time'. An assumption."
      })
    },
    { label: "Cold starts" }
  ),
  reserved: Setting.group(
    {
      enabled: Setting.bool({ default: false, help: "Hold back part of the regional concurrency for this function, which also caps it. 0 throttles it entirely." }),
      concurrency: Setting.int({ default: 100, min: 0, max: 1_000_000, unit: "executions", label: "Reserved concurrency" })
    },
    { label: "Reserved concurrency" }
  ),
  provisioned: Setting.int({
    default: 0,
    min: 0,
    max: 1_000_000,
    unit: "executions",
    label: "Provisioned concurrency",
    help: "Execution environments kept initialised, so these never cold start. Counts against the regional concurrency, and can't exceed the reservation.",
    limit: Setting.quota(`${D}provisioned-concurrency.html`)
  }),
  errorRate: Setting.ratio({ default: 0, label: "Baseline error rate" }),
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
  async: Setting.group(
    {
      maxRetries: Setting.int({
        default: 2,
        min: 0,
        max: 2,
        label: "Retries",
        help: "How many times a failed asynchronous invocation is retried.",
        limit: Setting.hard(`${D}invocation-async-error-handling.html`)
      }),
      firstRetryDelay: Setting.duration({ default: "1 minute", min: 0, max: "6 hours", label: "Delay before first retry" }),
      secondRetryDelay: Setting.duration({ default: "2 minutes", min: 0, max: "6 hours", label: "Delay before second retry" }),
      maxEventAge: Setting.duration({
        default: "6 hours",
        min: "1 minute",
        max: "6 hours",
        label: "Max event age",
        help: "Events not processed within this (because of throttling) are discarded to the failure destination.",
        limit: Setting.hard(`${D}invocation-async-error-handling.html`)
      })
    },
    { label: "Asynchronous invocation" }
  )
})

type Config = typeof Config.Type

/** What went wrong inside an invocation attempt, kept apart because async invocation treats the two kinds differently. */
type Attempt = { readonly kind: "throttled"; readonly failure: CallFailure } | { readonly kind: "function"; readonly failure: CallFailure }

export const Lambda = Aws.component({
  type: "aws.lambda",
  service: "Lambda",
  title: "Lambda function",
  description:
    "Runs code on demand. One request per execution environment, cold starts, a concurrency limit shared by the whole region, and asynchronous invocation with its own retries.",
  docs: `${D}gettingstarted-limits.html`,
  category: "compute",
  icon: "lambda",
  accent: "#ff9900",
  limits: [
    { label: "Payload", value: "6 MB synchronous, 1 MB asynchronous", adjustable: false, source: `${D}gettingstarted-limits.html` },
    { label: "Scale-up rate", value: "1,000 new environments per 10 s, per function", adjustable: false, source: `${D}scaling-behavior.html`, note: "The docs state it as a fixed limit; they don't say it is adjustable." },
    { label: "Unreserved concurrency", value: "100 always kept free", adjustable: false, source: `${D}lambda-concurrency.html` },
    { label: "Init phase (on-demand)", value: "10 s", adjustable: false, source: `${D}lambda-runtime-environment.html` },
    { label: "Concurrency limit", value: "set per region in the account quotas", adjustable: true, source: `${D}gettingstarted-limits.html` }
  ],
  highlights: [
    { gauge: "concurrent", label: "running" },
    { rate: "coldStarts", label: "cold/s" },
    { rate: "throttles", label: "429/s" }
  ],
  config: Config,
  ports: {
    out: Component.port.many("Downstream"),
    onFailure: Component.port.one("On failure")
  },
  state: Schema.Struct({
    /** Executions running right now. */
    concurrent: Schema.Number,
    /** Execution environments alive, busy or idle. */
    environments: Schema.Number,
    /** The most concurrent executions this function is allowed right now. */
    limit: Schema.Number,
    invocations: Schema.Number,
    coldStarts: Schema.Number,
    throttles: Schema.Number,
    timeouts: Schema.Number,
    errors: Schema.Number,
    /** Asynchronous events accepted but not yet finished. */
    asyncPending: Schema.Number,
    asyncFailed: Schema.Number
  }),
  make: (node) =>
    Effect.gen(function*() {
      const { fast } = node
      const out = node.out("out")
      const region = yield* node.shared<Region>("lambda", Effect.sync(() => ({ unreservedInUse: 0, claims: new Map(), version: 0 })))
      const initial = fast.settings()

      let ownInUse = 0
      let poolInUse = 0
      let asyncPending = 0
      // Provisioned environments are always warm: a counter of the ones free. Everything else lives in a warm pool,
      // where a request either finds an idle environment or pays for a cold start.
      let provisionedFree = initial.provisioned
      const warm = new WarmPool()
      const totals = { invocations: 0, coldStarts: 0, throttles: 0, timeouts: 0, errors: 0, asyncFailed: 0 }
      const coldStarts = node.meter.counter("coldStarts")
      const throttles = node.meter.counter("throttles")
      const timeouts = node.meter.counter("timeouts")
      const asyncRetries = node.meter.counter("asyncRetries")
      const scaleKey = `${node.id}/scale`

      const environments = (): number => {
        warm.expire(fast.now(), Duration.toMillis(fast.settings().coldStart.idleTtl))
        return warm.alive
      }
      yield* node.meter.gauge("concurrent", Effect.sync(() => ownInUse))
      yield* node.meter.gauge("environments", Effect.sync(environments))
      yield* node.meter.gauge("asyncPending", Effect.sync(() => asyncPending))

      /** What this function holds back from the regional pool: its reservation, or else its provisioned concurrency. */
      const claim = (c: Config) => (c.reserved.enabled ? c.reserved.concurrency : c.provisioned)
      /**
       * Where the function stands against the limits right now: its reservation if it has one, otherwise the shared
       * regional pool, which is the account limit minus what every function has claimed (never below 100). Worked out
       * again only when the settings, the quotas or anyone's claim change.
       */
      interface Standing {
        readonly reserved: boolean
        readonly reservation: number
        readonly pool: number
        readonly limit: number
      }
      let memo: { c: Config; account: Aws.Account; version: number; value: Standing } | undefined
      const capacity = (): Standing => {
        const c = fast.settings()
        const account = fast.account() as Aws.Account
        const mine = claim(c)
        if (region.claims.get(node.id) !== mine) {
          region.claims.set(node.id, mine)
          region.version++
        }
        if (memo !== undefined && memo.c === c && memo.account === account && memo.version === region.version) return memo.value
        let claimed = 0
        for (const v of region.claims.values()) claimed += v
        // AWS keeps at least 100 unreserved, so reservations (and provisioned concurrency) can total at most the quota minus 100.
        const pool = account.lambdaConcurrency - Math.min(claimed, Math.max(0, account.lambdaConcurrency - MIN_UNRESERVED))
        const value = { reserved: c.reserved.enabled, reservation: c.reserved.concurrency, pool, limit: c.reserved.enabled ? c.reserved.concurrency : pool + c.provisioned }
        memo = { c, account, version: region.version, value }
        return value
      }

      // --- What the handler does once it is running --------------------------------------------------------------
      /** After its own work, the handler calls whatever is wired downstream. A batch is handled a record at a time, ten at once. */
      const downstream = (message: Message, c: Config, done: Flow.Done): Flow.Cancel => {
        if (message.count > 1 && c.batchCalls === "each") {
          const each = { ...message, count: 1, bytes: Math.max(1, Math.round(message.bytes / message.count)) }
          return Flow.forEach(message.count, 10, (_, d) => Flow.fanOut(c.fanOut, out, fast.random, each, d), done)
        }
        return Flow.fanOut(c.fanOut, out, fast.random, message, done)
      }

      // --- One invocation attempt: admit, find an environment, run ----------------------------------------------
      type Outcome = (outcome: Attempt | undefined) => void

      const begin = (message: Message, done: Outcome): Flow.Cancel => {
        const c = fast.settings()
        const cap = capacity()
        const reserved = cap.reserved
        const throttled = reserved ? ownInUse >= cap.reservation : provisionedFree <= 0 && region.unreservedInUse >= cap.pool
        if (throttled) {
          totals.throttles++
          throttles.n++
          done({ kind: "throttled", failure: Throttled({ node: node.id, reason: "429 concurrency limit reached" }) })
          return Flow.noCancel
        }
        totals.invocations++
        ownInUse++

        const provisioned = provisionedFree > 0
        const ttl = Duration.toMillis(c.coldStart.idleTtl)
        if (provisioned) provisionedFree--
        else {
          // An on-demand environment: reuse an idle one, or create one if the scale-up rate allows.
          if (warm.idleCount(fast.now(), ttl) <= 0 && !node.limiter.takeUnsafe(scaleKey, SCALE_UP)) {
            totals.throttles++
            throttles.n++
            ownInUse--
            done({ kind: "throttled", failure: Throttled({ node: node.id, reason: "429 scaling rate limit" }) })
            return Flow.noCancel
          }
          poolInUse++
          if (!reserved) region.unreservedInUse++
        }

        let finished = false
        let haveEnvironment = provisioned
        let timeout: TimerHandle | undefined
        let step: TimerHandle | undefined
        let cancelWork: Flow.Cancel = Flow.noCancel

        /** Give back what the attempt held. */
        const settle = (discardEnvironment: boolean): void => {
          ownInUse--
          if (provisioned) provisionedFree++
          else {
            poolInUse--
            if (!reserved) region.unreservedInUse--
            if (haveEnvironment) {
              if (discardEnvironment) warm.discard()
              else warm.release(fast.now())
            }
          }
        }
        const complete = (failure: CallFailure | undefined): void => {
          if (finished) return
          finished = true
          timeout?.cancel()
          settle(false)
          done(failure === undefined ? undefined : { kind: "function", failure })
        }
        /** The function ran out of time: its work is abandoned and its environment thrown away, so the next call is cold. */
        const timedOut = (): void => {
          if (finished) return
          finished = true
          step?.cancel()
          cancelWork()
          totals.timeouts++
          timeouts.n++
          settle(true)
          done({ kind: "function", failure: Failed({ node: node.id, reason: "task timed out" }) })
        }
        let handler = c
        const afterWork = (): void => {
          if (finished) return
          if (handler.errorRate > 0 && fast.random.nextDoubleUnsafe() < handler.errorRate) return complete(Failed({ node: node.id, reason: "unhandled error" }))
          cancelWork = downstream(message, fast.settings(), complete)
        }
        const run = (): void => {
          // The timeout covers the handler, not the cold start before it.
          const t = (handler = fast.settings())
          timeout = fast.after(Duration.toMillis(t.timeout), timedOut, undefined)
          const cpuScale = 1 + t.cpuBound * (Math.max(1, ONE_VCPU_MB / t.memory) - 1)
          step = fast.after(Distribution.latencyMs(t.duration, fast.random) * cpuScale, afterWork, undefined)
        }

        if (provisioned || warm.take(fast.now(), ttl)) {
          haveEnvironment = true
          run()
        } else {
          totals.coldStarts++
          coldStarts.n++
          step = fast.after(Distribution.latencyMs(c.coldStart.init, fast.random), () => {
            if (finished) return
            warm.created()
            haveEnvironment = true
            run()
          }, undefined)
        }

        // The caller gave up on this attempt: stop the work and put the environment back.
        return () => {
          if (finished) return
          finished = true
          timeout?.cancel()
          step?.cancel()
          cancelWork()
          settle(false)
        }
      }

      // --- Asynchronous invocation: accepted at once, run and retried from an internal queue ----------------------
      const runAsync = (message: Message, acceptedAt: number): void => {
        asyncPending++
        let systemRetries = 0
        let functionRetries = 0
        const finish = (): void => void asyncPending--
        const fail = (): void => {
          totals.asyncFailed++
          node.out("onFailure")[0]?.send(message)
          finish()
        }
        const attempt = (): void => {
          begin(message, (outcome) => {
            if (outcome === undefined) return finish()
            const c = fast.settings()
            if (outcome.kind === "throttled") {
              // Lambda retries throttled events itself, backing off from 1 s to 5 min, until they get too old.
              if (fast.now() - acceptedAt >= Duration.toMillis(c.async.maxEventAge)) return fail()
              asyncRetries.n++
              fast.after(Math.min(5 * 60_000, 1000 * 2 ** systemRetries++), attempt, undefined)
            } else if (functionRetries < c.async.maxRetries) {
              asyncRetries.n++
              fast.after(Duration.toMillis(functionRetries++ === 0 ? c.async.firstRetryDelay : c.async.secondRetryDelay), attempt, undefined)
            } else fail()
          })
        }
        attempt()
      }

      return {
        call: (message) => {
          const async = message.invocation === "async"
          if (message.bytes > (async ? ASYNC_PAYLOAD : SYNC_PAYLOAD)) {
            return Effect.fail(Rejected({ node: node.id, reason: `413 payload over the ${async ? "1 MB asynchronous" : "6 MB synchronous"} limit` }))
          }
          if (async) {
            // 202 Accepted: the caller is done; the event is Lambda's problem now.
            runAsync(message, fast.now())
            return Effect.void
          }
          return Effect.callback<void, CallFailure>((resume) => {
            const cancel = begin(message, (outcome) => {
              if (outcome === undefined) return resume(Effect.void)
              resume(Effect.fail(outcome.kind === "throttled" ? outcome.failure : Failed({ node: node.id, reason: `function error: ${outcome.failure._tag}` })))
            })
            return Effect.sync(cancel)
          })
        },
        probe: Effect.sync(() => ({
          concurrent: ownInUse,
          environments: environments(),
          limit: capacity().limit,
          asyncPending,
          ...totals
        }))
      }
    })
})
