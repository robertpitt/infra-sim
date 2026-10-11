import { type Effect, Schema, type Scope, type SubscriptionRef } from "effect"
import type { AnyComponent } from "./Component.ts"
import * as Describe from "./Describe.ts"
import type { ActiveFault, Fault } from "./Fault.ts"
import type { SeededRandom } from "./SeededRandom.ts"
import type { Meter, Stats } from "./Telemetry.ts"
import type { TimerHandle } from "./VirtualTime.ts"

/**
 * A controller is a loop that watches part of a running design, decides, and acts, on the virtual clock.
 *
 * It is how a system changes itself while it runs: a Kubernetes horizontal autoscaler resizing a deployment, Application
 * Auto Scaling raising a table's capacity or a function's provisioned concurrency, an operator's runbook, a chaos
 * schedule. What makes it a primitive rather than code inside a component is what it is allowed to do:
 *
 *  - it **observes** only what anyone can see: its target's metrics each frame, its target's settings;
 *  - it **acts** only through the channels a person editing a live design has: changing one of the target's settings
 *    (validated exactly as an edit would be) and starting or ending a condition (a fault) on the target.
 *
 * So its decisions are deterministic, replayable and visible: they show in its own metrics (`Frame.controllers`), in
 * its probe, and as the edits they made.
 *
 *   export const Autoscaler = Controller.make({
 *     type: "core.target-tracking",
 *     title: "Target tracking",
 *     config: Schema.Struct({ ... }),
 *     make: (ctx) => Effect.sync(() => {
 *       ctx.watch((stats) => ... ctx.set(["concurrency"], next) ...)
 *       return { probe: ... }
 *     })
 *   })
 *
 * A controller is attached in the document (`controllers:`), naming its target node.
 */

export interface Context<Config> {
  /** The controller's id. */
  readonly id: string
  /** The node it controls. */
  readonly target: string
  /** Its own live settings. */
  readonly config: SubscriptionRef.SubscriptionRef<Config>
  readonly fast: {
    readonly settings: () => Config
    readonly now: () => number
    readonly random: SeededRandom
    readonly after: <A>(ms: number, fire: (arg: A) => void, arg: A) => TimerHandle
  }
  /** Hear the target's metrics each frame as they are flushed (`undefined` while it has recorded nothing). */
  readonly watch: (listener: (stats: Stats | undefined, t: number) => Effect.Effect<void>) => Effect.Effect<void, never, Scope.Scope>
  /** The target's settings right now, as on disk: durations in milliseconds, every field filled in. */
  readonly settings: () => Readonly<Record<string, unknown>>
  /**
   * Change one of the target's settings, as an edit in the editor would: validated against the target's schema and
   * applied at once. Fails with the problems if the value was refused.
   */
  readonly set: (path: ReadonlyArray<string>, value: unknown) => Effect.Effect<void, ReadonlyArray<string>>
  /** Start a condition on the target, for `ms` or until cleared. */
  readonly inject: (fault: Fault, ms?: number) => Effect.Effect<ActiveFault>
  readonly clear: (fault: string) => Effect.Effect<boolean>
  /** Its own metrics: what it tracks, what it set. They arrive in frames under `controllers`. */
  readonly meter: Meter
  /** Say what it decided and why. The newest are kept for its probe. */
  readonly log: (decision: string) => void
  readonly spawn: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<void, never, Scope.Scope>
}

export interface Instance<State = unknown> {
  readonly probe?: Effect.Effect<State>
}

export type Settings = Schema.Struct<Schema.Struct.Fields>

/** A problem with an attachment. */
export interface Issue {
  readonly level: "error" | "warning"
  readonly message: string
}

export const error = (message: string): Issue => ({ level: "error", message })
export const warning = (message: string): Issue => ({ level: "warning", message })

export interface ControllerDef<C extends Settings = Settings, S extends Schema.Top = Schema.Top> {
  /** Unique id, namespaced: `core.target-tracking`. */
  readonly type: string
  /** `core` for the built-in ones, otherwise the provider that defines it. */
  readonly provider: string
  readonly title: string
  readonly description: string
  readonly icon: string
  readonly docs: string | undefined
  /** The component types it can control. Absent: any. */
  readonly targets: ReadonlyArray<string> | undefined
  readonly config: C
  readonly state: S
  /**
   * What is wrong with attaching it to `target` with `config`, as plain sentences (a setting it would change that the
   * target doesn't have, say). Checked when the design is read, so a bad attachment is a diagnostic, not a crash. An
   * error stops the design running; a warning (something not configured yet) doesn't.
   */
  readonly check: (target: AnyComponent, config: C["Type"]) => ReadonlyArray<Issue>
  readonly make: (ctx: Context<C["Type"]>) => Effect.Effect<Instance<S["Type"]>, never, Scope.Scope>
}

export interface Input<C extends Settings, S extends Schema.Top> {
  readonly type: string
  readonly provider?: string
  readonly title: string
  readonly description?: string
  readonly icon?: string
  readonly docs?: string
  readonly targets?: ReadonlyArray<string>
  readonly config: C
  readonly state?: S
  readonly check?: ControllerDef<C, S>["check"]
  readonly make: ControllerDef<C, S>["make"]
}

export const make = <const C extends Settings, const S extends Schema.Top = Schema.Struct<{}>>(input: Input<C, S>): ControllerDef<C, S> => ({
  type: input.type,
  provider: input.provider ?? "core",
  title: input.title,
  description: input.description ?? "",
  icon: input.icon ?? "charts",
  docs: input.docs,
  targets: input.targets,
  config: input.config,
  state: (input.state ?? Schema.Struct({})) as S,
  check: input.check ?? (() => []),
  make: input.make
})

/** A controller with its type parameters erased, as registries hold them. */
// biome-ignore lint/suspicious/noExplicitAny: variance: a controller is only ever invoked with values it decoded itself.
export type AnyController = ControllerDef<any, any>

/** Whether a controller can be attached to a component. */
export const fits = (c: Pick<AnyController, "targets">, component: string): boolean => c.targets === undefined || c.targets.includes(component)

/** The serialisable description of a controller, for UIs and tools that never run it. */
export interface Manifest {
  readonly type: string
  readonly provider: string
  readonly title: string
  readonly description: string
  readonly icon: string
  readonly docs: string | undefined
  readonly targets: ReadonlyArray<string> | undefined
  readonly settings: ReadonlyArray<Describe.FieldSpec>
}

export const manifestOf = (c: AnyController): Manifest => ({
  type: c.type,
  provider: c.provider,
  title: c.title,
  description: c.description,
  icon: c.icon,
  docs: c.docs,
  targets: c.targets,
  settings: Describe.fields(c.config)
})

// ---------------------------------------------------------------------------------------------------------
// Helpers for controllers that read a metric and change a number
// ---------------------------------------------------------------------------------------------------------

/** The value at `path` in a settings object, or `undefined`. */
export const valueAt = (settings: Readonly<Record<string, unknown>>, path: ReadonlyArray<string>): unknown => {
  let at: unknown = settings
  for (const key of path) {
    if (typeof at !== "object" || at === null) return undefined
    at = (at as Record<string, unknown>)[key]
  }
  return at
}

/** A dotted path (`capacity.write`) as its parts. Empty parts are dropped. */
export const pathOf = (dotted: string): ReadonlyArray<string> => dotted.split(".").map((s) => s.trim()).filter((s) => s !== "")

/** The form field a dotted path names in a component's settings, if there is one. */
export const fieldAt = (fields: ReadonlyArray<Describe.FieldSpec>, path: ReadonlyArray<string>): Describe.FieldSpec | undefined => {
  let level = fields
  let found: Describe.FieldSpec | undefined
  for (const key of path) {
    found = level.find((f) => f.key === key)
    if (found === undefined) return undefined
    level = found.kind === "group" ? found.fields : []
  }
  return found
}
