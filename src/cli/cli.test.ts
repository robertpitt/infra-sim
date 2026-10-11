import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import YAML from "yaml"
import { describe, expect, it } from "vitest"
import { Scenario } from "#simulator"
import { EXIT, main } from "./cli.ts"
import { type IO, nodeIO } from "./io.ts"

/** Run the CLI in-process, capturing what it prints. Relative paths resolve from `cwd`. */
const cli = async (args: ReadonlyArray<string>, cwd = process.cwd()) => {
  const out: Array<string> = []
  const err: Array<string> = []
  const io: IO = { ...nodeIO(), stdout: (t) => void out.push(t), stderr: (t) => void err.push(t), cwd: () => cwd, isTTY: false, env: {} }
  const code = await main(args, io)
  return { code, out: out.join(""), err: err.join("") }
}
const json = <T = Record<string, any>>(text: string): T => JSON.parse(text) as T

const scratch = (files: Record<string, string>): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "infra-sim-"))
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), text)
  }
  return dir
}

const DESIGN = `
version: 1
name: tiny
seed: 2
nodes:
  web: { type: common.client, settings: { arrival: constant, rps: 40 } }
  api: { type: aws.apigateway, settings: { apiType: http } }
  fn: { type: aws.lambda, settings: { memory: 1769, duration: { mean: 20, cv: 0 } } }
edges:
  e1: { from: { node: web }, to: api }
  e2: { from: { node: api }, to: fn }
`

describe("help and usage", () => {
  it("lists the commands, and each command has its own help from the framework", async () => {
    const top = await cli(["--help"])
    expect(top.code).toBe(EXIT.ok)
    expect(top.err).toBe("")
    for (const c of ["run", "check", "import", "convert", "components", "describe", "examples", "docs"]) expect(top.out).toContain(c)
    expect(top.out).toContain("USAGE")
    expect(top.out).toContain("--completions")
    expect(top.out).toMatch(/Exit codes: 0 ok/)
    expect(top.out).toContain("@<example-id>")
    expect((await cli(["-h"])).out).toBe(top.out)
    expect((await cli([])).out).toBe(top.out)
  })

  it("prints a subcommand's flags, arguments and examples on --help", async () => {
    const run = await cli(["run", "--help"])
    expect(run).toMatchObject({ code: EXIT.ok, err: "" })
    for (const flag of ["--duration, -d", "--warmup", "--seed", "--scale", "--set", "--fault", "--assert, -a", "--format, -f", "--json", "--out, -o", "--frames", "--region", "--rps", "--importer", "--nodes", "--quiet, -q", "--no-color"]) expect(run.out).toContain(flag)
    expect(run.out).toContain("EXAMPLES")
    expect(run.out).toContain("infra-sim run @orders")
    expect((await cli(["check", "--help"])).out).toContain("--strict")
    expect((await cli(["components", "-h"])).out).toMatch(/--provider, -p[\s\S]*--category, -c[\s\S]*--search, -s/)
    expect((await cli(["import", "--help"])).out).toContain("--no-report")
    expect((await cli(["examples", "--help"])).out).toMatch(/SUBCOMMANDS[\s\S]*show[\s\S]*path/)
    expect((await cli(["examples", "show", "--help"])).out).toContain("id")
    expect((await cli(["docs", "--help"])).out).toContain("assertions")
  })

  it("prints its version", async () => {
    const r = await cli(["--version"])
    expect(r).toMatchObject({ code: EXIT.ok, err: "" })
    expect(r.out).toMatch(/infra-sim v\d+\.\d+\.\d+/)
    expect((await cli(["-v"])).out).toBe(r.out)
  })

  it("exits 2 with the reason on stderr for a bad flag, and keeps stdout clean", async () => {
    const r = await cli(["run", "@orders", "--bogus"])
    expect(r.code).toBe(EXIT.usage)
    expect(r.out).toBe("")
    expect(r.err).toContain("infra-sim: Unrecognized flag: --bogus")
    expect(r.err).toContain('Run "infra-sim run --help" for usage.')
  })

  it("exits 2 with the reason for unknown commands, missing arguments and bad values", async () => {
    expect(await cli(["frobnicate"])).toMatchObject({ code: EXIT.usage, out: "", err: expect.stringContaining('Unknown subcommand "frobnicate"') })
    expect(await cli(["run"])).toMatchObject({ code: EXIT.usage, out: "", err: expect.stringContaining("Missing required argument: file") })
    expect(await cli(["run", "@orders", "--seed", "lots"])).toMatchObject({ code: EXIT.usage, err: expect.stringContaining("--seed") })
    expect(await cli(["run", "@orders", "--format", "xml"])).toMatchObject({ code: EXIT.usage, err: expect.stringContaining("--format") })
    expect(await cli(["docs", "nonsense"])).toMatchObject({ code: EXIT.usage })
    expect(await cli(["run", "no-such-file.yaml"])).toMatchObject({ code: EXIT.usage, err: expect.stringContaining("no such file") })
    expect(await cli(["run", "@no-such-example"])).toMatchObject({ code: EXIT.usage, err: expect.stringContaining("no example") })
  })
})

describe("discovering what exists", () => {
  it("lists the examples, and prints one", async () => {
    const listed = json<Array<{ id: string }>>((await cli(["examples", "--json"])).out)
    expect(listed.map((e) => e.id)).toEqual(["orders", "retry-storm", "multi-region", "fan-out", "poshub", "cluster", "blank"])
    expect((await cli(["examples", "show", "orders"])).out).toMatch(/^# yaml-language-server: \$schema=\.\.\/schema\/design\.schema\.json\nversion: 1/)
    expect((await cli(["examples", "path", "orders"])).out).toMatch(/01-orders\.yaml/)
  })

  it("lists components, filtered, as data", async () => {
    const all = json<Array<{ type: string; provider: string }>>((await cli(["components", "--json"])).out)
    expect(all.map((c) => c.type)).toEqual(expect.arrayContaining(["aws.lambda", "aws.sqs", "aws.cloudfront", "aws.ses", "common.client"]))
    const aws = json<Array<{ provider: string }>>((await cli(["components", "--provider", "aws", "--json"])).out)
    expect(aws.every((c) => c.provider === "aws")).toBe(true)
    expect(json<Array<{ type: string }>>((await cli(["components", "--search", "queue", "--json"])).out).map((c) => c.type)).toContain("aws.sqs")
  })

  it("describes a component: settings with ranges and limit kinds, ports, and a short name works", async () => {
    const text = (await cli(["describe", "aws.lambda"])).out
    expect(text).toMatch(/memory\s+128\s+128\.\.10240 MB\s+hard/)
    expect(text).toContain("Ports")
    expect((await cli(["describe", "lambda"])).code).toBe(EXIT.ok)
    const manifest = json((await cli(["describe", "aws.sqs", "--json"])).out)
    expect(manifest.type).toBe("aws.sqs")
    expect(manifest.settings.length).toBeGreaterThan(3)
    expect(await cli(["describe", "aws.nope"])).toMatchObject({ code: EXIT.usage })
    expect((await cli(["describe", "aws.lamb"])).err).toContain("aws.lambda")
  })

  it("prints the guide, the assertion syntax and the faults", async () => {
    expect((await cli(["docs"])).out).toContain("infra-sim command line")
    expect((await cli(["docs", "assertions"])).out).toContain("errorRatio")
    expect((await cli(["docs", "faults"])).out).toContain("Outage")
  })
})

describe("run", () => {
  it("runs an example and reports as data, with the system, nodes, edges and what ran", async () => {
    const r = await cli(["run", "@orders", "-d", "60s", "--warmup", "10s", "--json"])
    expect(r.code).toBe(EXIT.ok)
    const result = json(r.out)
    expect(result).toMatchObject({ seed: 7, duration: 60_000, warmup: 10_000, passed: true })
    expect(result.system.rates.ok).toBeGreaterThan(50)
    expect(Object.keys(result.nodes)).toContain("orders-queue")
    expect(result.input.kind).toBe("design")
  })

  it("prints a readable summary by default", async () => {
    const r = await cli(["run", "@orders", "-d", "60s"])
    expect(r.out).toContain("System")
    expect(r.out).toContain("Nodes")
    expect(r.out).toMatch(/PASS$/m)
  })

  it("is deterministic and honours the seed", async () => {
    const run = async (seed: string) => json((await cli(["run", "@orders", "-d", "40s", "--seed", seed, "--json"])).out)
    const strip = (r: Record<string, any>) => ({ ...r, wallMs: 0 })
    expect(strip(await run("4"))).toEqual(strip(await run("4")))
    expect(strip(await run("4"))).not.toEqual(strip(await run("5")))
  })

  it("exits 1 when an assertion fails and 0 when they hold, saying what was measured", async () => {
    const failing = await cli(["run", "@orders", "-d", "30s", "-a", "system.latency.p50 < 1ms"])
    expect(failing.code).toBe(EXIT.failed)
    expect(failing.out).toMatch(/✘ system\.latency\.p50 < 1ms\s+measured/)
    const holding = await cli(["run", "@orders", "-d", "30s", "-a", "system.errorRatio < 50%", "--json"])
    expect(holding.code).toBe(EXIT.ok)
    expect(json(holding.out).assertions[0]).toMatchObject({ passed: true, check: "system.errorRatio < 50%" })
  })

  it("applies --scale, --set (nodes, edges and quotas) and --fault", async () => {
    const dir = scratch({ "d.yaml": DESIGN })
    const base = json((await cli(["run", "d.yaml", "-d", "30s", "--json"], dir)).out)
    const scaled = json((await cli(["run", "d.yaml", "-d", "30s", "--scale", "3", "--json"], dir)).out)
    expect(scaled.system.rates.sent / base.system.rates.sent).toBeGreaterThan(2.8)
    const slow = json((await cli(["run", "d.yaml", "-d", "30s", "--set", "fn:duration.mean=500", "--json"], dir)).out)
    expect(slow.system.dist.latency.p50).toBeGreaterThan(500)
    const throttled = json((await cli(["run", "d.yaml", "-d", "40s", "--scale", "5", "--set", "fn:duration.mean=400", "--set", "account:aws:us-east-1:lambdaConcurrency=10", "--json"], dir)).out)
    expect(throttled.nodes.fn.rates["fail.Throttled"]).toBeGreaterThan(0)
    const down = json((await cli(["run", "d.yaml", "-d", "40s", "--fault", "node:fn Outage at=10s for=10s", "-a", "system.errorRatio > 0.1", "--json"], dir)).out)
    expect(down.faults).toEqual([expect.objectContaining({ target: "node:fn", fault: "Outage", from: 10_000, to: 20_000 })])
    expect(down.passed).toBe(true)
  })

  it("runs a scenario that names its design, resolved relative to the scenario file", async () => {
    const dir = scratch({
      "designs/d.yaml": DESIGN,
      "s/outage.yaml": `
version: 1
name: Lose the function
design: ../designs/d.yaml
duration: 40s
warmup: 5s
timeline:
  - at: 10s
    inject: { target: node:fn, fault: Outage, for: 10s }
assert:
  - { check: "system.errorRatio > 90%", from: 11s, to: 19s }
  - { check: "system.errorRatio == 0", from: 22s }
`
    })
    const r = await cli(["run", "s/outage.yaml", "--json"], dir)
    expect(r.code).toBe(EXIT.ok)
    const result = json(r.out)
    expect(result.scenario).toBe("Lose the function")
    expect(result.assertions.map((a: { passed: boolean }) => a.passed)).toEqual([true, true])
    expect(result.input.kind).toBe("scenario")
  })

  it("lists every problem in a scenario that can't run, and exits 2", async () => {
    const dir = scratch({
      "d.yaml": DESIGN,
      "s.yaml": `design: d.yaml\nduration: 30s\noverrides: { nodes: { ghost: {} } }\ntimeline: [{ at: 5s, inject: { target: "node:zzz", fault: Meltdown } }]\nassert: ["nobody.errorRatio < 1%"]\n`
    })
    const r = await cli(["run", "s.yaml"], dir)
    expect(r.code).toBe(EXIT.usage)
    for (const issue of ['no node "ghost"', 'no node "zzz"', "no fault called", 'no node "nobody"']) expect(r.err).toContain(issue)
  })

  it("runs a template directly, importing it first, and says what it imported", async () => {
    const r = await cli(["run", "examples/imports/orders-sam.yaml", "-d", "40s", "--json"])
    expect(r.code).toBe(EXIT.ok)
    expect(r.err).toContain("Imported (cloudformation)")
    const result = json(r.out)
    expect(result.input.imported.converted.length).toBeGreaterThan(4)
    expect(Object.keys(result.nodes).some((id) => id.includes("function"))).toBe(true)
  })

  it("writes the result and every frame to files", async () => {
    const dir = scratch({ "d.yaml": DESIGN })
    const r = await cli(["run", "d.yaml", "-d", "10s", "--json", "-o", "result.json", "--frames", "frames.csv"], dir)
    expect(r.code).toBe(EXIT.ok)
    expect(r.out).toBe("")
    expect(json(fs.readFileSync(path.join(dir, "result.json"), "utf8")).passed).toBe(true)
    const csv = fs.readFileSync(path.join(dir, "frames.csv"), "utf8").split("\n")
    expect(csv[0]).toBe("t_ms,scope,id,metric,value")
    expect(csv.some((l) => /^\d+,node,fn,rate\.ok,/.test(l))).toBe(true)
  })

  it("rejects bad flag values with the flag named", async () => {
    expect((await cli(["run", "@orders", "--seed", "lots"])).err).toContain("--seed")
    expect((await cli(["run", "@orders", "--scale", "big"])).err).toContain("--scale")
    expect((await cli(["run", "@orders", "--set", "oops"])).err).toContain("--set")
    expect((await cli(["run", "@orders", "--fault", "node:fn Outage"])).err).toContain("at=")
    expect((await cli(["run", "@orders", "--format", "xml"])).err).toContain("--format")
  })
})

describe("check", () => {
  it("passes a sound design and a sound scenario", async () => {
    expect(await cli(["check", "@orders"])).toMatchObject({ code: EXIT.ok, out: expect.stringContaining("ok") })
    expect((await cli(["check", "@multi-region"])).code).toBe(EXIT.ok)
  })

  it("checks the scenarios a design carries, and a scenario file against its design", async () => {
    const dir = scratch({
      "d.yaml": `${DESIGN}scenarios:\n  bad: { duration: 1m, timeline: [{ at: 10s, inject: { target: "node:ghost", fault: Outage } }] }\n`,
      "s.yaml": "version: 1\ndesign: d.yaml\nduration: 30s\nassert: [ nope.errorRatio < 1% ]\n"
    })
    const own = await cli(["check", "d.yaml"], dir)
    expect(own.code).toBe(EXIT.usage)
    expect(own.out).toContain(`scenarios.bad: timeline[0].inject.target: no node "ghost"`)
    const file = await cli(["check", "s.yaml"], dir)
    expect(file.code).toBe(EXIT.usage)
    expect(file.out).toContain(`no node "nope"`)
  })

  it("exits 2 for an invalid design, listing the problems by id", async () => {
    const dir = scratch({ "bad.yaml": "version: 1\nnodes:\n  a: { type: aws.lambda, settings: { memory: 99999999 } }\n  b: { type: aws.nothing }\nedges:\n  e: { from: { node: a }, to: ghost }\n" })
    const r = await cli(["check", "bad.yaml"], dir)
    expect(r.code).toBe(EXIT.usage)
    expect(r.out).toContain("memory")
    expect(r.out).toContain("aws.nothing")
    expect(r.out).toContain("not ok")
    const data = json((await cli(["check", "bad.yaml", "--json"], dir)).out)
    expect(data.ok).toBe(false)
    expect(data.diagnostics.length).toBeGreaterThanOrEqual(3)
  })

  it("exits 1 on warnings only with --strict", async () => {
    const dir = scratch({ "w.yaml": "version: 1\nnodes:\n  fn: { type: aws.lambda }\n  web: { type: common.client }\nedges: {}\n" })
    expect((await cli(["check", "w.yaml"], dir)).code).toBe(EXIT.ok)
    expect((await cli(["check", "w.yaml", "--strict"], dir)).code).toBe(EXIT.failed)
  })

  it("isn't fooled by a file that is no kind of design", async () => {
    const dir = scratch({ "x.yaml": "hello: world\n", "y.yaml": "- a\n- b\n", "z.yaml": "key: [unclosed\n" })
    for (const f of ["x.yaml", "y.yaml", "z.yaml"]) expect((await cli(["check", f], dir)).code).toBe(EXIT.usage)
  })
})

describe("import and convert", () => {
  it("imports a template to a YAML design file, with the report on stderr", async () => {
    const dir = scratch({})
    const r = await cli(["import", path.resolve("examples/imports/fanout-cfn.yaml"), "--region", "eu-west-1", "-o", "design.yaml"], dir)
    expect(r.code).toBe(EXIT.ok)
    expect(r.err).toContain("Imported (cloudformation)")
    expect(r.err).toContain("OpenSearchService has no simulator component yet")
    const design = YAML.parse(fs.readFileSync(path.join(dir, "design.yaml"), "utf8"))
    expect(design.nodes["aws-eu-west-1"].settings.region).toBe("eu-west-1")
    expect((await cli(["check", "design.yaml"], dir)).code).toBe(EXIT.ok)
  })

  it("prints design and report as JSON, and refuses what isn't a template", async () => {
    const data = json((await cli(["import", "examples/imports/orders-sam.yaml", "--json"])).out)
    expect(Object.keys(data)).toEqual(["design", "report"])
    expect(data.report.settings.preserved).toBeGreaterThan(10)
    expect(await cli(["import", "examples/01-orders.yaml"])).toMatchObject({ code: EXIT.usage, err: expect.stringContaining("isn't a CloudFormation template") })
  })

  it("converts between YAML and JSON, losing nothing", async () => {
    const dir = scratch({ "d.yaml": DESIGN })
    expect((await cli(["convert", "d.yaml", "-o", "d.json"], dir)).code).toBe(EXIT.ok)
    const asJson = json(fs.readFileSync(path.join(dir, "d.json"), "utf8"))
    // Files written point editors at the schema: JSON in `$schema`, YAML in its first line.
    expect(asJson).toEqual({ $schema: "https://robertpitt.github.io/infra-sim/schema/design.schema.json", ...YAML.parse(DESIGN) })
    expect((await cli(["convert", "d.json", "--format", "yaml"], dir)).out).toMatch(/^# yaml-language-server: \$schema=https:\S+design\.schema\.json\nversion: 1/)
    expect((await cli(["run", "d.json", "-d", "10s", "--json"], dir)).code).toBe(EXIT.ok)
  })
})

describe("schema", () => {
  it("prints the JSON Schema of a design file, and of a scenario file", async () => {
    const design = json((await cli(["schema"])).out)
    expect(design).toMatchObject({ $id: expect.stringContaining("design.schema.json"), required: ["version", "nodes", "edges"] })
    expect(design.definitions["aws.lambda.settings"].properties.memory).toMatchObject({ type: "integer", maximum: 10240 })
    expect(json((await cli(["schema", "scenario"])).out).$id).toContain("scenario.schema.json")
  })
})

describe("the examples' scenarios", () => {
  // Every scenario an example carries that checks something and runs in test time, as "example scenario". Longer ones (a
  // day of traffic) and ones that only watch are for exploring, not for the suite.
  const LONGEST = 15 * 60_000
  const cases = fs
    .readdirSync("examples")
    .filter((f) => f.endsWith(".yaml"))
    .flatMap((f) => {
      const scenarios = (YAML.parse(fs.readFileSync(`examples/${f}`, "utf8")) as { scenarios?: Record<string, Scenario.Spec> }).scenarios ?? {}
      return Object.entries(scenarios)
        .filter(([, s]) => (s.assert?.length ?? 0) > 0 && (Scenario.parseDuration(s.duration) ?? Infinity) <= LONGEST)
        .map(([id]) => [f.replace(/^\d+-/, "").replace(/\.yaml$/, ""), id] as const)
    })

  it("ships some", () => expect(cases.length).toBeGreaterThanOrEqual(2))

  it.each(cases)("@%s --scenario %s holds", async (example, id) => {
    const r = await cli(["run", `@${example}`, "--scenario", id, "--json"])
    expect(r.code).toBe(EXIT.ok)
    expect(json(r.out).assertions.length).toBeGreaterThan(0)
  })

  it("says which scenarios there are when one doesn't exist", async () => {
    const r = await cli(["run", "@multi-region", "--scenario", "nope"])
    expect(r.code).toBe(EXIT.usage)
    expect(r.err).toContain("lose-us-east-1")
  })
})
