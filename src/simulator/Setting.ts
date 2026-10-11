import { Duration, Effect, Option, Schema, SchemaIssue, SchemaTransformation } from "effect"

/**
 * Setting constructors: ordinary `Schema`s plus a little UI metadata.
 *
 * A component's configuration is just a `Schema.Struct` of these. The same declaration gives you
 *  - validation with readable errors (`Expected a value between 1 and 1000`);
 *  - defaults, filled in when JSON omits a field, so saved designs survive a component growing a setting;
 *  - a codec: JSON on disk <-> typed values (`"30 seconds"` or `30000` <-> a `Duration`);
 *  - a form description for UIs (see `Describe`), read from the schema itself rather than declared twice.
 *
 *   Schema.Struct({
 *     concurrency: Setting.int({ default: 10, min: 1, max: 1000, unit: "workers" }),
 *     timeout: Setting.duration({ default: "30 seconds", min: "1 second" }),
 *     routing: Setting.choice(["all", "weighted"], { default: "all" })
 *   })
 */

/**
 * Where a bound comes from, for settings that mirror a provider's published limits.
 *  - `hard`: the service enforces it and nobody can change it. The setting's min/max are the limit.
 *  - `quota`: a default the provider will raise on request. The setting is editable; its default is the published default.
 */
export interface LimitInfo {
  readonly kind: "hard" | "quota"
  /** Documentation page the number comes from. */
  readonly source?: string
  readonly note?: string
}

/** UI metadata, attached to a schema under the `form` annotation. */
export type Form =
  | {
    readonly kind: "int" | "number"
    readonly label?: string
    readonly help?: string
    readonly unit?: string
    readonly min?: number
    readonly max?: number
    readonly step?: number
    /** Show a 0..1 value as 0..100%. */
    readonly display?: "percent"
    readonly limit?: LimitInfo
  }
  | {
    readonly kind: "duration"
    readonly label?: string
    readonly help?: string
    readonly min?: number
    readonly max?: number
    readonly limit?: LimitInfo
  }
  | { readonly kind: "boolean"; readonly label?: string; readonly help?: string }
  | { readonly kind: "choice"; readonly label?: string; readonly help?: string; readonly labels?: Readonly<Record<string, string>> }
  | { readonly kind: "group"; readonly label?: string; readonly help?: string }

export const FORM = "form"

const annotated = <S extends Schema.Top>(schema: S, form: Form): S => schema.pipe(Schema.annotate({ [FORM]: form })) as S

interface Common {
  readonly label?: string
  readonly help?: string
}
const common = (o: Common) => ({
  ...(o.label === undefined ? {} : { label: o.label }),
  ...(o.help === undefined ? {} : { help: o.help })
})

// ---------------------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------------------

export interface NumberOptions extends Common {
  readonly limit?: LimitInfo
  readonly default: number
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly unit?: string
}

const range = (min: number | undefined, max: number | undefined) =>
  min !== undefined && max !== undefined
    ? Schema.isBetween({ minimum: min, maximum: max })
    : min !== undefined
    ? Schema.isGreaterThanOrEqualTo(min)
    : max !== undefined
    ? Schema.isLessThanOrEqualTo(max)
    : undefined

const numeric = (kind: "int" | "number", o: NumberOptions & { readonly display?: "percent" }): Schema.withDecodingDefault<Schema.Number> => {
  const base: Schema.Number = kind === "int" ? Schema.Int : Schema.Finite
  const check = range(o.min, o.max)
  const checked = check === undefined ? base : base.pipe(Schema.check(check))
  return annotated(checked.pipe(Schema.withDecodingDefault(Effect.succeed(o.default))), {
    kind,
    ...common(o),
    ...(o.unit === undefined ? {} : { unit: o.unit }),
    ...(o.min === undefined ? {} : { min: o.min }),
    ...(o.max === undefined ? {} : { max: o.max }),
    ...(o.step === undefined ? {} : { step: o.step }),
    ...(o.display === undefined ? {} : { display: o.display }),
    ...(o.limit === undefined ? {} : { limit: o.limit })
  })
}

/** Shorthands for settings that mirror a published provider limit. */
export const hard = (source?: string, note?: string): LimitInfo => ({ kind: "hard", ...(source === undefined ? {} : { source }), ...(note === undefined ? {} : { note }) })
export const quota = (source?: string, note?: string): LimitInfo => ({ kind: "quota", ...(source === undefined ? {} : { source }), ...(note === undefined ? {} : { note }) })

/** A whole number. */
export const int = (o: NumberOptions) => numeric("int", o)
/** Any finite number. */
export const number = (o: NumberOptions) => numeric("number", o)
/** A 0..1 probability or fraction, shown as a percentage. */
export const ratio = (o: Common & { readonly default: number }) =>
  numeric("number", { min: 0, max: 1, step: 0.01, ...o, display: "percent" })

export const bool = (o: Common & { readonly default: boolean }): Schema.withDecodingDefault<Schema.Boolean> =>
  annotated(Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(o.default))), { kind: "boolean", ...common(o) })

export const choice = <const L extends ReadonlyArray<string>>(
  options: L,
  o: Common & { readonly default: L[number]; readonly labels?: Partial<Record<L[number], string>> }
): Schema.withDecodingDefault<Schema.Literals<L>> =>
  annotated(Schema.Literals(options).pipe(Schema.withDecodingDefault(Effect.succeed(o.default))) as unknown as Schema.withDecodingDefault<Schema.Literals<L>>, {
    kind: "choice",
    ...common(o),
    ...(o.labels === undefined ? {} : { labels: o.labels as Readonly<Record<string, string>> })
  })

// ---------------------------------------------------------------------------------------------------------
// Durations: `Duration` in memory; a number of milliseconds or a string like "30 seconds" on disk.
// ---------------------------------------------------------------------------------------------------------

const DurationInput = Schema.Union([Schema.Number, Schema.String]).pipe(
  Schema.decodeTo(
    Schema.Duration,
    SchemaTransformation.transformEffect({
      decode: (input: number | string) =>
        Option.match(Duration.fromInput(input as Duration.Input), {
          onNone: () =>
            Effect.fail(
              new SchemaIssue.InvalidValue({ message: `Expected a duration such as 250 (milliseconds) or "30 seconds"` }, input)
            ),
          onSome: Effect.succeed
        }),
      encode: (duration: Duration.Duration) => Effect.succeed(Duration.toMillis(duration))
    })
  )
)

export interface DurationOptions extends Common {
  readonly limit?: LimitInfo
  readonly default: Duration.Input
  readonly min?: Duration.Input
  readonly max?: Duration.Input
}

const millis = (input: Duration.Input): number => Duration.toMillis(Duration.fromInputUnsafe(input))

export type DurationField = Schema.withDecodingDefault<Schema.Codec<Duration.Duration, number | string>>

export const duration = (o: DurationOptions): DurationField => {
  const min = o.min === undefined ? undefined : millis(o.min)
  const max = o.max === undefined ? undefined : millis(o.max)
  const checked = min === undefined && max === undefined
    ? DurationInput
    : DurationInput.pipe(
      Schema.check(
        Schema.makeFilter((d: Duration.Duration) => {
          const ms = Duration.toMillis(d)
          if (min !== undefined && ms < min) return `Expected a duration of at least ${Duration.format(Duration.millis(min))}`
          if (max !== undefined && ms > max) return `Expected a duration of at most ${Duration.format(Duration.millis(max))}`
          return undefined
        })
      )
    )
  return annotated(checked.pipe(Schema.withDecodingDefault(Effect.succeed(millis(o.default)))) as unknown as DurationField, {
    kind: "duration",
    ...common(o),
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(o.limit === undefined ? {} : { limit: o.limit })
  })
}

// ---------------------------------------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------------------------------------

/** A nested struct, filled with its own defaults when absent. Shown as a labelled section. */
export const group = <const Fields extends Schema.Struct.Fields>(
  fields: Fields,
  o: Common = {}
): Schema.withDecodingDefault<Schema.Struct<Fields>> =>
  annotated(Schema.Struct(fields).pipe(Schema.withDecodingDefault(Effect.succeed({} as never))), { kind: "group", ...common(o) })

/** Mean plus coefficient of variation: how long something takes, and how much that varies (lognormal). */
export const latency = (o: { readonly mean: Duration.Input; readonly cv?: number } & Common) =>
  group(
    {
      mean: duration({ default: o.mean, min: 0, max: "10 minutes", label: "Average", help: "Typical time taken" }),
      cv: number({
        default: o.cv ?? 0.3,
        min: 0,
        max: 3,
        step: 0.05,
        label: "Variability",
        help: "Coefficient of variation: 0 is constant, 1 is heavily spread"
      })
    },
    common(o)
  )

export interface Latency {
  readonly mean: Duration.Duration
  readonly cv: number
}
