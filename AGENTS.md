# AGENTS.md

How to write code in this repository. It is written for coding agents, and holds for humans too.

infra-sim is an Effect v4 codebase. `src/simulator` is the engine: pure Effect, no DOM, no Node. `src/cli` is a thin Node command line over it. `src/ui` is a React app that runs the engine in a worker. The engine is where these rules matter most, but they apply to every file that touches Effect.

**The one rule: write Effect, not JavaScript that happens to call Effect.** If you are about to write `try`, `throw`, `async`, `Date.now()`, `Math.random()`, `setTimeout`, `console.log`, a hand-rolled `typeof` check, or a class with mutable fields, stop. There is an Effect way to do it, and it is listed below. The few places where this codebase deliberately does otherwise are named in [The hot path](#the-hot-path-the-one-sanctioned-exception). Copying them elsewhere is a bug.

## Before you write anything

1. **Read the local design docs.** [SIMULATOR.md](SIMULATOR.md) has the principles, the role of each module and the performance rules. [PRIMITIVES.md](PRIMITIVES.md) has the vocabulary: ports, protocols, connectors, controllers. Most folders under `src/simulator` have their own `README.md`.
2. **Look up Effect APIs in the source, not from memory.** Your training data is mostly Effect **v3**, and v4 renamed or removed much of it. A local copy of Effect v4 lives in `vendor/effect`. It is gitignored. If it is missing:

   ```sh
   git clone --depth 1 https://github.com/Effect-TS/effect.git vendor/effect
   ```

   Search these, in this order:
   - `vendor/effect/LLMS.md`: the official guide to writing Effect, maintained for LLMs.
   - `vendor/effect/ai-docs/src/**`: small runnable examples for services, layers, errors, resources, streams, testing and more.
   - `vendor/effect/packages/effect/src/<Module>.ts`: the API itself. Every export has JSDoc with examples.
   - `vendor/effect/migration/*.md`: how a v3 idea is spelled in v4.
3. **Read the neighbours.** Find the closest existing module and match it: its file layout, naming, comment voice and test helpers.

### v3 habits that do not compile (or should not)

| You remember (v3) | Write (v4) |
| --- | --- |
| `Context.Tag`, `Context.GenericTag`, `Effect.Tag`, `Effect.Service` | `class X extends Context.Service<X, Shape>()("simulator/X") {}` |
| `FiberRef` | `Context.Reference` |
| `Either` | `Result` |
| `Effect.catchAll`, `Effect.catchAllCause` | `Effect.catch`, `Effect.catchCause` |
| `Effect.either` | `Effect.result` |
| `Effect.fork`, `Effect.forkDaemon` | `Effect.forkChild`, `Effect.forkScoped`, `Effect.forkDetach` |
| `Layer.scoped` | `Layer.effect` (it already handles `Scope`) |
| `@effect/schema`, `@effect/platform`, `@effect/cli` | `Schema`, `FileSystem`, `Path` from `"effect"`; the CLI from `"effect/cli"`; see `migration/v3-to-v4.md` |
| `class E extends Error`, `Data.TaggedError` thrown | `Schema.TaggedError` failed into the error channel |
| `Runtime<R>` | gone; see `migration/runtime.md` |

When unsure, `grep -n "^export const <name>" vendor/effect/packages/effect/src/<Module>.ts`.

## Checking your work

| Command | Use |
| --- | --- |
| `npm run typecheck` | TypeScript 7, with the Effect language service. Effect warnings and errors fail it. Run it after every change. |
| `npm run diagnostics -- --file src/path/File.ts` | Every Effect diagnostic for one file, **suggestions included**. Run it on each file you touched. |
| `npx vitest run src/path/tests/File.test.ts` | Targeted tests. The full `npm test` takes about 3.5 minutes; run it once at the end. |

The Effect language service ([`@effect/tsgo`](https://github.com/Effect-TS/tsgo), configured in `tsconfig.json`) is a type-aware Effect linter. It catches floating effects, missing requirements, unhandled errors, `try`/`catch` in generators, global `Error` in the error channel, chained `Effect.provide`, `Date`/`Math.random`/`console`/`fetch` inside Effect code, and more. **Fix what it reports instead of suppressing it.** If a suppression is genuinely right, scope it to one line and say why:

```ts
// The wall clock on purpose: this measures how long the run took for real, not in virtual time.
// @effect-diagnostics-next-line globalDate:off
const started = Date.now()
```

## What a well-designed module looks like

One concept per file, named for it in PascalCase (`Fault.ts`, `Limiter.ts`, `Telemetry.ts`). Callers import the module as a namespace: `import * as Fault from "./Fault.ts"`. Inside the engine, use relative `.ts` imports. `#simulator` is for `src/ui` and `src/cli`. Effect itself is imported by name from the barrel: `import { Effect, Layer, Schema } from "effect"`. Unstable subpaths are imported by path: `import { TestClock } from "effect/testing"`.

A file reads top to bottom in this order:

1. **Module comment.** What the concept is and why it exists, in a few sentences.
2. **Models.** `Schema` classes, structs and unions. The schema *is* the type, so don't declare a parallel `interface`.
3. **Errors.** `Schema.TaggedError` classes for every expected failure.
4. **References.** `Context.Reference`s for tunables that have a sensible default.
5. **Service shape.** `export interface Service` (or inline in the class when it is short). Every member returns an `Effect` or a `Stream`, has a precise error type, and requires nothing (`R = never`).
6. **`make`.** Builds the service. Dependencies are `yield*`ed here, once, and closed over. The service's methods never ask for them again.
7. **The service class.** `Context.Service` with the id `"simulator/<Name>"`, and its layers as `static readonly` members (`layer`, `layerTest`, …).
8. **Public combinators.** Anything else callers use. Plain helpers the service is built from do **not** go here: they go in `internal/` (next section). Use `// ----` banners to section long files.

### Public modules and `internal/`

The Effect codebase keeps each public module readable by moving the raw implementation out of it: `Graph.ts` is the documented API, and the algorithms live in `internal/graph.ts`. `cli/Command.ts` reads as the command API, and the lexer, parser and help rendering live in `cli/internal/`. Follow the same split here. Read `vendor/effect/packages/effect/src/cli/` for a model of it.

- **A folder holds two kinds of module.**
  - *Public* modules are PascalCase (`Fault.ts`, `aws/sqs/Sqs.ts`, `aws/sqs/Quotas.ts`) and form the folder's surface: schemas, errors, the service and its layers, the component definition, and documented functions callers use.
  - *Internal* modules are lower camelCase and live in the folder's `internal/` (`internal/fault.ts`, `aws/sqs/internal/store.ts`). They hold the implementation: pure functions, calculations, parsing and formatting, lookup tables, and the plain-JS state machines of the hot path.
- **`X/internal/` is private to `X`.** Anything under `X/` may import it, including subfolders. Nothing outside `X/` may. If another area needs a function, the function is public: give it a PascalCase module (that is why `aws/ec2/InstanceTypes.ts` is public, because ECS and EKS read it). `npm run typecheck` runs `tools/check-internal.mjs`, which fails on an import into someone else's `internal/` and on a lower-case module outside one.
- **What moves to `internal/`:** module-level helpers that are not the module's API, such as arithmetic over settings, table lookups, encoding and decoding by hand, timer and queue bookkeeping, and the bodies of synchronous `…Unsafe` paths. Large constant tables move too. A public module should read as *what* it is and *how the pieces fit*: the service's `make` is orchestration that calls well-named internal functions, not 200 lines of index arithmetic.
- **What stays public:** the module comment, schemas, errors, references, the service interface, `make`, the class and its layers, and every export callers use, each with its doc comment. When a public function is only a thin wrapper over an internal implementation, keep the export and its documentation in the public module and delegate: `export const parse = (text: string): Expression => internal.parse(text)`.
- **Dependencies point inward.** A public module imports its internals as a namespace (`import * as internal from "./internal/fault.ts"`) or by name. Internal modules may import any public module (`internal/scenario.ts` uses `Check.ts` and `Fault.ts`), except a module that imports them, directly or through others. For the module an internal file serves, import *types* only (`import type { Fault } from "../Fault.ts"`). A runtime import cycle breaks with temporal-dead-zone errors, depending on which file loads first.
- **Naming.** Name an internal module after the public module it serves (`Fault.ts` uses `internal/fault.ts`) or after its mechanism (`internal/timerQueue.ts`). One internal module may serve several public ones in the same folder.
- **Internal code is still documented.** Give each internal module a module comment saying what it implements and for whom, and give each export a one-line doc comment. It is still Effect code where it is not the hot path; `internal/` is about where code lives, not permission to write plain JavaScript.
- **Tests follow their subject.** Tests of an internal module sit in `internal/tests/` (`internal/tests/cidr.test.ts`). Behaviour tests go through the public module.
- **Reuse before you write.** Before adding a helper, look in the `internal/` of your folder and of each ancestor up to `src/simulator/internal/`: units, identity memoisation and number formatting already exist there, and the frame readers and simulation starter for tests are in `src/simulator/testing.ts`. When two folders need the same helper, it goes in the `internal/` of their lowest common ancestor, written once. A second copy with small differences becomes one parameterised function.
- **Don't split for the sake of it.** A 60-line module with two small private helpers is fine as it is. Split when the helpers obscure the module's API, when they are big enough to need their own tests, or when several public modules in the folder share them.

A complete small example, in the house style. It typechecks, has no Effect diagnostics, and its test passes:

```ts
/**
 * Leases: exclusive, time-limited claims on a key. A holder acquires a key for a while; anyone else is refused until
 * the lease is released or expires. Expired leases are swept by a fiber that lives as long as the service.
 */
import { Clock, Context, Duration, Effect, HashMap, Layer, Option, Schedule, Schema, type Scope, SynchronizedRef } from "effect"

/** A lease held on `key` by `holder` until `expiresAt` (virtual milliseconds). */
export class Lease extends Schema.Class<Lease>("simulator/Lease")({
  key: Schema.String,
  holder: Schema.String,
  expiresAt: Schema.Finite
}) {}

/** The key is leased to someone else, and the lease has not expired. */
export class LeaseHeld extends Schema.TaggedError<LeaseHeld>()("LeaseHeld", {
  key: Schema.String,
  holder: Schema.String,
  expiresAt: Schema.Finite
}) {}

/** How long a lease lasts when `acquire` is not told. */
export const DefaultTtl = Context.Reference<Duration.Duration>("simulator/Leases/DefaultTtl", {
  defaultValue: () => Duration.seconds(30)
})

export interface Service {
  /** Claims `key` for `holder`. Re-acquiring your own lease extends it. */
  readonly acquire: (key: string, holder: string, ttl?: Duration.Input) => Effect.Effect<Lease, LeaseHeld>
  /** Gives `key` back. `false` if `holder` did not hold it. */
  readonly release: (key: string, holder: string) => Effect.Effect<boolean>
  /** The leases currently held, expired ones excluded. */
  readonly held: Effect.Effect<ReadonlyArray<Lease>>
}

/** Builds the service. The sweeper is forked into the surrounding scope and stops with it. */
export const make: Effect.Effect<Service, never, Scope.Scope> = Effect.gen(function*() {
  const defaultTtl = yield* DefaultTtl
  const leases = yield* SynchronizedRef.make(HashMap.empty<string, Lease>())

  const acquire = Effect.fn("Leases.acquire")(function*(key: string, holder: string, ttl?: Duration.Input) {
    const now = yield* Clock.currentTimeMillis
    const expiresAt = now + Duration.toMillis(ttl ?? defaultTtl)
    return yield* SynchronizedRef.modifyEffect(leases, (all) => {
      const current = HashMap.get(all, key)
      if (Option.isSome(current) && current.value.holder !== holder && current.value.expiresAt > now) {
        return Effect.fail(new LeaseHeld(current.value))
      }
      const lease = new Lease({ key, holder, expiresAt })
      return Effect.succeed([lease, HashMap.set(all, key, lease)] as const)
    })
  })

  const release = Effect.fn("Leases.release")(function*(key: string, holder: string) {
    return yield* SynchronizedRef.modify(leases, (all) => {
      const current = HashMap.get(all, key)
      return Option.isSome(current) && current.value.holder === holder
        ? [true, HashMap.remove(all, key)] as const
        : [false, all] as const
    })
  })

  const held = Effect.gen(function*() {
    const now = yield* Clock.currentTimeMillis
    const all = yield* SynchronizedRef.get(leases)
    return Array.from(HashMap.values(all)).filter((lease) => lease.expiresAt > now)
  })

  const sweep = Effect.gen(function*() {
    const now = yield* Clock.currentTimeMillis
    yield* SynchronizedRef.update(leases, HashMap.filter((lease) => lease.expiresAt > now))
  })
  yield* sweep.pipe(Effect.repeat(Schedule.spaced("1 second")), Effect.forkScoped)

  return { acquire, release, held }
})

export class Leases extends Context.Service<Leases, Service>()("simulator/Leases") {
  static readonly layer: Layer.Layer<Leases> = Layer.effect(Leases, make)
}
```

What to notice:

- **Time comes from `Clock`, so it is virtual.** Under `VirtualTime` or `TestClock` the lease expires when the world says so, which keeps runs deterministic and tests instant.
- **Atomic state.** The read-check-write in `acquire` runs inside `SynchronizedRef.modifyEffect`, so two fibers can't both win. A `Ref.get` followed by a `Ref.set` with a `yield*` in between is a race.
- **The failure is a value in the type.** `Effect<Lease, LeaseHeld>` tells the caller exactly what can go wrong, and `Effect.catchTag("LeaseHeld", …)` handles it.
- **Methods are `Effect.fn("Service.method")`.** That gives each call a span and a readable stack trace. Use `Effect.fnUntraced` for internal helpers on hot paths.
- **Lifetimes are scoped.** The sweeper is `forkScoped`, so it stops when the layer's scope closes. No `setInterval`, no manual cleanup, no leak.
- **`make` comes before the class.** A `static` initializer runs when the class is defined. `Layer.effect(Leases, make)` would throw a temporal-dead-zone error if `make` were a `const` further down. Either keep this order or make `make` a function declaration called as `make()` (as `Engine.ts` does).

## Services and layers

- **Declare** a service as `class X extends Context.Service<X, Shape>()("simulator/X")`. The id is `"<area>/<Name>"`, which keeps it unique and greppable. Refer to the shape elsewhere as `X["Service"]` or `Context.Service.Shape<typeof X>`.
- **Construct** with an exported `make`. It is an `Effect` when it needs dependencies, scope or state, and a plain function when it doesn't. Tests and other services can then build one without a layer.
- **Layers** are static members: `layer` (production wiring), `layerTest`, and `layerNoDeps` when it is useful to expose one without its dependencies wired. Build them with `Layer.effect(X, make)`, or `Layer.sync`/`Layer.succeed` when nothing is effectful.
- **Don't leak requirements.** A method's `R` is `never`. If a method needs `Registry`, `make` should `yield* Registry` once. The `leakingRequirements` diagnostic flags this.
- **Compose layers with `Layer.provide`** (hide the dependency) **or `Layer.provideMerge`** (expose it too). Use `Layer.mergeAll` for siblings that don't depend on each other.
- **Provide once, at the edge.** Pass several layers in one call, `Effect.provide([a, b])`, never `Effect.provide(a), Effect.provide(b)` (the `multipleEffectProvide` diagnostic flags the chained form).
- **Gotcha: references are not requirements.** `Clock`, `Random`, the log level and other `Context.Reference`s have defaults, so the types never complain when you forget to provide one, or when you provide it beside a layer that should have been built *inside* it. If a layer captures a reference while it is built (it forks a fiber, reads the clock, takes a random stream), provide the reference *to* that layer: `X.layer.pipe(Layer.provideMerge(TestClock.layer()))`. Swapping that for the array form broke `Engine.test.ts`.
- **Config with defaults** is a `Context.Reference`. Per-component settings are Schema (see `Setting.ts`), not ad-hoc option bags.

## Errors

Effect has two kinds of failure. Keep them apart.

- **Expected failures** are values in the error channel. Model each as a `Schema.TaggedError` with the fields a caller needs to react, then fail with `return yield* new NoSuchNode({ id })`. The `return` tells TypeScript the branch ends.
- **Defects** are bugs or broken invariants. Use `Effect.die`, or `Effect.orDie` at the boundary where a failure means the program is wrong (for example decoding a design that was already validated). Don't `orDie` an error a caller could reasonably handle.
- **Never `throw` and never `try`/`catch` in Effect code.** Wrap code that throws with `Effect.try({ try, catch })`, and promises with `Effect.tryPromise({ try, catch })`, mapping the cause to a tagged error. Parse unknown input with `Schema.decodeUnknownEffect`, never `JSON.parse` plus hand checks.
- **Never put the global `Error`, `unknown` or `any` in an error channel.** Give the error a tag (diagnostics: `globalErrorInEffectFailure`, `anyUnknownInErrorContext`).
- **Handle errors by tag.** Use `Effect.catchTag`, `Effect.catchTags`, and `Effect.catchReason` for nested `reason` errors. Use `Effect.catch` only when every error really gets the same treatment. Don't add error handling to an effect that can't fail (`catchUnfailableEffect`).
- **Outcomes that aren't failures are data.** A call that was throttled or timed out is an ordinary result in the simulator, modelled as a `Data.TaggedEnum` (`Message.ts`) and matched with `$match` or `Match`.
- **Legacy to fix, not copy.** `ScenarioError` (`Scenario.ts`) and `ImportError` (`importers/Importer.ts`) extend `Error` and are thrown. `Registry.make` throws on a duplicate registration. `UsageError` in the CLI is thrown. When you touch one of these, move it towards a tagged error in the error channel. Don't add more like them.

## Data, validation and types

- **Schema is the single source of truth** for anything that crosses a boundary: design files, component settings, engine commands and events, errors. One schema gives the type, the validation, the defaults, the JSON codec and (via `Describe`) the UI form.
- **Prefer `Schema.Finite` (or `Schema.Int`) to `Schema.Number`** for new fields, unless `NaN` or `Infinity` is meaningful. Put units in the name or the doc comment (`expiresAt` in ms).
- **Decode with the Effect API inside effects** (`Schema.decodeUnknownEffect`), and use the typed `decode*` when the input is already typed (`schemaSyncInEffect`, `preferTypedSchemaDecoder`).
- **Use `Predicate`**, never a hand-written `isRecord` or `typeof x === "object" && x !== null`.
- **Use Effect's data modules where they compose:** `Option`, `Result`, `HashMap`, `Array`, `Record`, `Match`, `Duration` (not millisecond arithmetic on raw numbers, where a `Duration` reads better). `T | undefined` for a plain absent value is fine; Effect v4 does it too (`UndefinedOr`).
- **Immutable by default:** `readonly` fields, `ReadonlyArray`, and no mutable classes for domain data.

## Time, randomness, concurrency, resources

| Instead of | Use |
| --- | --- |
| `Date.now()`, `new Date()` | `Clock.currentTimeMillis`, `DateTime.now` (virtual under `VirtualTime`) |
| `Math.random()` | the `Random` service; in the engine, the node's seeded stream (`SeededRandom`) |
| `setTimeout`, `setInterval`, sleep loops | `Effect.sleep`, `Effect.repeat(Schedule…)`, `Effect.timeout` |
| hand-written retry loops | `Effect.retry` with a `Schedule` |
| `async`/`await`, `Promise` chains | `Effect.gen`; `Effect.tryPromise` at a foreign boundary only |
| `console.log` | `Effect.log`, `Effect.logDebug`, plus `Effect.annotateLogs` |
| `new AbortController()` | interruption, which Effect does for you; `Effect.abortSignal` when a foreign API needs one |
| fire-and-forget promises | `Effect.forkChild` (dies with its parent), `Effect.forkScoped` (dies with the scope), `FiberMap`/`FiberSet` for keyed or many |
| `let` shared between fibers | `Ref`, `SynchronizedRef` (effectful updates), `SubscriptionRef` (others watch it) |
| event emitters, callback lists | `PubSub`, `Queue`, `Stream` |
| mutex flags, counters of in-flight work | `Semaphore`, `Latch`, `Deferred` |
| open/close pairs, `finally` | `Effect.acquireRelease`, `Effect.addFinalizer`, `Effect.ensuring` |

And three habits that the language service catches:

- **Never leave an effect floating.** An effect that is built and neither `yield*`ed, returned nor assigned does nothing (`floatingEffect`).
- **Don't call `Effect.run*` inside an effect.** Compose instead. `run*` belongs only at the true edge: the worker entry, the CLI `main`, a test (`runEffectInsideEffect`).
- **Don't `return` an effect from a generator expecting it to run.** `return yield* effect` runs it; `return effect` nests it (`returnEffectInGen`).

## Effect.gen, Effect.fn and pipe

- Use **`Effect.gen`** for inline sequential code.
- Use **`Effect.fn("Name.method")`** for any reusable function that returns an effect. The name should match the function. Add behaviour as extra arguments, `Effect.fn("x")(function*() {…}, Effect.catchTag(…))`, not with `.pipe` on the result. Annotate the return type with `Effect.fn.Return<A, E, R>` when inference is not enough.
- Use **`Effect.fnUntraced`** for internal helpers and hot paths where a span is not worth its cost.
- **Don't write a function whose body is only `return Effect.gen(…)`.** That is what `Effect.fn` is for. Don't call `Effect.fn(…)` as an IIFE; use `Effect.gen` (`effectFnIife`).
- Use **`.pipe(…)`** to attach cross-cutting behaviour (`Effect.timeout`, `Effect.retry`, `Effect.withSpan`, `Effect.orDie`, `Effect.provide`) to an effect, not to write the main logic.

## The hot path: the one sanctioned exception

A busy design makes hundreds of thousands of calls per simulated minute. [SIMULATOR.md § Performance](SIMULATOR.md#performance) describes the measured work that made the per-call path plain JavaScript: an edge call is a timer state machine (`Edge.Link.send`), handlers decide synchronously and wait through `Flow`, `Limiter.takeUnsafe` is a synchronous token bucket, and `Faults.forNodeUnsafe` returns a shared constant. That is why `src/simulator` has many `let`s, `for` loops, `Map`s and small mutable classes.

The rules for writing code like that:

1. **Only on a path that runs per call or per message**, and only with a benchmark (`npm run bench`) that shows the Effect version is the cost. If you can't point at a measurement, write the Effect version.
2. **Behind an Effect-native surface.** The public API stays a service, an `Effect`, or a `Stream`. The synchronous variant sits beside it and is named `…Unsafe`, as in `forNodeUnsafe` and `takeUnsafe`.
3. **Mutable state is private to one component**, and its doc comment says so.
4. **Still deterministic.** Time comes from the world and randomness from the seeded stream, even inside the state machine.
5. **Everything else stays Effect-native:** setup, `Component.make`, the `Simulation` and `Engine` services, schemas, probes, inspection, the CLI and the importers.

## Documentation

Write in the house voice: plain English that explains *what it is and why*, not a restatement of the types.

- **A module comment at the top of every module**, saying what the concept is and how it fits.
- **A doc comment on every export**, and on service members whose behaviour isn't obvious from the name: units, edge cases, what happens on failure, and whether it is safe on the hot path.
- **Comments say why.** Don't narrate what the next line does.
- **No `@since`, `@category` or `@param` tags.** This is an application, not a published library.
- Effect's own source (`vendor/effect/packages/effect/src`) is the model for doc quality. A good doc comment states what the API does, when to use it, and its gotchas.

## Tests

- **In a `tests/` folder beside the code:** `X/Foo.ts` has `X/tests/Foo.test.ts`, and `X/internal/cidr.ts` has `X/internal/tests/cidr.test.ts` (`npm run typecheck` checks this). Shared helpers stay in the folder's `testing.ts`. Tests use plain `vitest` (`describe`, `it`, `expect`), and each test runs its Effect with `Effect.runPromise`. Don't add `@effect/vitest` without asking.
- **Use the shared helpers.** `src/simulator/testing.ts` decodes a design, starts a `Simulation` under `VirtualTime`, runs a body against it (`sim`, `frames`, or `simulator(extraComponents)` for test components) and reads frames (`mean`, `rate`, `gauge`, `peak`...). A folder's own `testing.ts` keeps only what its tests alone need. New helpers go in `testing.ts`.
- **Never wait on the wall clock.** Simulations run under `VirtualTime` and advance it. Service tests use `TestClock.adjust`. A real `sleep` in a test is a bug.
- **Test behaviour and its edges**, as [SIMULATOR.md § Testing](SIMULATOR.md#testing) lists: determinism for the same seed, failure paths (assert the error `_tag` and fields), interruption and cleanup (scopes close and fibers stop).
- Provide test layers the way production does: one `Effect.provide`, with `Layer.provideMerge` where the test needs the dependency too, and the clock provided *to* any layer that captures it (see [Services and layers](#services-and-layers)).

## Before you say you're done

- [ ] `npm run typecheck` passes.
- [ ] `npm run diagnostics -- --file <each file you touched>` shows nothing new, suggestions included.
- [ ] Targeted tests pass, and the full suite passes once at the end (`npm test`).
- [ ] No `throw`, `try`, `async`, `Promise`, `Date.now`, `Math.random`, `setTimeout` or `console` in Effect code you wrote, unless it is hot-path code that follows the rules above.
- [ ] Every new error is a `Schema.TaggedError` in the error channel; every new service is a `Context.Service` with a `make` and a static `layer`; service methods have `R = never`.
- [ ] Public modules read as their API: helpers are in `internal/`, nothing re-implements a helper that an ancestor's `internal/` already has, and `npm run typecheck` (which runs the `internal/` boundary check) passes.
- [ ] New exports have doc comments; the folder's `README.md` and SIMULATOR.md are updated if behaviour or structure changed.
- [ ] Anything you could not run is said so in your report.
