import { ASSERTION_SYNTAX } from "./Check.ts"
import * as Connector from "./Connector.ts"
import * as Describe from "./Describe.ts"
import * as Fault from "./Fault.ts"
import type { Components } from "./Registry.ts"

/**
 * JSON Schemas for the files people write: designs (`design.schema.json`) and scenario files (`scenario.schema.json`).
 *
 * They are generated from the registry, the same way the app's forms are (`Describe`), so they can't drift from the
 * components: a node's `settings` are checked against its `type`'s own settings, with their ranges, defaults, units and
 * help text; an edge's against everything that can sit on an edge; a controller's against its `type`. Point an editor
 * at them (a `# yaml-language-server: $schema=...` line, or `$schema` in JSON) and it completes, explains and checks a
 * design as you type. What a schema can't express (an edge to a node that doesn't exist, a scenario naming one) is
 * still checked by `infra-sim check` and the app.
 *
 * Draft-07, the dialect every editor supports.
 */

export const SCHEMA_BASE_URL = "https://robertpitt.github.io/infra-sim/schema/"
export const DESIGN_SCHEMA_URL = `${SCHEMA_BASE_URL}design.schema.json`
export const SCENARIO_SCHEMA_URL = `${SCHEMA_BASE_URL}scenario.schema.json`

/** The line that tells the YAML language server (VS Code, the app's editor) which schema a file follows. */
export const yamlModeline = (url: string = DESIGN_SCHEMA_URL): string => `# yaml-language-server: $schema=${url}`

export type JsonSchema = { readonly [key: string]: unknown }

/**
 * A design as a file: YAML starts with the line that points editors at the schema; JSON names it in `$schema`, as JSON
 * files do. Either way the reference is the published schema, so a file works wherever it is saved.
 */
export const fileText = (doc: { readonly $schema?: string }, format: "yaml" | "json", stringify: (value: unknown) => string): string => {
  const { $schema: _old, ...rest } = doc
  return format === "json" ? `${JSON.stringify({ $schema: DESIGN_SCHEMA_URL, ...rest }, null, 2)}\n` : `${yamlModeline()}\n${stringify(rest)}`
}

// ---------------------------------------------------------------------------------------------------------
// Settings, from their descriptions
// ---------------------------------------------------------------------------------------------------------

/** A setting's duration: milliseconds, or text Effect reads (`250 millis`, `30 seconds`, `2 minutes`). */
const SETTING_DURATION_PATTERN = "^-?\\d+(\\.\\d+)?\\s+(nanos?|micros?|millis?|seconds?|minutes?|hours?|days?|weeks?)$"

const sentence = (...parts: ReadonlyArray<string | undefined>): string | undefined => {
  const text = parts.filter((p) => p !== undefined && p !== "").join(" ")
  return text === "" ? undefined : text
}

const limitNote = (f: Describe.NumberField): string | undefined =>
  f.limit === undefined ? undefined : f.limit.kind === "hard" ? "A hard limit of the provider." : "The provider's default quota; it can be raised."

/** One setting, described for an editor: what it is, its range and default, and what it means. */
export const settingSchema = (f: Describe.FieldSpec): JsonSchema => {
  const titled = (description: string | undefined, rest: JsonSchema): JsonSchema => ({ title: f.label, ...(description === undefined ? {} : { description }), ...rest })
  switch (f.kind) {
    case "group":
      return titled(f.help, { type: "object", properties: settingsProperties(f.fields), additionalProperties: false })
    case "boolean":
      return titled(f.help, { type: "boolean", default: f.default })
    case "text":
      return titled(f.help, { type: "string", default: f.default })
    case "choice":
      return titled(sentence(f.help, `One of: ${f.options.map((o) => `${o.value} (${o.label})`).join(", ")}.`), { enum: f.options.map((o) => o.value), default: f.default })
    case "duration":
      return titled(sentence(f.help, "A duration: a number of milliseconds, or text such as \"30 seconds\" or \"2 minutes\".", limitNote(f)), {
        default: f.default,
        anyOf: [
          { type: "number", ...(f.min === undefined ? {} : { minimum: f.min }), ...(f.max === undefined ? {} : { maximum: f.max }) },
          { type: "string", pattern: SETTING_DURATION_PATTERN }
        ]
      })
    case "int":
    case "number":
      return titled(sentence(f.help, f.display === "percent" ? "A fraction: 0.25 is 25%." : f.unit === undefined ? undefined : `In ${f.unit}.`, limitNote(f)), {
        type: f.kind === "int" ? "integer" : "number",
        default: f.default,
        ...(f.min === undefined ? {} : { minimum: f.min }),
        ...(f.max === undefined ? {} : { maximum: f.max })
      })
  }
}

const settingsProperties = (fields: ReadonlyArray<Describe.FieldSpec>): JsonSchema => Object.fromEntries(fields.map((f) => [f.key, settingSchema(f)]))

/** A settings object: only the settings someone changed, so nothing is required, and a key that isn't one is a typo. */
const settingsObject = (description: string, fields: ReadonlyArray<Describe.FieldSpec>): JsonSchema => ({
  type: "object",
  description,
  properties: settingsProperties(fields),
  additionalProperties: false
})

/** A settings schema that applies when an object's `type` is `type`: how a node's or controller's settings follow from it. */
const whenType = (type: string, properties: JsonSchema): JsonSchema => ({
  if: { properties: { type: { const: type } }, required: ["type"] },
  then: { properties }
})

// ---------------------------------------------------------------------------------------------------------
// Scenarios (the shape is `ScenarioSpec.ts`; the descriptions are for people writing one)
// ---------------------------------------------------------------------------------------------------------

/** A scenario's time: a bare number is seconds; text is `90s`, `2m`, `1h30m`, `250ms` or `2 minutes`. */
const SCENARIO_DURATION: JsonSchema = {
  description: "A time: a number of seconds, or text such as 90s, 2m, 1h30m, 250ms or \"2 minutes\".",
  anyOf: [
    { type: "number", minimum: 0 },
    { type: "string", pattern: "^\\s*(\\d+(\\.\\d+)?\\s*(ms|millis|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)\\s*)+$|^\\d+(\\.\\d+)?$" }
  ]
}

const SETTINGS_BAG: JsonSchema = { type: "object", description: "Settings, merged over what it already has." }

const faultSchema = (): JsonSchema => {
  const tags = Fault.catalog.map((k) => k.tag)
  return {
    description: `The fault: ${Fault.catalog.map((k) => `${k.tag} (${k.help})`).join(" ")} Write it as Outage, Slow(250ms), Errors(20%), Loss(10%), or as an object { type: Slow, extra: 250ms }.`,
    anyOf: [
      { type: "string", pattern: `^\\s*(${tags.join("|")})\\s*(\\(.*\\))?\\s*$` },
      { type: "object", required: ["type"], properties: { type: { enum: tags }, extra: SCENARIO_DURATION, rate: { anyOf: [{ type: "number" }, { type: "string" }] } } }
    ]
  }
}

const ASSERT_HELP = `A check that must hold over the run (after the warm-up unless a window is given), in the check language:\n\n${ASSERTION_SYNTAX}`

/** The fields every scenario has, wherever it is written. Kept in step with `ScenarioSpec.fields` by a test. */
export const scenarioProperties = (): JsonSchema => ({
  name: { type: "string", description: "What the scenario is called." },
  description: { type: "string", description: "What it shows. The first paragraph is its short blurb." },
  seed: { type: "integer", description: "Random seed for the run: the same design, scenario and seed always play out the same." },
  duration: { ...SCENARIO_DURATION, description: "How long to run. Required to run it." },
  warmup: { ...SCENARIO_DURATION, description: "Time to let the system settle before measuring: checks and summaries start after it." },
  traffic: {
    type: "object",
    description: "Change every client's traffic.",
    properties: { scale: { type: "number", minimum: 0, description: "Multiply every client's request rate: 3 is three times the traffic." } },
    required: ["scale"],
    additionalProperties: false
  },
  overrides: {
    type: "object",
    description: "Settings applied at the start, merged over the design's own.",
    properties: {
      nodes: { type: "object", description: "By node id.", additionalProperties: { type: "object" } },
      edges: { type: "object", description: "By edge id.", additionalProperties: { type: "object" } },
      accounts: { type: "object", description: "By placement, such as aws:us-east-1.", additionalProperties: { type: "object" } }
    },
    additionalProperties: false
  },
  timeline: {
    type: "array",
    description: "What happens, and when. Each event does one thing; an event with only a note annotates the timeline.",
    items: {
      type: "object",
      required: ["at"],
      properties: {
        at: { ...SCENARIO_DURATION, description: "When it happens, from the start of the run." },
        note: { type: "string", description: "Says what this event is, in the timeline." },
        inject: {
          type: "object",
          description: "Break something.",
          required: ["target", "fault"],
          properties: {
            target: {
              type: "string",
              description: "What breaks: node:<id>, edge:<id>, region:<placement> (region:aws:us-east-1) or zone:<placement>:<zone> (zone:aws:us-east-1:us-east-1a)."
            },
            fault: faultSchema(),
            for: { ...SCENARIO_DURATION, description: "How long it lasts. Without it, the fault lasts until cleared." },
            id: { type: "string", description: "A name to clear it by later." }
          },
          additionalProperties: false
        },
        clear: { type: "string", description: "Lift a fault by the id it was injected with, or all of them (all)." },
        set: {
          type: "object",
          description: "Change a node's or an edge's settings while it runs.",
          required: ["settings"],
          properties: { node: { type: "string", description: "A node id." }, edge: { type: "string", description: "An edge id." }, settings: SETTINGS_BAG },
          additionalProperties: false
        },
        account: {
          type: "object",
          description: "Change the account quotas of a placement while it runs.",
          required: ["placement", "settings"],
          properties: { placement: { type: "string", description: "Such as aws:us-east-1." }, settings: SETTINGS_BAG },
          additionalProperties: false
        }
      },
      additionalProperties: false
    }
  },
  assert: {
    type: "array",
    description: "What must hold. A run passes when every check does.",
    items: {
      anyOf: [
        { type: "string", description: ASSERT_HELP },
        {
          type: "object",
          required: ["check"],
          properties: {
            check: { type: "string", description: ASSERT_HELP },
            name: { type: "string", description: "Says what the check means." },
            from: { ...SCENARIO_DURATION, description: "Measure only from here (default: the end of the warm-up)." },
            to: { ...SCENARIO_DURATION, description: "... to here (default: the end of the run)." }
          },
          additionalProperties: false
        }
      ]
    }
  }
})

// ---------------------------------------------------------------------------------------------------------
// The design
// ---------------------------------------------------------------------------------------------------------

const ORIGIN: JsonSchema = {
  type: "object",
  description: "Where it came from when imported, so a re-import can find and merge it.",
  required: ["source", "ref"],
  properties: { source: { type: "string" }, ref: { type: "string" }, type: { type: "string" } },
  additionalProperties: false
}

const POSITION: JsonSchema = {
  type: "object",
  description: "Where it sits on the canvas. Absent means it is laid out automatically.",
  required: ["x", "y"],
  properties: { x: { type: "number" }, y: { type: "number" } },
  additionalProperties: false
}

/** The schema of a design file, for whatever components the registry holds. */
export const designSchema = (registry: Components): JsonSchema => {
  const components = registry.manifests
  const connectors = registry.connectorManifests
  const controllers = registry.controllerManifests
  const definitions: Record<string, JsonSchema> = {}

  for (const m of components) {
    definitions[`${m.type}.settings`] = settingsObject(`Settings of ${m.title}: only the ones you change; the rest take their defaults.`, m.settings)
  }
  for (const c of controllers) {
    definitions[`${c.type}.settings`] = settingsObject(`Settings of ${c.title}: only the ones you change.`, c.settings)
  }

  // A node's settings and region follow from its type.
  const regionsOf = (provider: string) => registry.providers.find((p) => p.id === provider)?.regions.map((r) => r.id) ?? []
  const byType = components.map((m) =>
    whenType(m.type, {
      settings: { $ref: `#/definitions/${m.type}.settings` },
      ...(regionsOf(m.provider).length === 0 ? {} : { region: { enum: regionsOf(m.provider) } })
    })
  )

  definitions.node = {
    type: "object",
    description: "A component of the design.",
    required: ["type"],
    properties: {
      type: {
        description: `What it is: ${components.map((m) => `${m.type} (${m.title})`).join(", ")}.`,
        enum: components.map((m) => m.type)
      },
      name: { type: "string", description: "What the canvas calls it. Defaults to its id." },
      region: { type: "string", description: "The provider's region it runs in. Absent means the provider's default, or the region box it is in." },
      zone: {
        type: "string",
        description: "The availability zone of its region it lives in (us-east-1a), for a single-zone resource: a zone outage takes it down. Absent for a regional one."
      },
      parent: { type: "string", description: "The id of the container (a region or VPC box) it sits inside." },
      position: POSITION,
      size: {
        type: "object",
        description: "A container's box size, in canvas units.",
        required: ["w", "h"],
        properties: { w: { type: "number" }, h: { type: "number" } },
        additionalProperties: false
      },
      settings: { type: "object", description: "Only the settings you change; the rest take the component's defaults." },
      origin: ORIGIN
    },
    additionalProperties: false,
    allOf: byType
  }

  // An edge's settings come from its source port, what sits on it (its connector) and transport, which every edge has.
  // A key two sources describe differently takes whichever comes first: the forms are the same in practice, and a
  // schema can't know which source applies without the design.
  const edgeFields = Connector.edgeFields(
    ...connectors.map((c) => c.settings),
    ...components.flatMap((m) => m.outputs.map((o) => o.settings)),
    Connector.transportFields()
  )
  definitions.edge = {
    type: "object",
    description: "A connection: calls or messages from one node's output to another node.",
    required: ["from", "to"],
    properties: {
      from: {
        type: "object",
        required: ["node"],
        properties: {
          node: { type: "string", description: "The node it leaves." },
          port: { type: "string", description: "The output it leaves from, when the node has several (deliver, dlq, onFailure...). Default out." }
        },
        additionalProperties: false
      },
      to: { type: "string", description: "The node it arrives at." },
      connector: {
        description: `What sits on it. Absent means the most specific one that fits: ${connectors.map((c) => `${c.type} (${c.title})`).join(", ")}.`,
        enum: connectors.map((c) => c.type)
      },
      name: { type: "string", description: "A label for the line." },
      settings: settingsObject("Only the settings you change: the port's, the connector's and transport's.", edgeFields),
      origin: ORIGIN
    },
    additionalProperties: false
  }

  definitions.controller = {
    type: "object",
    description: "A loop that watches a node and changes it while the design runs, such as an autoscaler.",
    required: ["type", "target"],
    properties: {
      type: { description: controllers.map((c) => `${c.type} (${c.title})`).join(", "), enum: controllers.map((c) => c.type) },
      target: { type: "string", description: "The id of the node it changes." },
      name: { type: "string" },
      settings: { type: "object", description: "Only the settings you change." }
    },
    additionalProperties: false,
    allOf: controllers.map((c) => whenType(c.type, { settings: { $ref: `#/definitions/${c.type}.settings` } }))
  }

  // Account quotas by placement (`aws:us-east-1`), for providers that have any.
  const accountPatterns: Record<string, JsonSchema> = {}
  for (const p of registry.providers) {
    const fields = Describe.fields(p.account(p.defaultRegion))
    if (fields.length > 0) accountPatterns[`^${p.id}:`] = settingsObject(`Account quotas of ${p.title} in one region: only the ones you change.`, fields)
  }

  definitions.scenario = {
    type: "object",
    description: "What happens to this design: a timeline of faults and changes, and the checks that must hold.",
    properties: scenarioProperties(),
    additionalProperties: false
  }

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: DESIGN_SCHEMA_URL,
    title: "infra-sim design",
    description: "A design for infra-sim: its components (nodes), the connections between them (edges), and what happens to it (scenarios).",
    type: "object",
    required: ["version", "nodes", "edges"],
    properties: {
      $schema: { type: "string", description: "The schema this file follows." },
      version: { const: 1, description: "The format version." },
      name: { type: "string", description: "What the design is called." },
      description: { type: "string", description: "What it is for. The first paragraph is its short blurb." },
      seed: { type: "integer", description: "Random seed: the same design and seed always play out the same." },
      accounts: {
        type: "object",
        description: "Account quotas by placement (such as aws:us-east-1): limits shared by everything in that account and region. Only what you change.",
        patternProperties: accountPatterns,
        additionalProperties: false
      },
      nodes: { type: "object", description: "The components, by id.", additionalProperties: { $ref: "#/definitions/node" } },
      edges: { type: "object", description: "The connections, by id (such as web.out->api).", additionalProperties: { $ref: "#/definitions/edge" } },
      controllers: { type: "object", description: "Loops that change nodes while the design runs, by id.", additionalProperties: { $ref: "#/definitions/controller" } },
      scenarios: { type: "object", description: "What happens to the design, by id. Play one with infra-sim run <design> --scenario <id>, or in the app's Scenario tab.", additionalProperties: { $ref: "#/definitions/scenario" } }
    },
    additionalProperties: false,
    definitions
  }
}

/** The schema of a scenario file: a scenario's fields, the format version and the design it is for. */
export const scenarioSchema = (): JsonSchema => ({
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: SCENARIO_SCHEMA_URL,
  title: "infra-sim scenario",
  description: "A scenario file: what happens to a design, and what must hold. (A design can also carry scenarios under scenarios.)",
  type: "object",
  required: ["version"],
  properties: {
    $schema: { type: "string", description: "The schema this file follows." },
    version: { const: 1, description: "The format version." },
    design: {
      description: "The design it is for: a path relative to this file (a design, or a template an importer reads), or the design itself.",
      anyOf: [{ type: "string" }, { $ref: "design.schema.json" }]
    },
    ...scenarioProperties()
  },
  additionalProperties: false
})
