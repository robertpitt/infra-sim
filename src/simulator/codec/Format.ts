/**
 * The first stage of every codec: text to data and back. YAML is a superset of JSON, so one codec reads both; a source
 * that has its own YAML tags (CloudFormation's `!Ref`) passes them in. Nothing past this stage sees text.
 */
import { Effect, Schema, SchemaTransformation } from "effect"
import YAML, { type Tags } from "yaml"
import { InvalidText } from "./internal/issues.ts"

export interface YamlOptions {
  /** Custom tags to read, such as CloudFormation's short forms. */
  readonly tags?: Tags
}

/** A codec from YAML or JSON text to the data it holds, and back to YAML. */
export const yaml = (options: YamlOptions = {}): Schema.Codec<unknown, string> =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.Unknown,
      SchemaTransformation.transformEffect({
        decode: (text, parse) =>
          Effect.try({
            try: () => YAML.parse(text, { customTags: options.tags ?? null, schema: "core", maxAliasCount: -1 }) as unknown,
            catch: (error) => InvalidText(text, error, parse)
          }),
        encode: (value) => Effect.succeed(YAML.stringify(value, { lineWidth: 0 }))
      })
    )
  )

/** YAML or JSON, with no custom tags. */
export const Yaml: Schema.Codec<unknown, string> = yaml()
