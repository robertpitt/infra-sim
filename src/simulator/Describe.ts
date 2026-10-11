import { Duration, Schema, SchemaAST } from "effect"
import type { Form, LimitInfo } from "./Setting.ts"
import { FORM } from "./Setting.ts"

/**
 * A serialisable description of a settings schema, for UIs that render a form.
 *
 * It is derived from the `Schema` itself (its AST, the `form` annotation `Setting` attaches, and the values
 * you get by decoding `{}`), so there is no second declaration to keep in sync, and a UI needs to know nothing
 * about Effect to use it. Durations are described in milliseconds.
 */

interface Base {
  readonly key: string
  readonly label: string
  readonly help?: string
}

export interface NumberField extends Base {
  readonly kind: "int" | "number" | "duration"
  readonly default: number
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly unit?: string
  readonly display?: "percent"
  /** Set when the bounds mirror a provider's published limit: whether it is a hard limit or an adjustable quota. */
  readonly limit?: LimitInfo
}
export interface BooleanField extends Base {
  readonly kind: "boolean"
  readonly default: boolean
}
export interface ChoiceField extends Base {
  readonly kind: "choice"
  readonly default: string
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>
}
export interface TextField extends Base {
  readonly kind: "text"
  readonly default: string
  readonly placeholder?: string
}
export interface GroupField extends Base {
  readonly kind: "group"
  readonly fields: ReadonlyArray<FieldSpec>
}
export type FieldSpec = NumberField | BooleanField | ChoiceField | TextField | GroupField

export const humanize = (key: string): string => {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** The values you get when every field takes its default. */
export const defaultsOf = (schema: Schema.Top): Record<string, unknown> => {
  try {
    return Schema.decodeUnknownSync(schema as Schema.Decoder<unknown>)({}) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Describe a struct schema as a list of form fields. Fields it can't classify are left out. */
export const fields = (schema: Schema.Top): ReadonlyArray<FieldSpec> => {
  const ast = SchemaAST.toType(schema.ast)
  return SchemaAST.isObjects(ast) ? describeObject(ast, defaultsOf(schema)) : []
}

const describeObject = (ast: SchemaAST.Objects, defaults: Record<string, unknown>): ReadonlyArray<FieldSpec> =>
  ast.propertySignatures.flatMap((ps) => {
    const spec = describe(String(ps.name), ps.type, defaults[String(ps.name)])
    return spec === undefined ? [] : [spec]
  })

const describe = (key: string, ast: SchemaAST.AST, value: unknown): FieldSpec | undefined => {
  const form = (SchemaAST.resolve(ast) as Record<string, unknown> | undefined)?.[FORM] as Form | undefined
  const base = {
    key,
    label: form?.label ?? humanize(key),
    ...(form?.help === undefined ? {} : { help: form.help })
  }

  if (SchemaAST.isObjects(ast)) {
    return { ...base, kind: "group", fields: describeObject(ast, (value ?? {}) as Record<string, unknown>) }
  }
  if (SchemaAST.isBoolean(ast)) return { ...base, kind: "boolean", default: value === true }
  if (SchemaAST.isString(ast) && form?.kind === "text") {
    return { ...base, kind: "text", default: typeof value === "string" ? value : "", ...(form.placeholder === undefined ? {} : { placeholder: form.placeholder }) }
  }
  if (SchemaAST.isUnion(ast) && ast.types.every(SchemaAST.isLiteral)) {
    const labels = form?.kind === "choice" ? form.labels : undefined
    return {
      ...base,
      kind: "choice",
      default: String(value),
      options: ast.types.map((t) => {
        const v = String((t as SchemaAST.Literal).literal)
        return { value: v, label: labels?.[v] ?? humanize(v) }
      })
    }
  }
  if (SchemaAST.isNumber(ast)) {
    const f = form !== undefined && (form.kind === "int" || form.kind === "number") ? form : undefined
    return {
      ...base,
      kind: f?.kind ?? "number",
      default: typeof value === "number" ? value : 0,
      ...(f?.min === undefined ? {} : { min: f.min }),
      ...(f?.max === undefined ? {} : { max: f.max }),
      ...(f?.step === undefined ? {} : { step: f.step }),
      ...(f?.unit === undefined ? {} : { unit: f.unit }),
      ...(f?.display === undefined ? {} : { display: f.display }),
      ...(f?.limit === undefined ? {} : { limit: f.limit })
    }
  }
  if (SchemaAST.isDeclaration(ast) && form?.kind === "duration") {
    return {
      ...base,
      kind: "duration",
      default: Duration.isDuration(value) ? Duration.toMillis(value) : 0,
      unit: "ms",
      ...(form.min === undefined ? {} : { min: form.min }),
      ...(form.max === undefined ? {} : { max: form.max }),
      ...(form.limit === undefined ? {} : { limit: form.limit })
    }
  }
  return undefined
}
