import path from "node:path"
import { Cause, Console, Data, Effect, Option } from "effect"
import { Argument, CliConfig, CliError, CliOutput, Command, Flag, GlobalFlag } from "effect/cli"
import * as NodeServices from "@effect/platform-node/NodeServices"
import YAML from "yaml"
import { builtinLayer, Connector, Design, DesignSchema, Diagnostics, Fault, importers, type Importer, Scenario } from "#simulator"
import { registry } from "#simulator/components"
import { exampleFiles, encodeDesign, load, type Loaded, resolveReference, stem, UsageError } from "./load.ts"
import { makeStyle, renderComponent, renderConnector, renderController, renderDiagnostics, renderFrames, renderImportReport, renderResult, table } from "./format.ts"
import { type IO, Io } from "./io.ts"

/**
 * infra-sim: run designs and scenarios from a terminal, a script or an agent.
 *
 * Built on `effect/cli`: the command tree below carries every description, flag and example, and the framework parses the
 * arguments, prints `--help` and `--version`, and reports malformed flags.
 *
 * Exit codes: 0 success (every assertion held), 1 an assertion failed or a component crashed, 2 the input was wrong
 * (a file that isn't valid, a scenario that names things that don't exist, a bad flag), 3 an internal error.
 */
export const EXIT = { ok: 0, failed: 1, usage: 2, internal: 3 } as const

/** A command that ran to the end but whose outcome isn't success: the exit code it asks for (1 for a failed assertion). */
export class Exited extends Data.TaggedError("Exited")<{ readonly code: number }> {}

// ---------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------

/** Run synchronous code that throws `UsageError` for bad input; the error moves to the Effect's error channel. Anything else is a bug (a defect). */
const usage = <A>(thunk: () => A): Effect.Effect<A, UsageError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(thunk())
    } catch (error) {
      return error instanceof UsageError ? Effect.fail(error) : Effect.die(error)
    }
  })

/** Write a file, relative paths resolved from the directory the CLI was run in. */
const write = (io: IO, file: string, text: string): void => io.writeFile(path.resolve(io.cwd(), file), text)

const undef = Option.getOrUndefined

/** Colour only on a terminal, unless `--no-color` or NO_COLOR says otherwise (and never for machine-readable output). */
const styleOf = (io: IO, noColor: boolean, text = true) => makeStyle(text && io.isTTY && !noColor && io.env.NO_COLOR === undefined)

type Format = "text" | "json" | "yaml"
const formatOf = (json: boolean, format: Option.Option<Format>, fallback: Format = "text"): Format => (json ? "json" : (undef(format) ?? fallback))

const dump = (value: unknown, format: Format): string => (format === "yaml" ? YAML.stringify(value, { lineWidth: 0 }) : `${JSON.stringify(value, null, 2)}\n`)

const importerOf = (id: string | undefined): Importer | undefined => {
  if (id === undefined) return undefined
  const found = importers.find((i) => i.id === id)
  if (found === undefined) throw new UsageError(`--importer: no importer called "${id}"`, [`available: ${importers.map((i) => i.id).join(", ")}`])
  return found
}

const templateOptions = (region: Option.Option<string>, rps: Option.Option<number>): { region?: string; rps?: number } => ({
  ...(Option.isSome(region) ? { region: region.value } : {}),
  ...(Option.isSome(rps) ? { rps: rps.value } : {})
})

/** Help text is written for the terminal: continuation lines are indented to sit under the first (the framework indents only that one). */
const block = (...lines: ReadonlyArray<string>): string => lines.map((l, i) => (i === 0 || l === "" ? l : `  ${l}`)).join("\n")

// ---------------------------------------------------------------------------------------------------------
// Flags shared by several commands
// ---------------------------------------------------------------------------------------------------------

/** A switch: false unless given. */
const boolFlag = (name: string) => Flag.Boolean(name).pipe(Flag.withDefault(false))

const jsonFlag = boolFlag("json").pipe(Flag.withDescription("Print the result as JSON (same as --format json)"))
const noColorFlag = boolFlag("no-color").pipe(Flag.withDescription("Never use colour (also honoured: NO_COLOR, and output that isn't a terminal)"))
const regionFlag = Flag.String("region").pipe(Flag.withMetavar("region"), Flag.withDescription("For templates: the AWS region to place everything in (default us-east-1)"), Flag.optional)
const importerFlag = Flag.String("importer").pipe(Flag.withMetavar("id"), Flag.withDescription("Force an importer instead of detecting one (cloudformation)"), Flag.optional)
const outFlag = (what: string) => Flag.String("out").pipe(Flag.withAlias("o"), Flag.withMetavar("file"), Flag.withDescription(what), Flag.optional)
const formatFlag = Flag.Literals("format", ["text", "json", "yaml"]).pipe(Flag.withAlias("f"), Flag.withDescription("Output format (default text)"), Flag.optional)
const fileFormatFlag = Flag.Literals("format", ["yaml", "json"]).pipe(Flag.withAlias("f"), Flag.withDescription("Output format (default yaml; a --out ending in .json picks json)"), Flag.optional)

// ---------------------------------------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------------------------------------

/** `node:api:stageThrottle.rate=500` -> a setting; `edge:<id>:<path>=v`; `account:aws:us-east-1:lambdaConcurrency=500`. */
const parseSet = (text: string): { readonly kind: "nodes" | "edges" | "accounts"; readonly id: string; readonly path: ReadonlyArray<string>; readonly value: unknown } => {
  const eq = text.indexOf("=")
  if (eq < 0) throw new UsageError(`--set "${text}": expected <node>:<setting>=<value> (for example api:stageThrottle.rate=500)`)
  let left = text.slice(0, eq)
  const raw = text.slice(eq + 1)
  let kind: "nodes" | "edges" | "accounts" = "nodes"
  if (left.startsWith("edge:")) {
    kind = "edges"
    left = left.slice(5)
  } else if (left.startsWith("account:")) {
    kind = "accounts"
    left = left.slice(8)
  } else if (left.startsWith("node:")) left = left.slice(5)
  const colon = left.lastIndexOf(":")
  if (colon < 0) throw new UsageError(`--set "${text}": missing the setting name (<id>:<setting>=<value>)`)
  let value: unknown = raw
  try {
    value = JSON.parse(raw)
  } catch {
    // Not JSON: a plain string such as "30 seconds" or fifo.
  }
  return { kind, id: left.slice(0, colon), path: left.slice(colon + 1).split("."), value }
}

const setPath = (target: Record<string, unknown>, path: ReadonlyArray<string>, value: unknown): void => {
  let at = target
  for (const key of path.slice(0, -1)) at = (at[key] ??= {}) as Record<string, unknown>
  at[path[path.length - 1]!] = value
}

/** `node:fn Outage at=10s for=20s` -> a timeline event. */
const parseFaultFlag = (text: string): Scenario.TimelineEvent => {
  const [target, fault, ...rest] = text.trim().split(/\s+/)
  if (target === undefined || fault === undefined) throw new UsageError(`--fault "${text}": expected "<target> <fault> at=<time> [for=<duration>]", for example "node:fn Outage at=10s for=20s"`)
  const kv = Object.fromEntries(rest.map((t) => (t.includes("=") ? [t.slice(0, t.indexOf("=")), t.slice(t.indexOf("=") + 1)] : [t, ""])))
  if (kv.at === undefined) throw new UsageError(`--fault "${text}": needs at=<time>`)
  return { at: kv.at, inject: { target, fault, ...(kv.for === undefined ? {} : { for: kv.for }), ...(kv.id === undefined ? {} : { id: kv.id }) } }
}

/**
 * The design to run and the scenario to play on it: a scenario file's own, one of the design's (`--scenario <id>`), or
 * none (the design runs as it is).
 */
const designAndScenario = (loaded: Loaded, file: string, id?: string): { design: Design.Doc; scenario: Scenario.Spec } => {
  if (loaded.kind === "design") {
    if (id === undefined) return { design: loaded.doc, scenario: {} }
    const own = loaded.doc.scenarios?.[id]
    if (own === undefined) {
      const ids = Scenario.ofDesign(loaded.doc).map(([k]) => k)
      throw new UsageError(`${file}: no scenario "${id}"`, [ids.length === 0 ? "this design has no scenarios" : `its scenarios: ${ids.join(", ")}`])
    }
    return { design: loaded.doc, scenario: own }
  }
  if (id !== undefined) throw new UsageError(`--scenario picks one of a design's own scenarios, and ${file} is a scenario file already`)
  if (loaded.design === undefined) throw new UsageError(`${file}: the scenario has no design (add \`design: path/to/design.yaml\`)`)
  return { design: loaded.design, scenario: loaded.scenario }
}

/** A design's own scenarios, checked against it, each problem named by the scenario it is in. */
const ownScenarioIssues = (design: Design.Doc): ReadonlyArray<string> =>
  Scenario.ofDesign(design).flatMap(([id, scenario]) => Scenario.check(design, scenario).map((issue) => `scenarios.${id}: ${issue}`))

const fileArgument = (what: string) => Argument.String("file").pipe(Argument.withDescription(what))

const run = Command.make(
  "run",
  {
    file: fileArgument("A design, a scenario, or a template an importer reads; or @<example-id> (for example @orders)"),
    scenario: Flag.String("scenario").pipe(Flag.withAlias("s"), Flag.withMetavar("id"), Flag.withDescription("Play one of the design's own scenarios (its `scenarios` section; `infra-sim examples` lists them)"), Flag.optional),
    duration: Flag.String("duration").pipe(Flag.withAlias("d"), Flag.withMetavar("time"), Flag.withDescription("How long to simulate: 90s, 5m, 1h30m (default 60s, or the scenario's)"), Flag.optional),
    warmup: Flag.String("warmup").pipe(Flag.withMetavar("time"), Flag.withDescription("Let the system settle first; summaries and assertions start after it"), Flag.optional),
    seed: Flag.Finite("seed").pipe(Flag.withDescription("Random seed. The same design and seed always give the same result"), Flag.optional),
    scale: Flag.Finite("scale").pipe(Flag.withDescription("Multiply every client's request rate (3 = three times the traffic)"), Flag.optional),
    set: Flag.String("set").pipe(
      Flag.withMetavar("id:path=value"),
      Flag.withDescription("Override a setting, repeatable: api:stageThrottle.rate=500. Edges: edge:<edge-id>:<path>=<v>. Account quotas: account:aws:us-east-1:lambdaConcurrency=500"),
      Flag.atLeast(0)
    ),
    fault: Flag.String("fault").pipe(
      Flag.withMetavar("target fault at=time"),
      Flag.withDescription(`Inject a fault, repeatable: "node:fn Outage at=10s for=20s", "region:aws:us-east-1 Outage at=2m", "edge:web.out->api Slow(250ms) at=1m for=30s". See: infra-sim docs faults`),
      Flag.atLeast(0)
    ),
    assert: Flag.String("assert").pipe(
      Flag.withAlias("a"),
      Flag.withMetavar("expr"),
      Flag.withDescription(`Add an assertion, repeatable: "api.errorRatio < 1%". See: infra-sim docs assertions`),
      Flag.atLeast(0)
    ),
    format: formatFlag,
    json: jsonFlag,
    out: outFlag("Write the result to a file instead of stdout"),
    frames: Flag.String("frames").pipe(Flag.withMetavar("file.csv"), Flag.withDescription("Also write every metrics frame as CSV (t_ms,scope,id,metric,value)"), Flag.optional),
    region: regionFlag,
    rps: Flag.Finite("rps").pipe(Flag.withDescription("For templates: requests per second for traffic sources the template doesn't have"), Flag.optional),
    importer: importerFlag,
    nodes: Flag.Int("nodes").pipe(Flag.withDescription("Rows in the node table (default 20)"), Flag.optional),
    quiet: boolFlag("quiet").pipe(Flag.withAlias("q"), Flag.withDescription("Don't print the import report")),
    noColor: noColorFlag
  },
  Effect.fn("run")(function*(o) {
    const io = yield* Io
    const format = formatOf(o.json, o.format)
    const prepared = yield* usage(() => {
      const loaded = load(io, o.file, templateOptions(o.region, o.rps), importerOf(undef(o.importer)))
      const { design, scenario: fromFile } = designAndScenario(loaded, o.file, undef(o.scenario))

      // Flags win over the file.
      const overrides = { nodes: { ...(fromFile.overrides?.nodes ?? {}) } as Record<string, Record<string, unknown>>, edges: { ...(fromFile.overrides?.edges ?? {}) } as Record<string, Record<string, unknown>>, accounts: { ...(fromFile.overrides?.accounts ?? {}) } as Record<string, Record<string, unknown>> }
      for (const text of o.set) {
        const s = parseSet(text)
        const bag = (overrides[s.kind][s.id] ??= {})
        setPath(bag, s.path, s.value)
      }
      const scenario: Scenario.Spec = {
        ...fromFile,
        duration: undef(o.duration) ?? fromFile.duration ?? "60s",
        ...(Option.isSome(o.warmup) ? { warmup: o.warmup.value } : {}),
        ...(Option.isSome(o.seed) ? { seed: o.seed.value } : {}),
        ...(Option.isSome(o.scale) ? { traffic: { scale: o.scale.value } } : {}),
        overrides,
        timeline: [...(fromFile.timeline ?? []), ...o.fault.map(parseFaultFlag)],
        assert: [...(fromFile.assert ?? []), ...o.assert]
      }
      return { loaded, design, scenario }
    })
    const { loaded, design, scenario } = prepared

    const style = styleOf(io, o.noColor, format === "text")
    if (!o.quiet && loaded.imported !== undefined) io.stderr(renderImportReport(loaded.imported.report, style))
    const result = yield* Scenario.run(design, scenario, { keepFrames: Option.isSome(o.frames) }).pipe(
      Effect.provide(builtinLayer),
      Effect.mapError((e) => new UsageError(`${o.file}: the scenario can't run`, e.issues))
    )
    const diagnostics = Diagnostics.diagnose(design, registry).filter((d) => d.level !== "info")
    const full = { ...result, diagnostics, input: { file: loaded.file, kind: loaded.kind, ...(loaded.kind === "scenario" && loaded.designFile !== undefined ? { design: loaded.designFile } : {}), ...(loaded.imported === undefined ? {} : { imported: loaded.imported.report }) } }

    if (Option.isSome(o.frames)) write(io, o.frames.value, renderFrames(result.frames ?? []))
    const { frames: _frames, ...publish } = full
    // A design with scenarios of its own, run without one, says what it could have played.
    const own = loaded.kind === "design" && Option.isNone(o.scenario) ? Scenario.ofDesign(design).map(([id]) => id) : []
    const hint = own.length === 0 ? "" : `\n${style.dim(`This design has scenarios: ${own.join(", ")}. Play one with --scenario <id>.`)}\n`
    const text = format === "text" ? renderResult(result, style, { nodes: undef(o.nodes) ?? 20 }) + (diagnostics.length > 0 ? `\nDesign warnings\n${renderDiagnostics(diagnostics, style)}\n` : "") + hint : dump(publish, format)
    if (Option.isSome(o.out)) write(io, o.out.value, text)
    else io.stdout(text)
    if (!result.passed) return yield* new Exited({ code: EXIT.failed })
  })
).pipe(
  Command.withShortDescription("Run a design or scenario and report what happened (exit 1 if an assertion fails)"),
  Command.withDescription(block(
    "Run a design or scenario on virtual time and report. A design runs as it is; a scenario adds a timeline of faults,",
    "setting changes and assertions. Flags override what the file says. Exit 0 if every assertion held, 1 if one failed or a",
    "component crashed, 2 if the input was wrong."
  )),
  Command.withExamples([
    { command: "infra-sim run @orders --duration 2m", description: "Run a bundled example for two simulated minutes" },
    { command: `infra-sim run @orders -d 5m --scale 3 --fault "node:ingest Outage at=2m for=1m" --assert "system.errorRatio < 5%"`, description: "Triple the traffic, lose a node for a minute, assert on the outcome" },
    { command: "infra-sim run @multi-region --scenario lose-us-east-1", description: "Play one of the design's own scenarios" },
    { command: "infra-sim run scenario.yaml --json", description: "Run a scenario file and print the whole result as data" },
    { command: "infra-sim run @poshub -d 10m --frames frames.csv --json -o result.json", description: "Write the result and every metrics frame to files" }
  ])
)

// ---------------------------------------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------------------------------------

const check = Command.make(
  "check",
  {
    file: fileArgument("A design, a scenario, or a template an importer reads; or @<example-id>"),
    format: formatFlag,
    json: jsonFlag,
    strict: boolFlag("strict").pipe(Flag.withDescription("Exit 1 on warnings too")),
    region: regionFlag,
    importer: importerFlag,
    noColor: noColorFlag
  },
  Effect.fn("check")(function*(o) {
    const io = yield* Io
    const prepared = yield* usage(() => {
      const loaded = load(io, o.file, templateOptions(o.region, Option.none()), importerOf(undef(o.importer)))
      const { design, scenario } = designAndScenario(loaded.kind === "scenario" && loaded.design === undefined ? { ...loaded, design: Design.empty() } : loaded, o.file)
      return { loaded, design, scenario }
    })
    const { loaded, design, scenario } = prepared
    const diagnostics = Diagnostics.diagnose(design, registry)
    // A scenario file is checked against its design; a design, against every scenario it carries.
    const issues = loaded.kind === "scenario" ? Scenario.check(design, scenario) : ownScenarioIssues(design)
    const errors = diagnostics.filter((d) => d.level === "error")
    const warnings = diagnostics.filter((d) => d.level === "warning")
    const ok = errors.length === 0 && issues.length === 0 && (!o.strict || warnings.length === 0)
    const format = formatOf(o.json, o.format)
    if (format !== "text") io.stdout(dump({ ok, kind: loaded.kind, nodes: Object.keys(design.nodes).length, edges: Object.keys(design.edges).length, diagnostics, scenarioIssues: issues }, format))
    else {
      const style = styleOf(io, o.noColor)
      io.stdout(`${style.bold(o.file)}: ${loaded.kind}, ${Object.keys(design.nodes).length} nodes, ${Object.keys(design.edges).length} edges\n`)
      if (diagnostics.length > 0) io.stdout(`${renderDiagnostics(diagnostics, style)}\n`)
      for (const issue of issues) io.stdout(`${style.red("scenario")} ${issue}\n`)
      io.stdout(ok ? `${style.green("ok")}\n` : `${style.red("not ok")}\n`)
    }
    if (!ok) return yield* new Exited({ code: errors.length > 0 || issues.length > 0 ? EXIT.usage : EXIT.failed })
  })
).pipe(
  Command.withShortDescription("Validate a design or scenario without running it"),
  Command.withDescription(block(
    "Validate a design or scenario without running it, and the scenarios a design carries. Lists every problem at once, by id.",
    "Exit 0 ok, 2 errors (invalid settings, unknown ids, a scenario that can't run), 1 only warnings with --strict."
  )),
  Command.withExamples([
    { command: "infra-sim check design.yaml", description: "Validate a design" },
    { command: "infra-sim check scenario.yaml --json", description: "Validate a scenario, problems as data" },
    { command: "infra-sim check @poshub --strict", description: "Treat warnings as failures too" }
  ])
)

// ---------------------------------------------------------------------------------------------------------
// import, convert
// ---------------------------------------------------------------------------------------------------------

const importCommand = Command.make(
  "import",
  {
    file: Argument.String("template").pipe(Argument.withDescription("A CloudFormation, SAM or `cdk synth` template (YAML or JSON)")),
    out: outFlag("Write the design here (.json writes JSON, anything else YAML)"),
    format: fileFormatFlag,
    json: boolFlag("json").pipe(Flag.withDescription("Print { design, report } as JSON on stdout")),
    region: Flag.String("region").pipe(Flag.withMetavar("region"), Flag.withDescription("The AWS region to place everything in (default us-east-1)"), Flag.optional),
    rps: Flag.Finite("rps").pipe(Flag.withDescription("Requests per second for traffic sources the template doesn't have (default 20)"), Flag.optional),
    importer: importerFlag,
    noReport: boolFlag("no-report").pipe(Flag.withDescription("Don't print the report of what was converted, inferred, adjusted and left out")),
    noColor: noColorFlag
  },
  Effect.fn("import")(function*(o) {
    const io = yield* Io
    const { loaded, imported } = yield* usage(() => {
      const loaded = load(io, o.file, templateOptions(o.region, o.rps), importerOf(undef(o.importer)) ?? importers[0])
      if (loaded.kind !== "design" || loaded.imported === undefined) throw new UsageError(`${o.file}: not something an importer reads (it is already a ${loaded.kind}; use \`convert\` to change its format)`)
      return { loaded, imported: loaded.imported }
    })
    const style = styleOf(io, o.noColor)
    if (o.json) {
      const text = dump({ design: loaded.doc, report: imported.report }, "json")
      if (Option.isSome(o.out)) write(io, o.out.value, text)
      else io.stdout(text)
      return
    }
    const out = undef(o.out)
    const format: "yaml" | "json" = undef(o.format) === "json" || (out !== undefined && out.endsWith(".json")) ? "json" : "yaml"
    const text = encodeDesign(loaded.doc, format)
    if (out !== undefined) write(io, out, text)
    else io.stdout(text)
    if (!o.noReport) io.stderr(renderImportReport(imported.report, style))
  })
).pipe(
  Command.withShortDescription("Turn a CloudFormation/SAM/CDK template into a design (YAML)"),
  Command.withDescription(block(
    "Turn a CloudFormation, SAM or `cdk synth` template (YAML or JSON) into a design. The design goes to stdout (or --out);",
    "the report of what was converted, inferred, adjusted and left out goes to stderr."
  )),
  Command.withExamples([
    { command: "infra-sim import template.yaml --region eu-west-1 -o design.yaml", description: "Write the design to a file, the report to stderr" },
    { command: "infra-sim import template.yaml --json", description: "Print { design, report } as data" }
  ])
)

const convert = Command.make(
  "convert",
  {
    file: Argument.String("design").pipe(Argument.withDescription("A design file (YAML or JSON)")),
    out: outFlag("Write here instead of stdout (.json writes JSON, anything else YAML)"),
    format: fileFormatFlag
  },
  Effect.fn("convert")(function*(o) {
    const io = yield* Io
    const loaded = yield* usage(() => load(io, o.file))
    if (loaded.kind !== "design") return yield* new UsageError(`${o.file}: a scenario can't be converted here; convert its design`)
    const out = undef(o.out)
    const requested = undef(o.format)
    const format: "yaml" | "json" = requested === "json" || (requested === undefined && out?.endsWith(".json") === true) ? "json" : "yaml"
    const text = encodeDesign(loaded.doc, format)
    if (out === undefined) io.stdout(text)
    else write(io, out, text)
  })
).pipe(
  Command.withShortDescription("Convert a design between YAML and JSON"),
  Command.withDescription("Convert a design file between YAML and JSON, to stdout or --out (the extension picks the format)."),
  Command.withExamples([
    { command: "infra-sim convert design.yaml -o design.json", description: "YAML to JSON" },
    { command: "infra-sim convert design.json --format yaml", description: "JSON to YAML on stdout" }
  ])
)

// ---------------------------------------------------------------------------------------------------------
// components, describe, examples, docs
// ---------------------------------------------------------------------------------------------------------

const components = Command.make(
  "components",
  {
    provider: Flag.String("provider").pipe(Flag.withAlias("p"), Flag.withDescription("Only this provider: aws | internet"), Flag.optional),
    category: Flag.String("category").pipe(Flag.withAlias("c"), Flag.withDescription("Only this category: compute | messaging | storage | network | traffic | external"), Flag.optional),
    search: Flag.String("search").pipe(Flag.withAlias("s"), Flag.withMetavar("text"), Flag.withDescription("Only components whose type, title, service or description mention this"), Flag.optional),
    format: formatFlag,
    json: jsonFlag
  },
  Effect.fn("components")(function*(o) {
    const io = yield* Io
    const search = undef(o.search)?.toLowerCase()
    const provider = undef(o.provider)
    const category = undef(o.category)
    const list = registry.manifests.filter(
      (m) =>
        (provider === undefined || m.provider === provider) &&
        (category === undefined || m.category === category) &&
        (search === undefined || [m.type, m.title, m.service, m.description].some((t) => t.toLowerCase().includes(search)))
    )
    const format = formatOf(o.json, o.format)
    if (format !== "text") {
      io.stdout(dump(list.map((m) => ({ type: m.type, provider: m.provider, service: m.service, title: m.title, category: m.category, description: m.description, ports: m.outputs.map((port) => port.port), container: m.container !== undefined })), format))
      return
    }
    io.stdout(`${table([["type", "provider", "category", "description"], ...list.map((m) => [m.type, m.provider, m.category, m.description.length > 80 ? `${m.description.slice(0, 77)}...` : m.description])])}\n`)
  })
).pipe(
  Command.withShortDescription("List the components a design can use"),
  Command.withDescription("List the components a design can use."),
  Command.withExamples([
    { command: "infra-sim components --provider aws --category messaging", description: "Only AWS messaging services" },
    { command: "infra-sim components --search queue --json", description: "Search, as data" }
  ])
)

const describe = Command.make(
  "describe",
  {
    type: Argument.String("type").pipe(Argument.withDescription("A component type, for example aws.lambda (see `infra-sim components`); the provider prefix may be left off")),
    format: formatFlag,
    json: boolFlag("json").pipe(Flag.withDescription("Print the full machine-readable manifest (same as --format json)")),
    noColor: noColorFlag
  },
  Effect.fn("describe")(function*(o) {
    const io = yield* Io
    const type = o.type
    const manifest = registry.manifests.find((m) => m.type === type) ?? registry.manifests.find((m) => m.type === `aws.${type}` || m.type === `common.${type}`)
    const format = formatOf(o.json, o.format)
    // A connector is described the same way: what it fits between, and its settings.
    const connector = manifest === undefined ? registry.connectorManifests.find((c) => c.type === type || c.type === `core.${type}` || c.type === `aws.${type}`) : undefined
    if (connector !== undefined) {
      io.stdout(format !== "text" ? dump(connector, format) : renderConnector(connector, Connector.transportFields(), styleOf(io, o.noColor)))
      return
    }
    const controller = manifest === undefined ? registry.controllerManifests.find((c) => c.type === type || c.type === `core.${type}`) : undefined
    if (controller !== undefined) {
      io.stdout(format !== "text" ? dump(controller, format) : renderController(controller, styleOf(io, o.noColor)))
      return
    }
    if (manifest === undefined) {
      const all = [...registry.manifests, ...registry.connectorManifests, ...registry.controllerManifests].map((m) => m.type)
      const near = all.filter((t) => t.includes(type.toLowerCase()))
      const list = (label: string, types: ReadonlyArray<{ readonly type: string }>) => `${label}: ${types.map((m) => m.type).join(", ")}`
      return yield* new UsageError(`no component, connector or controller called "${type}"`, [
        near.length > 0
          ? `did you mean: ${near.join(", ")}`
          : [list("components", registry.manifests), list("connectors", registry.connectorManifests), list("controllers", registry.controllerManifests)].join("; ")
      ])
    }
    if (format !== "text") io.stdout(dump(manifest, format))
    else io.stdout(renderComponent(manifest, styleOf(io, o.noColor)))
  })
).pipe(
  Command.withShortDescription("Show one component\'s or connector's settings, ranges, limits and ports (describe aws.lambda)"),
  Command.withDescription(block(
    "Everything needed to configure a component: every setting with its default and range, whether a limit is hard or an",
    "adjustable quota, the ports edges leave from, and the service's published limits. Use it before writing a design.",
    "A connector (what sits on an edge, such as aws.sqs.event-source-mapping) and a controller (what changes a node while it",
    "runs, such as core.target-tracking) are described the same way."
  )),
  Command.withExamples([
    { command: "infra-sim describe aws.lambda", description: "Settings, ranges, limits and ports of a Lambda function" },
    { command: "infra-sim describe sqs --json", description: "The same for SQS, as the full manifest" },
    { command: "infra-sim describe aws.sqs.event-source-mapping", description: "The connector between a queue and its consumer" }
  ])
)

interface ExampleEntry {
  readonly id: string
  readonly title: string
  readonly blurb: string
  readonly file: string
  /** The scenarios the design carries, by id. */
  readonly scenarios: ReadonlyArray<string>
}

const exampleEntries = (io: IO): ReadonlyArray<ExampleEntry> =>
  exampleFiles(io).map((f) => {
    const file = path.join(io.assets("examples"), f)
    const doc = (YAML.parse(io.readFile(file)) ?? {}) as { name?: string; description?: string; scenarios?: Record<string, unknown> }
    return {
      id: stem(f),
      title: doc.name ?? stem(f),
      blurb: (doc.description ?? "").split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").trim() ?? "",
      file,
      scenarios: Object.keys(doc.scenarios ?? {})
    }
  })

const exampleId = Argument.String("id").pipe(Argument.withDescription("An example id, as listed by `infra-sim examples` (for example orders)"))

const examplesShow = Command.make(
  "show",
  { id: exampleId },
  Effect.fn("examples show")(function*(o) {
    const io = yield* Io
    io.stdout(yield* usage(() => io.readFile(resolveReference(io, `@${o.id}`))))
  })
).pipe(Command.withDescription("Print an example's source (a design or scenario in YAML)."), Command.withExamples([{ command: "infra-sim examples show orders" }]))

const examplesPath = Command.make(
  "path",
  { id: exampleId },
  Effect.fn("examples path")(function*(o) {
    const io = yield* Io
    io.stdout(`${yield* usage(() => resolveReference(io, `@${o.id}`))}\n`)
  })
).pipe(Command.withDescription("Print where an example lives on disk."), Command.withExamples([{ command: "infra-sim examples path orders" }]))

const examples = Command.make(
  "examples",
  { format: formatFlag, json: jsonFlag },
  Effect.fn("examples")(function*(o) {
    const io = yield* Io
    const format = formatOf(o.json, o.format)
    const entries = exampleEntries(io)
    if (format !== "text") io.stdout(dump(entries, format))
    else io.stdout(`${table([["id", "title", "scenarios", "what it is"], ...entries.map((e) => [e.id, e.title, e.scenarios.join(", "), e.blurb.length > 80 ? `${e.blurb.slice(0, 77)}...` : e.blurb])])}\n\nRun one with: infra-sim run @<id> --duration 2m\nPlay one of its scenarios: infra-sim run @<id> --scenario <scenario>\n`)
  })
).pipe(
  Command.withShortDescription("List the example designs; `examples show <id>` prints one"),
  Command.withDescription("List the example designs that ship with the tool. Run one directly with `infra-sim run @<id>`."),
  Command.withExamples([
    { command: "infra-sim examples", description: "List them" },
    { command: "infra-sim examples show orders", description: "Print one" },
    { command: "infra-sim run @orders -d 2m", description: "Run one" }
  ]),
  Command.withSubcommands([examplesShow, examplesPath])
)

// ---------------------------------------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------------------------------------

const schema = Command.make(
  "schema",
  {
    which: Argument.Literals("which", ["design", "scenario"] as const).pipe(Argument.withDescription("design (default) or scenario: which file's schema"), Argument.optional)
  },
  Effect.fn("schema")(function*(o) {
    const io = yield* Io
    const which = Option.getOrElse(o.which, () => "design" as const)
    io.stdout(`${JSON.stringify(which === "scenario" ? DesignSchema.scenarioSchema() : DesignSchema.designSchema(registry), null, 2)}\n`)
  })
).pipe(
  Command.withShortDescription("Print the JSON Schema of a design (or scenario) file, for editors and agents"),
  Command.withDescription(block(
    "Print the JSON Schema of a design file (or a scenario file): every component's settings with their ranges, defaults",
    `and meaning. Editors read it from a design's first line (${DesignSchema.yamlModeline()}).`
  )),
  Command.withExamples([
    { command: "infra-sim schema > design.schema.json", description: "Save the design schema" },
    { command: "infra-sim schema scenario", description: "The schema of a scenario file" }
  ])
)

const TOPICS = ["cli", "assertions", "faults"] as const

const docs = Command.make(
  "docs",
  { topic: Argument.Literals("topic", TOPICS).pipe(Argument.withDescription("cli (default; the full guide), assertions (the assertion syntax) or faults (what can be injected)"), Argument.optional) },
  Effect.fn("docs")(function*(o) {
    const io = yield* Io
    const topic = undef(o.topic) ?? "cli"
    if (topic === "assertions") io.stdout(`${Scenario.ASSERTION_SYNTAX}\n`)
    else if (topic === "faults") io.stdout(`${Fault.catalog.map((k) => `${k.tag}  targets: ${k.targets.join(", ")}\n  ${k.help}`).join("\n\n")}\n\nIn a scenario: "Outage", "Slow(250ms)", "Errors(20%)", "Loss(10%)", "Blackhole", or an object { type: Slow, extra: 250ms }.\nTargets: node:<id>, edge:<id>, region:<placement> (region:aws:us-east-1).\n`)
    else {
      const file = io.assets("docs/CLI.md")
      if (!io.exists(file)) return yield* new UsageError("the CLI guide (docs/CLI.md) isn't available in this install")
      io.stdout(io.readFile(file))
    }
  })
).pipe(
  Command.withShortDescription("The full guide: scenarios, assertions, output, exit codes (topics: cli, assertions, faults)"),
  Command.withDescription("Print the full guide: scenarios, assertions, output, exit codes. Topics: cli (default), assertions, faults."),
  Command.withExamples([
    { command: "infra-sim docs", description: "The guide" },
    { command: "infra-sim docs assertions", description: "The assertion syntax" }
  ])
)

// ---------------------------------------------------------------------------------------------------------
// The command tree
// ---------------------------------------------------------------------------------------------------------

/** `infra-sim`: the root. Everything it prints for `--help` comes from the descriptions and examples on the commands above. */
export const root = Command.make("infra-sim").pipe(
  Command.withDescription(block(
    "Simulate cloud infrastructure under traffic and faults, from the command line.",
    "",
    "<file> is a path, or @<example-id> for an example that ships with the tool (infra-sim run @poshub). It can be a design",
    "(YAML/JSON), a scenario (YAML/JSON that names a design), or a template an importer reads.",
    "",
    "Output is text by default; --json (or --format json|yaml) prints the whole result as data for scripts and agents. Results",
    "go to stdout, messages and reports to stderr.",
    "",
    "Exit codes: 0 ok · 1 an assertion failed or a component crashed · 2 bad input (the message says what to fix) · 3 internal error",
    "",
    "Run `infra-sim <command> --help` for a command's options, or `infra-sim docs` for the guide."
  )),
  Command.withExamples([
    { command: "infra-sim examples", description: "See what ships with the tool" },
    { command: "infra-sim run @orders --duration 2m", description: "Run an example for two simulated minutes" },
    { command: `infra-sim run @orders -d 5m --scale 3 --fault "node:ingest Outage at=2m for=1m" --assert "system.errorRatio < 5%"`, description: "Triple the traffic, lose a node, assert on the outcome" },
    { command: "infra-sim import template.yaml --region eu-west-1 -o design.yaml", description: "Turn a CloudFormation template into a design" },
    { command: "infra-sim run scenario.yaml --json", description: "Run a scenario, the result as data" }
  ]),
  Command.withSubcommands([run, check, importCommand, convert, components, describe, examples, schema, docs])
)

// ---------------------------------------------------------------------------------------------------------
// The entry points
// ---------------------------------------------------------------------------------------------------------

/** The framework's built-in global flags, minus `--wizard` (an interactive prompt UI) and `--log-level` (the simulator logs nothing). */
const cliConfig = CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version, GlobalFlag.Completions] })

/** The framework prints with `Console`; this one collects it, so `program` can send it to `io` once it knows where it belongs. */
const collectingConsole = (out: Array<string>, err: Array<string>): Console.Console => {
  const noop = () => {}
  const line = (into: Array<string>) => (...args: ReadonlyArray<unknown>) => void into.push(`${args.map(String).join(" ")}\n`)
  return {
    assert: noop,
    clear: noop,
    count: noop,
    countReset: noop,
    debug: line(err),
    dir: noop,
    dirxml: noop,
    error: line(err),
    group: noop,
    groupCollapsed: noop,
    groupEnd: noop,
    info: line(err),
    log: line(out),
    table: noop,
    time: noop,
    timeEnd: noop,
    timeLog: noop,
    trace: line(err),
    warn: line(err)
  }
}

/** The framework's formatter, with errors in this tool's voice (`infra-sim: ...`) and colour decided by `io` rather than the process. */
const formatterFor = (io: IO, argv: ReadonlyArray<string>): CliOutput.Formatter => {
  const base = CliOutput.defaultFormatter({ colors: io.isTTY && io.env.NO_COLOR === undefined && !argv.includes("--no-color") })
  const message = (e: CliError.CliError) => `infra-sim: ${e.message}`
  return { ...base, formatError: message, formatCliError: message, formatErrors: (errors) => errors.map(message).join("\n") }
}

const versionOf = (io: IO): string => {
  const file = io.assets("package.json")
  return io.exists(file) ? ((JSON.parse(io.readFile(file)) as { version?: string }).version ?? "unknown") : "unknown"
}

/**
 * Run the CLI as an Effect: parse `argv`, run the command, print through `io`, and succeed with the exit code. It never fails:
 * every outcome (bad flags, bad input, a failed assertion, a bug) is an exit code and a message on stderr.
 *
 * Needs the platform services the framework asks for (file system, path, terminal, stdio, child processes): `NodeServices.layer`.
 */
export const program = (argv: ReadonlyArray<string>, io: IO) =>
  Effect.gen(function*() {
    const out: Array<string> = []
    const err: Array<string> = []
    const exit = yield* Command.runWith(root, { version: versionOf(io) })(argv).pipe(
      Effect.provideService(Io, io),
      Effect.provideService(Console.Console, collectingConsole(out, err)),
      Effect.provide(CliOutput.layer(formatterFor(io, argv))),
      Effect.provide(cliConfig),
      Effect.exit
    )
    if (exit._tag === "Success") {
      io.stdout(out.join(""))
      io.stderr(err.join(""))
      return EXIT.ok
    }
    const error = Cause.squash(exit.cause)
    if (CliError.isCliError(error) && error._tag === "ShowHelp") {
      // `--help` and a group command with nothing to run: the help is the answer. Bad flags: the reasons, not the whole help.
      if (error.errors.length === 0) {
        io.stdout(out.join(""))
        return EXIT.ok
      }
      io.stderr(err.join(""))
      io.stderr(`Run "${error.commandPath.join(" ")} --help" for usage.\n`)
      return EXIT.usage
    }
    if (error instanceof Exited) return error.code
    if (error instanceof UsageError) {
      io.stderr(`infra-sim: ${error.message}\n${error.issues.map((i) => `  ${i}\n`).join("")}`)
      return EXIT.usage
    }
    if (CliError.isCliError(error)) {
      io.stderr(`infra-sim: ${error.message}\n`)
      return EXIT.usage
    }
    io.stderr(`infra-sim: internal error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    return EXIT.internal
  })

/** Run the CLI. Returns the exit code; never throws and never exits the process, so it can be embedded and tested. */
export const main = async (argv: ReadonlyArray<string>, io: IO): Promise<number> => {
  try {
    return await Effect.runPromise(program(argv, io).pipe(Effect.provide(NodeServices.layer)))
  } catch (error) {
    io.stderr(`infra-sim: internal error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    return EXIT.internal
  }
}
