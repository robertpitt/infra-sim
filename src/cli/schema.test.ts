import Ajv from "ajv"
import fs from "node:fs"
import YAML from "yaml"
import { describe, expect, it } from "vitest"
import { registry } from "#simulator/components"
import { designSchema, scenarioProperties, scenarioSchema } from "../simulator/DesignSchema.ts"
import * as ScenarioSpec from "../simulator/ScenarioSpec.ts"

const ajv = new Ajv({ allErrors: true, strict: false })
const design = designSchema(registry)
ajv.addSchema(design, "design.schema.json")
const validate = ajv.getSchema("design.schema.json")!
const validateScenario = ajv.compile(scenarioSchema())
const errors = (doc: unknown) => (validate(doc) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`))

const examples = fs.readdirSync("examples").filter((f) => f.endsWith(".yaml"))

// The published JSON Schemas (`schema/`): up to date with the components, and true to the files people write.
describe("DesignSchema", () => {
  it("is what schema/ holds (run `npm run schema` after changing a component)", () => {
    expect(JSON.parse(fs.readFileSync("schema/design.schema.json", "utf8"))).toEqual(design)
    expect(JSON.parse(fs.readFileSync("schema/scenario.schema.json", "utf8"))).toEqual(scenarioSchema())
  })

  it.each(examples)("accepts the example %s", (file) => {
    expect(errors(YAML.parse(fs.readFileSync(`examples/${file}`, "utf8")))).toEqual([])
  })

  it("knows every component, connector and controller, and checks settings by type", () => {
    const base = { version: 1, nodes: {}, edges: {} }
    expect(errors({ ...base, nodes: { fn: { type: "aws.lambda", settings: { memory: 512, timeout: "10 seconds", duration: { mean: 40 } } } } })).toEqual([])
    // A typo, a value out of range, a duration that isn't one, a region from another provider.
    expect(errors({ ...base, nodes: { fn: { type: "aws.lambda", settings: { memroy: 512 } } } }).join(" ")).toMatch(/additional properties/)
    expect(errors({ ...base, nodes: { fn: { type: "aws.lambda", settings: { memory: 99999 } } } }).join(" ")).toMatch(/must be <=/)
    expect(errors({ ...base, nodes: { fn: { type: "aws.lambda", settings: { timeout: "soon" } } } }).join(" ")).toMatch(/pattern|anyOf/)
    expect(errors({ ...base, nodes: { fn: { type: "aws.lambda", region: "mars-1" } } }).join(" ")).toMatch(/allowed values/)
    expect(errors({ ...base, nodes: { fn: { type: "aws.nothing" } } }).join(" ")).toMatch(/allowed values/)
    expect(errors({ ...base, edges: { e: { from: { node: "a" }, to: "b", settings: { timeout: "5 seconds", retry: { maxAttempts: 3 } } } } })).toEqual([])
    expect(errors({ ...base, edges: { e: { from: { node: "a" }, to: "b", settings: { retires: 3 } } } }).join(" ")).toMatch(/additional properties/)
    expect(errors({ ...base, accounts: { "aws:us-east-1": { lambdaConcurrency: 2000 } } })).toEqual([])
    expect(design.definitions).toHaveProperty(["aws.sqs.settings"])
  })

  it("checks a design's scenarios, and scenario files", () => {
    const base = { version: 1, nodes: {}, edges: {} }
    const ok = { duration: "5m", timeline: [{ at: "1m", inject: { target: "node:api", fault: "Slow(250ms)", for: "30s" } }], assert: ["api.errorRatio < 1%", { check: "system.latency.p99 < 800ms", from: "2m" }] }
    expect(errors({ ...base, scenarios: { s: ok } })).toEqual([])
    expect(errors({ ...base, scenarios: { s: { ...ok, timline: [] } } }).join(" ")).toMatch(/additional properties/)
    expect(errors({ ...base, scenarios: { s: { timeline: [{ at: "1m", inject: { target: "node:api", fault: "Melt" } }] } } }).length).toBeGreaterThan(0)
    expect(validateScenario({ version: 1, design: "../examples/03-orders.yaml", ...ok })).toBe(true)
    expect(validateScenario({ version: 1, design: { version: 1, nodes: {}, edges: {} }, ...ok })).toBe(true)
  })

  it("describes exactly the fields a scenario has", () => {
    expect(Object.keys(scenarioProperties()).sort()).toEqual(Object.keys(ScenarioSpec.fields).sort())
    const timeline = scenarioProperties().timeline as { items: { properties: object } }
    expect(Object.keys(timeline.items.properties).sort()).toEqual(Object.keys(ScenarioSpec.TimelineEvent.fields).sort())
  })
})
