/**
 * A union that looks before it tries. `Schema.Union` tries every member that might match and reports every member's
 * failure, so a bad queue in a template also says "or it could have been some other resource". `dispatch` picks the one
 * member that applies by a cheap look at the input (its `Type`, whether it has `Resources`) and reports only that
 * member's problems, or one clear message when nothing applies.
 */
import { Effect, Predicate, Schema, SchemaIssue, SchemaParser, SchemaTransformation } from "effect"

/** Decode with the member `pick` chooses; encode with whichever member the value fits. */
export const dispatch = <const Members extends ReadonlyArray<Schema.Codec<unknown, unknown>>>(
  members: Members,
  pick: (input: unknown) => Members[number] | undefined,
  /** What was expected, for input no member applies to: "a design or a CloudFormation template". */
  expected: string
): Schema.Codec<Members[number]["Type"], unknown> => {
  const union = Schema.Union(members)
  return Schema.Unknown.pipe(
    Schema.decodeTo(
      Schema.toType(union),
      SchemaTransformation.transformEffect({
        decode: (input, options) => {
          const member = pick(input)
          return member === undefined
            ? Effect.fail(new SchemaIssue.InvalidValue({ expected }, input, options))
            : SchemaParser.decodeUnknownEffect(member)(input, options)
        },
        encode: (value, options) => SchemaParser.encodeUnknownEffect(union)(value, options)
      })
    )
  ) as Schema.Codec<Members[number]["Type"], unknown>
}

/** The value of `key` on an object input, for choosing a member by a discriminator such as `Type`. */
export const field = (input: unknown, key: string): unknown => (Predicate.hasProperty(input, key) ? input[key] : undefined)
