import YAML from "yaml"

/**
 * Reading a CloudFormation template: its YAML (with the short `!Ref` forms), and its intrinsic functions.
 *
 * A template says "the queue's ARN" with `!GetAtt Queue.Arn` and "256 unless the stage is prod" with `!If`. Most of
 * that can be worked out from the template alone (parameter defaults, mappings, conditions); some can't (values
 * imported from another stack, computed at deploy time). The evaluator resolves what it can and marks the rest
 * `Unresolved`, so callers keep a component's default and say so, instead of guessing.
 */

/** A reference to another resource in the template: `!Ref Queue` or `!GetAtt Queue.Arn`. */
export class Reference {
  constructor(readonly id: string, readonly attribute?: string) {}
}

/** A value that can't be known from the template. */
export class Unresolved {
  constructor(readonly reason: string) {}
}

/** `AWS::NoValue`: the property is not set. */
const NO_VALUE = Symbol("AWS::NoValue")

export const isReference = (v: unknown): v is Reference => v instanceof Reference
export const isUnresolved = (v: unknown): v is Unresolved => v instanceof Unresolved

// ---------------------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------------------

const SHORT_FORMS = [
  "Ref", "Condition", "GetAtt", "Sub", "Join", "Select", "Split", "If", "Equals", "Not", "And", "Or", "FindInMap",
  "ImportValue", "Base64", "Cidr", "GetAZs", "Transform", "Length", "ToJsonString", "ForEach"
] as const

const longName = (short: string): string => (short === "Ref" || short === "Condition" ? short : `Fn::${short}`)

// `!Ref x` becomes `{ Ref: x }`, `!Join [",", [...]]` becomes `{ "Fn::Join": [...] }`: the long form every template can use.
// biome-ignore lint/suspicious/noExplicitAny: the YAML library's tag types are looser than they claim.
const customTags: Array<any> = SHORT_FORMS.flatMap((short) => [
  { tag: `!${short}`, resolve: (value: string) => ({ [longName(short)]: value }) },
  { tag: `!${short}`, collection: "seq", resolve: (seq: { toJSON(): unknown }) => ({ [longName(short)]: seq.toJSON() }) },
  { tag: `!${short}`, collection: "map", resolve: (map: { toJSON(): unknown }) => ({ [longName(short)]: map.toJSON() }) }
])

/** Parse a template written as YAML or JSON. Throws with the reason if it isn't one. */
export const parseTemplate = (text: string): Record<string, unknown> => {
  const parsed = YAML.parse(text, { customTags, schema: "core", maxAliasCount: -1 })
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not a mapping")
  return parsed as Record<string, unknown>
}

// ---------------------------------------------------------------------------------------------------------
// Evaluating
// ---------------------------------------------------------------------------------------------------------

export interface Environment {
  /** Parameter values: the template's defaults, unless overridden. A parameter with no default is absent. */
  readonly parameters: Readonly<Record<string, unknown>>
  readonly mappings: Readonly<Record<string, unknown>>
  readonly conditions: Readonly<Record<string, unknown>>
  readonly region: string
  readonly stackName: string
}

const PSEUDO = new Set(["AWS::Region", "AWS::StackName", "AWS::AccountId", "AWS::Partition", "AWS::URLSuffix", "AWS::StackId", "AWS::NoValue", "AWS::NotificationARNs"])

export class Evaluator {
  private readonly conditionCache = new Map<string, boolean | Unresolved>()

  constructor(private readonly env: Environment) {}

  /** Resolve every intrinsic function in a value, as far as the template alone allows. */
  value(v: unknown): unknown {
    if (Array.isArray(v)) return v.map((x) => this.value(x)).filter((x) => x !== NO_VALUE)
    if (typeof v !== "object" || v === null) return v
    const entries = Object.entries(v)
    if (entries.length === 1) {
      const [key, arg] = entries[0]!
      const handled = this.intrinsic(key, arg)
      if (handled !== undefined) return handled
    }
    const out: Record<string, unknown> = {}
    for (const [k, x] of entries) {
      const r = this.value(x)
      if (r !== NO_VALUE) out[k] = r
    }
    return out
  }

  /** A named condition from the template's `Conditions` section, evaluated against the parameter values. */
  condition(name: string): boolean | Unresolved {
    const cached = this.conditionCache.get(name)
    if (cached !== undefined) return cached
    this.conditionCache.set(name, new Unresolved(`condition ${name} refers to itself`)) // guards against a cycle
    const raw = this.env.conditions[name]
    const result = raw === undefined ? new Unresolved(`no condition named ${name}`) : this.truth(this.value(raw))
    this.conditionCache.set(name, result)
    return result
  }

  private truth(v: unknown): boolean | Unresolved {
    if (typeof v === "boolean") return v
    if (typeof v === "string" && (v === "true" || v === "false")) return v === "true"
    return isUnresolved(v) ? v : new Unresolved("not a condition")
  }

  /** `undefined` when `key` is not an intrinsic, so the caller treats the object as plain data. */
  private intrinsic(key: string, arg: unknown): unknown {
    switch (key) {
      case "Ref":
        return this.ref(String(arg))
      case "Condition":
        return this.condition(String(arg))
      case "Fn::GetAtt": {
        const [id, ...rest] = Array.isArray(arg) ? arg.map(String) : String(arg).split(".")
        return new Reference(id!, rest.join(".") || undefined)
      }
      case "Fn::Sub":
        return this.sub(arg)
      case "Fn::Join": {
        if (!Array.isArray(arg) || arg.length !== 2) return new Unresolved("malformed Fn::Join")
        const list = this.value(arg[1])
        const delimiter = this.value(arg[0])
        if (!Array.isArray(list) || typeof delimiter !== "string") return new Unresolved("Fn::Join of something not known until deploy")
        const parts = list.map((x) => text(x))
        return parts.some((p) => p === undefined) ? new Unresolved("Fn::Join of something not known until deploy") : parts.join(delimiter)
      }
      case "Fn::Select": {
        if (!Array.isArray(arg)) return new Unresolved("malformed Fn::Select")
        const index = Number(this.value(arg[0]))
        const list = this.value(arg[1])
        return Array.isArray(list) && index in list ? list[index] : new Unresolved("Fn::Select of something not known until deploy")
      }
      case "Fn::Split": {
        if (!Array.isArray(arg)) return new Unresolved("malformed Fn::Split")
        const source = this.value(arg[1])
        return typeof source === "string" ? source.split(String(this.value(arg[0]))) : new Unresolved("Fn::Split of something not known until deploy")
      }
      case "Fn::If": {
        if (!Array.isArray(arg) || arg.length !== 3) return new Unresolved("malformed Fn::If")
        const test = this.condition(String(arg[0]))
        if (isUnresolved(test)) return test
        return this.value(test ? arg[1] : arg[2])
      }
      case "Fn::Equals": {
        if (!Array.isArray(arg)) return new Unresolved("malformed Fn::Equals")
        const [a, b] = [this.value(arg[0]), this.value(arg[1])]
        if (isUnresolved(a)) return a
        if (isUnresolved(b)) return b
        return String(a) === String(b)
      }
      case "Fn::Not": {
        const [x] = Array.isArray(arg) ? arg : [arg]
        const t = this.truth(this.value(x))
        return isUnresolved(t) ? t : !t
      }
      case "Fn::And":
      case "Fn::Or": {
        const results = (Array.isArray(arg) ? arg : []).map((x) => this.truth(this.value(x)))
        const unknown = results.find(isUnresolved)
        if (unknown !== undefined) return unknown
        return key === "Fn::And" ? results.every(Boolean) : results.some(Boolean)
      }
      case "Fn::FindInMap": {
        if (!Array.isArray(arg) || arg.length !== 3) return new Unresolved("malformed Fn::FindInMap")
        const [m, k1, k2] = arg.map((x) => String(this.value(x)))
        const found = (this.env.mappings[m!] as Record<string, Record<string, unknown>> | undefined)?.[k1!]?.[k2!]
        return found === undefined ? new Unresolved(`no mapping ${m}/${k1}/${k2}`) : this.value(found)
      }
      case "Fn::Base64":
        return this.value(arg)
      case "Fn::ToJsonString": {
        const v = this.value(arg)
        return isUnresolved(v) ? v : JSON.stringify(v)
      }
      case "Fn::Length": {
        const v = this.value(arg)
        return Array.isArray(v) ? v.length : new Unresolved("Fn::Length of something not known until deploy")
      }
      case "Fn::GetAZs":
        return ["a", "b", "c"].map((z) => `${this.env.region}${z}`)
      case "Fn::ImportValue":
        return new Unresolved("exported by another stack")
      case "Fn::Cidr":
      case "Fn::Transform":
      case "Fn::ForEach":
        return new Unresolved(`${key} is expanded at deploy time`)
      default:
        return undefined
    }
  }

  private ref(name: string): unknown {
    if (PSEUDO.has(name)) {
      switch (name) {
        case "AWS::Region": return this.env.region
        case "AWS::StackName": return this.env.stackName
        case "AWS::AccountId": return "123456789012"
        case "AWS::Partition": return "aws"
        case "AWS::URLSuffix": return "amazonaws.com"
        case "AWS::StackId": return `arn:aws:cloudformation:${this.env.region}:123456789012:stack/${this.env.stackName}/00000000`
        case "AWS::NoValue": return NO_VALUE
        default: return new Unresolved(`${name} is known at deploy time`)
      }
    }
    if (name in this.env.parameters) return this.env.parameters[name]
    // A parameter without a default is a parameter, not a resource, but it is not known here either.
    if (this.parameterNames.has(name)) return new Unresolved(`parameter ${name} has no default`)
    return new Reference(name)
  }

  /** Names of every declared parameter, so a missing default is told apart from a reference to a resource. */
  readonly parameterNames = new Set<string>()

  private sub(arg: unknown): unknown {
    const [template, vars] = Array.isArray(arg) ? [arg[0], (arg[1] ?? {}) as Record<string, unknown>] : [arg, {}]
    if (typeof template !== "string") return new Unresolved("malformed Fn::Sub")
    let unresolved: Unresolved | undefined
    const out = template.replace(/\$\{([^}]*)\}/g, (_, name: string) => {
      if (name.startsWith("!")) return `\${${name.slice(1)}}` // ${!Literal}
      const v = name in vars ? this.value(vars[name]) : this.ref(name.split(".")[0]!)
      if (isUnresolved(v)) {
        unresolved ??= v
        return ""
      }
      // A resource stays in the string as `${Id}` or `${Id.Attribute}`, so callers can still see what it points at.
      if (isReference(v)) return `\${${name in vars ? v.id + (v.attribute ? `.${v.attribute}` : "") : name}}`
      return text(v) ?? ""
    })
    return unresolved ?? out
  }
}

/** A scalar as text; a reference as its `${Id.Attribute}` token; `undefined` for things with no text form. */
const text = (v: unknown): string | undefined => {
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  if (isReference(v)) return `\${${v.id}${v.attribute ? `.${v.attribute}` : ""}}`
  return undefined
}

// ---------------------------------------------------------------------------------------------------------
// Reading values
// ---------------------------------------------------------------------------------------------------------

/** A number, from a number or a numeric string. */
export const asNumber = (v: unknown): number | undefined => {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

export const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)

export const asBoolean = (v: unknown): boolean | undefined => {
  if (typeof v === "boolean") return v
  if (v === "true") return true
  if (v === "false") return false
  return undefined
}

/** Every resource a value points at: references, and `${Id}` tokens left in strings. In the order first seen, once each. */
export const referencesIn = (v: unknown): ReadonlyArray<string> => {
  const found = new Set<string>()
  const walk = (x: unknown): void => {
    if (isReference(x)) found.add(x.id)
    else if (typeof x === "string") {
      for (const m of x.matchAll(/\$\{([A-Za-z0-9]+)(?:\.[A-Za-z0-9.]+)?\}/g)) found.add(m[1]!)
    } else if (Array.isArray(x)) x.forEach(walk)
    else if (typeof x === "object" && x !== null) Object.values(x).forEach(walk)
  }
  walk(v)
  return [...found]
}
