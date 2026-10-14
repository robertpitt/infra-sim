/**
 * The schema issues the codecs raise themselves, so every stage reports problems the same way a schema does: with a
 * message and, where it has one, a path.
 */
import { type SchemaAST, SchemaIssue } from "effect"

/** Text that isn't YAML or JSON. The message is the parser's first line, which says where. */
export const InvalidText = (text: string, error: unknown, options: SchemaAST.ParseOptions): SchemaIssue.Issue =>
  new SchemaIssue.InvalidValue(
    { message: `not valid YAML or JSON: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}` },
    text,
    options
  )

/** A value a transformation can't map, such as a reference to a resource the template doesn't have. */
export const Invalid = (input: unknown, message: string, options?: SchemaAST.ParseOptions): SchemaIssue.Issue =>
  new SchemaIssue.InvalidValue({ message }, input, options)
