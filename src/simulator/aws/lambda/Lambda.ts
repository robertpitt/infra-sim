import { Duration, Effect, Schema, Stream, SubscriptionRef } from "effect"
import * as Component from "../../Component.ts"
import { type CallFailure, Failed, Rejected } from "../../Message.ts"
import * as Aws from "../provider.ts"
import { runAsync } from "./async.ts"
import { Concurrency, makeRegion } from "./concurrency.ts"
import { Config, provisionedOf, type Settings } from "./config.ts"
import { Environments } from "./environments.ts"
import { type Attempt, begin, describe, type FunctionRuntime } from "./invocation.ts"
import { ASYNC_PAYLOAD, D, SYNC_PAYLOAD } from "./limits.ts"
import { Provisioned } from "./provisioned.ts"
import { makeStats } from "./stats.ts"

/** How a failed attempt looks to a synchronous caller: a throttle is the 429 itself, anything else is the function's own error. */
const syncFailure = (node: string, attempt: Attempt): CallFailure =>
  attempt.kind === "throttled" ? attempt.failure : Failed({ node, reason: `function error: ${describe(attempt.failure)}` })

/**
 * AWS Lambda: execution environments (one request each, cold starts, idle expiry), a concurrency limit shared by every
 * function in the region with reserved and provisioned concurrency carved out of it, the per-function scale-up rate,
 * memory-proportional CPU, the timeout, payload limits, and asynchronous invocation with its retries, maximum event age
 * and destinations. The modules beside this file hold the mechanisms; README.md documents them against AWS.
 */
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
    { label: "Requests per second", value: "10 per unit of concurrency (synchronous)", adjustable: false, source: `${D}lambda-concurrency.html`, note: "Enforced when 'Enforce requests-per-second limit' is on." },
    { label: "Init phase (on-demand)", value: "10 s", adjustable: false, source: `${D}lambda-runtime-environment.html`, note: "An Init that overruns is retried inside the first invocation, under the function timeout." },
    { label: "Ephemeral storage (/tmp)", value: "512 to 10,240 MB", adjustable: false, source: `${D}gettingstarted-limits.html`, note: "Not simulated: the simulator has no storage use." },
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
    onFailure: Component.port.one("On failure"),
    onSuccess: Component.port.one("On success")
  },
  state: Schema.Struct({
    /** Executions running right now. */
    concurrent: Schema.Number,
    /** Execution environments alive, busy or idle (provisioned ones are counted separately). */
    environments: Schema.Number,
    /** Provisioned environments allocated and ready. */
    provisioned: Schema.Number,
    /** The most concurrent executions this function is allowed right now. */
    limit: Schema.Number,
    invocations: Schema.Number,
    coldStarts: Schema.Number,
    throttles: Schema.Number,
    timeouts: Schema.Number,
    errors: Schema.Number,
    /** Asynchronous events accepted but not yet finished. */
    asyncPending: Schema.Number,
    asyncRetries: Schema.Number,
    asyncSucceeded: Schema.Number,
    asyncFailed: Schema.Number,
    destinationFailures: Schema.Number
  }),
  make: (node) =>
    Effect.gen(function*() {
      const { fast } = node
      const initial = fast.settings()
      const region = yield* node.shared("lambda", Effect.sync(makeRegion))
      const concurrency = new Concurrency(node.id, region, fast)
      const stats = makeStats(node.meter)
      const fn: FunctionRuntime = {
        id: node.id,
        fast,
        limiter: node.limiter,
        region,
        concurrency,
        environments: new Environments(),
        provisioned: new Provisioned(provisionedOf(initial)),
        stats,
        out: node.out("out"),
        inUse: 0,
        asyncPending: 0
      }
      const destinations = { onFailure: node.out("onFailure"), onSuccess: node.out("onSuccess") }
      concurrency.claim(initial)

      // A setting edited while running is picked up at once, not at the next call: an idle function still holds back
      // its reservation from everyone else's pool, and raising provisioned concurrency starts allocating it.
      const apply = (c: Settings): void => {
        concurrency.claim(c)
        fn.provisioned.retarget(provisionedOf(c), fast, Duration.toMillis(c.provisionedAllocation))
      }
      yield* node.spawn(SubscriptionRef.changes(node.config).pipe(Stream.runForEach((c) => Effect.sync(() => apply(c)))))

      const environments = (): number => {
        fn.environments.expire(fast.now(), Duration.toMillis(fast.settings().coldStart.idleTtl))
        return fn.environments.alive
      }
      node.meter.gaugeUnsafe("concurrent", () => fn.inUse)
      node.meter.gaugeUnsafe("environments", environments)
      node.meter.gaugeUnsafe("provisioned", () => fn.provisioned.allocated)
      node.meter.gaugeUnsafe("asyncPending", () => fn.asyncPending)

      return {
        call: (message) => {
          const async = message.invocation === "async"
          if (message.bytes > (async ? ASYNC_PAYLOAD : SYNC_PAYLOAD)) {
            return Effect.fail(Rejected({ node: node.id, reason: `413 payload over the ${async ? "1 MB asynchronous" : "6 MB synchronous"} limit` }))
          }
          if (async) {
            // 202 Accepted: the caller is done; the event is Lambda's problem now.
            runAsync(fn, destinations, message, fast.now())
            return Effect.void
          }
          return Effect.callback<void, CallFailure>((resume) => {
            const cancel = begin(fn, message, (attempt) => resume(attempt === undefined ? Effect.void : Effect.fail(syncFailure(node.id, attempt))))
            return Effect.sync(cancel)
          })
        },
        probe: Effect.sync(() => ({
          concurrent: fn.inUse,
          environments: environments(),
          provisioned: fn.provisioned.allocated,
          limit: concurrency.standing().limit,
          invocations: stats.invocations.total,
          coldStarts: stats.coldStarts.total,
          throttles: stats.throttles.total,
          timeouts: stats.timeouts.total,
          errors: stats.errors.total,
          asyncPending: fn.asyncPending,
          asyncRetries: stats.asyncRetries.total,
          asyncSucceeded: stats.asyncSucceeded.total,
          asyncFailed: stats.asyncFailed.total,
          destinationFailures: stats.destinationFailures.total
        }))
      }
    })
})
