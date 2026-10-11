import { parseArgs } from "node:util"
import path from "node:path"
import { Effect } from "effect"
import YAML from "yaml"
import { builtinLayer, Design, Diagnostics, Fault, importers, type Importer, Scenario } from "#simulator"
import { registry } from "#simulator/components"
import { exampleFiles, encodeDesign, load, type Loaded, resolveReference, stem, UsageError } from "./load.ts"
import { fmtDuration, makeStyle, renderComponent, renderDiagnostics, renderFrames, renderImportReport, renderResult, table } from "./format.ts"
import type { IO } from "./io.ts"
import { HELP, helpFor } from "./help.ts"

/**
 * infra-sim: run designs and scenarios from a terminal, a script or an agent.
 *
 * Exit codes: 0 success (every assertion held), 1 an assertion failed or a component crashed, 2 the input was wrong
 * (a file that isn't valid, a scenario that names things that don't exist, a bad flag), 3 an internal error.
 */
export const EXIT = { ok: 0, failed: 1, usage: 2, internal: 3 } as const

/** The flags a command was given, by name. Read them with `str`, `strs`, `num` or a boolean test. */
type Options = Record<string, unknown>

type Spec = Record<string, { readonly type: "string" | "boolean"; readonly short?: string; readonly multiple?: boolean }>

/** Parse a command's flags. A bad flag is a usage error with the reason, not a stack trace. */
const parse = (argv: ReadonlyArray<string>, options: Spec, positionals = true): { values: Options; positionals: ReadonlyArray<string> } => {
  try {
    const parsed = parseArgs({ args: [...argv], options: { help: { type: "boolean", short: "h" }, ...options }, allowPositionals: positionals, strict: true })
    return { values: parsed.values as Options, positionals: parsed.positionals }
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message.replace(/^.*?:\s*/, "") : String(error))
  }
}

/** Write a file, relative paths resolved from the directory the CLI was run in. */
const write = (io: IO, file: string, text: string): void => io.writeFile(path.resolve(io.cwd(), file), text)

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
const strs = (v: unknown): ReadonlyArray<string> => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : [])
const num = (v: unknown, flag: string): number | undefined => {
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isFinite(n)) throw new UsageError(`${flag}: "${String(v)}" is not a number`)
  return n
}

type Format = "text" | "json" | "yaml"
const formatOf = (values: Options, fallback: Format = "text"): Format => {
  if (values.json === true) return "json"
  const f = str(values.format)
  if (f === undefined) return fallback
  if (f !== "text" && f !== "json" && f !== "yaml") throw new UsageError(`--format: "${f}" is not text, json or yaml`)
  return f
}

const dump = (value: unknown, format: Format): string => (format === "yaml" ? YAML.stringify(value, { lineWidth: 0 }) : `${JSON.stringify(value, null, 2)}\n`)

const importerOf = (id: string | undefined): Importer | undefined => {
  if (id === undefined) return undefined
  const found = importers.find((i) => i.id === id)
  if (found === undefined) throw new UsageError(`--importer: no importer called "${id}"`, [`available: ${importers.map((i) => i.id).join(", ")}`])
  return found
}

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

const runCommand = async (argv: ReadonlyArray<string>, io: IO): Promise<number> => {
  const { values, positionals } = parse(argv, {
    duration: { type: "string", short: "d" },
    warmup: { type: "string" },
    seed: { type: "string" },
    scale: { type: "string" },
    set: { type: "string", multiple: true },
    fault: { type: "string", multiple: true },
    assert: { type: "string", short: "a", multiple: true },
    format: { type: "string", short: "f" },
    json: { type: "boolean" },
    out: { type: "string", short: "o" },
    frames: { type: "string" },
    region: { type: "string" },
    rps: { type: "string" },
    importer: { type: "string" },
    nodes: { type: "string" },
    quiet: { type: "boolean", short: "q" },
    "no-color": { type: "boolean" }
  })
  if (values.help) return help(io, "run")
  const [file] = positionals
  if (file === undefined || positionals.length > 1) throw new UsageError("run: give one design, scenario or template file (or @example-id)")

  const loaded = load(io, file, { ...(str(values.region) === undefined ? {} : { region: str(values.region)! }), ...(num(values.rps, "--rps") === undefined ? {} : { rps: num(values.rps, "--rps")! }) }, importerOf(str(values.importer)))
  const { design, scenario: fromFile } = designAndScenario(loaded, file)

  // Flags win over the file.
  const overrides = { nodes: { ...(fromFile.overrides?.nodes ?? {}) } as Record<string, Record<string, unknown>>, edges: { ...(fromFile.overrides?.edges ?? {}) } as Record<string, Record<string, unknown>>, accounts: { ...(fromFile.overrides?.accounts ?? {}) } as Record<string, Record<string, unknown>> }
  for (const text of strs(values.set)) {
    const s = parseSet(text)
    const bag = (overrides[s.kind][s.id] ??= {})
    setPath(bag, s.path, s.value)
  }
  const scale = num(values.scale, "--scale")
  const seed = num(values.seed, "--seed")
  const scenario: Scenario.Scenario = {
    ...fromFile,
    duration: str(values.duration) ?? fromFile.duration ?? "60s",
    ...(str(values.warmup) === undefined ? {} : { warmup: str(values.warmup)! }),
    ...(seed === undefined ? {} : { seed }),
    ...(scale === undefined ? {} : { traffic: { scale } }),
    overrides,
    timeline: [...(fromFile.timeline ?? []), ...strs(values.fault).map(parseFaultFlag)],
    assert: [...(fromFile.assert ?? []), ...strs(values.assert)]
  }

  const style = makeStyle(io.isTTY && values["no-color"] !== true && io.env.NO_COLOR === undefined && formatOf(values) === "text")
  if (values.quiet !== true && loaded.imported !== undefined) io.stderr(renderImportReport(loaded.imported.report, style))
  const result = await Effect.runPromise(
    Scenario.run(design, scenario, { keepFrames: values.frames !== undefined }).pipe(
      Effect.provide(builtinLayer),
      Effect.mapError((e) => new UsageError(`${file}: the scenario can't run`, e.issues))
    )
  )
  const diagnostics = Diagnostics.diagnose(design, registry).filter((d) => d.level !== "info")
  const full = { ...result, diagnostics, input: { file: loaded.file, kind: loaded.kind, ...(loaded.kind === "scenario" && loaded.designFile !== undefined ? { design: loaded.designFile } : {}), ...(loaded.imported === undefined ? {} : { imported: loaded.imported.report }) } }

  if (str(values.frames) !== undefined) write(io, str(values.frames)!, renderFrames(result.frames ?? []))
  const { frames: _frames, ...publish } = full
  const format = formatOf(values)
  const text = format === "text" ? renderResult(result, style, { nodes: num(values.nodes, "--nodes") ?? 20 }) + (diagnostics.length > 0 ? `\nDesign warnings\n${renderDiagnostics(diagnostics, style)}\n` : "") : dump(publish, format)
  if (str(values.out) !== undefined) write(io, str(values.out)!, text)
  else io.stdout(text)
  return result.passed ? EXIT.ok : EXIT.failed
}

const designAndScenario = (loaded: Loaded, file: string): { design: Design.Doc; scenario: Scenario.Scenario } => {
  if (loaded.kind === "design") return { design: loaded.doc, scenario: { version: 1 } }
  if (loaded.design === undefined) throw new UsageError(`${file}: the scenario has no design (add \`design: path/to/design.yaml\`)`)
  return { design: loaded.design, scenario: loaded.scenario }
}

// ---------------------------------------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------------------------------------

const checkCommand = (argv: ReadonlyArray<string>, io: IO): number => {
  const { values, positionals } = parse(argv, { format: { type: "string", short: "f" }, json: { type: "boolean" }, strict: { type: "boolean" }, region: { type: "string" }, importer: { type: "string" }, "no-color": { type: "boolean" } })
  if (values.help) return help(io, "check")
  const [file] = positionals
  if (file === undefined || positionals.length > 1) throw new UsageError("check: give one design, scenario or template file")
  const loaded = load(io, file, str(values.region) === undefined ? {} : { region: str(values.region)! }, importerOf(str(values.importer)))
  const { design, scenario } = designAndScenario(loaded.kind === "scenario" && loaded.design === undefined ? { ...loaded, design: Design.empty() } : loaded, file)
  const diagnostics = Diagnostics.diagnose(design, registry)
  const issues = loaded.kind === "scenario" ? Scenario.check(design, scenario) : []
  const errors = diagnostics.filter((d) => d.level === "error")
  const warnings = diagnostics.filter((d) => d.level === "warning")
  const ok = errors.length === 0 && issues.length === 0 && (values.strict !== true || warnings.length === 0)
  const format = formatOf(values)
  if (format !== "text") io.stdout(dump({ ok, kind: loaded.kind, nodes: Object.keys(design.nodes).length, edges: Object.keys(design.edges).length, diagnostics, scenarioIssues: issues }, format))
  else {
    const style = makeStyle(io.isTTY && values["no-color"] !== true && io.env.NO_COLOR === undefined)
    io.stdout(`${style.bold(file)}: ${loaded.kind}, ${Object.keys(design.nodes).length} nodes, ${Object.keys(design.edges).length} edges\n`)
    if (diagnostics.length > 0) io.stdout(`${renderDiagnostics(diagnostics, style)}\n`)
    for (const issue of issues) io.stdout(`${style.red("scenario")} ${issue}\n`)
    io.stdout(ok ? `${style.green("ok")}\n` : `${style.red("not ok")}\n`)
  }
  return ok ? EXIT.ok : errors.length > 0 || issues.length > 0 ? EXIT.usage : EXIT.failed
}

// ---------------------------------------------------------------------------------------------------------
// import, convert
// ---------------------------------------------------------------------------------------------------------

const importCommand = (argv: ReadonlyArray<string>, io: IO): number => {
  const { values, positionals } = parse(argv, {
    out: { type: "string", short: "o" },
    format: { type: "string", short: "f" },
    json: { type: "boolean" },
    region: { type: "string" },
    rps: { type: "string" },
    importer: { type: "string" },
    "no-report": { type: "boolean" },
    "no-color": { type: "boolean" }
  })
  if (values.help) return help(io, "import")
  const [file] = positionals
  if (file === undefined || positionals.length > 1) throw new UsageError("import: give one template file")
  const loaded = load(io, file, { ...(str(values.region) === undefined ? {} : { region: str(values.region)! }), ...(num(values.rps, "--rps") === undefined ? {} : { rps: num(values.rps, "--rps")! }) }, importerOf(str(values.importer)) ?? importers[0])
  if (loaded.kind !== "design" || loaded.imported === undefined) throw new UsageError(`${file}: not something an importer reads (it is already a ${loaded.kind}; use \`convert\` to change its format)`)
  const asJson = values.json === true
  const style = makeStyle(io.isTTY && values["no-color"] !== true && io.env.NO_COLOR === undefined)
  if (asJson) {
    const text = dump({ design: loaded.doc, report: loaded.imported.report }, "json")
    if (str(values.out) !== undefined) write(io, str(values.out)!, text)
    else io.stdout(text)
    return EXIT.ok
  }
  const out = str(values.out)
  const format: "yaml" | "json" = str(values.format) === "json" || (out !== undefined && out.endsWith(".json")) ? "json" : "yaml"
  const text = encodeDesign(loaded.doc, format)
  if (out !== undefined) write(io, out, text)
  else io.stdout(text)
  if (values["no-report"] !== true) io.stderr(renderImportReport(loaded.imported.report, style))
  return EXIT.ok
}

const convertCommand = (argv: ReadonlyArray<string>, io: IO): number => {
  const { values, positionals } = parse(argv, { out: { type: "string", short: "o" }, format: { type: "string", short: "f" } })
  if (values.help) return help(io, "convert")
  const [file] = positionals
  if (file === undefined || positionals.length > 1) throw new UsageError("convert: give one design file")
  const loaded = load(io, file)
  if (loaded.kind !== "design") throw new UsageError(`${file}: a scenario can't be converted here; convert its design`)
  const out = str(values.out)
  const requested = str(values.format)
  if (requested !== undefined && requested !== "yaml" && requested !== "json") throw new UsageError(`--format: "${requested}" is not yaml or json`)
  const format: "yaml" | "json" = requested === "json" || (requested === undefined && out?.endsWith(".json") === true) ? "json" : "yaml"
  const text = encodeDesign(loaded.doc, format)
  if (out === undefined) io.stdout(text)
  else write(io, out, text)
  return EXIT.ok
}

// ---------------------------------------------------------------------------------------------------------
// components, describe, examples, docs
// ---------------------------------------------------------------------------------------------------------

const componentsCommand = (argv: ReadonlyArray<string>, io: IO): number => {
  const { values } = parse(argv, { provider: { type: "string", short: "p" }, category: { type: "string", short: "c" }, search: { type: "string", short: "s" }, format: { type: "string", short: "f" }, json: { type: "boolean" } }, false)
  if (values.help) return help(io, "components")
  const search = str(values.search)?.toLowerCase()
  const list = registry.manifests.filter(
    (m) =>
      (str(values.provider) === undefined || m.provider === values.provider) &&
      (str(values.category) === undefined || m.category === values.category) &&
      (search === undefined || [m.type, m.title, m.service, m.description].some((t) => t.toLowerCase().includes(search)))
  )
  const format = formatOf(values)
  if (format !== "text") {
    io.stdout(dump(list.map((m) => ({ type: m.type, provider: m.provider, service: m.service, title: m.title, category: m.category, description: m.description, ports: m.outputs.map((o) => o.port), container: m.container !== undefined })), format))
    return EXIT.ok
  }
  io.stdout(`${table([["type", "provider", "category", "description"], ...list.map((m) => [m.type, m.provider, m.category, m.description.length > 80 ? `${m.description.slice(0, 77)}...` : m.description])])}\n`)
  return EXIT.ok
}

const describeCommand = (argv: ReadonlyArray<string>, io: IO): number => {
  const { values, positionals } = parse(argv, { format: { type: "string", short: "f" }, json: { type: "boolean" }, "no-color": { type: "boolean" } })
  if (values.help) return help(io, "describe")
  const [type] = positionals
  if (type === undefined || positionals.length > 1) throw new UsageError("describe: give a component type, for example aws.lambda (see `infra-sim components`)")
  const manifest = registry.manifests.find((m) => m.type === type) ?? registry.manifests.find((m) => m.type === `aws.${type}` || m.type === `common.${type}`)
  if (manifest === undefined) {
    const near = registry.manifests.filter((m) => m.type.includes(type.toLowerCase())).map((m) => m.type)
    throw new UsageError(`no component called "${type}"`, [near.length > 0 ? `did you mean: ${near.join(", ")}` : `components: ${registry.manifests.map((m) => m.type).join(", ")}`])
  }
  const format = formatOf(values)
  if (format !== "text") io.stdout(dump(manifest, format))
  else io.stdout(renderComponent(manifest, makeStyle(io.isTTY && values["no-color"] !== true && io.env.NO_COLOR === undefined)))
  return EXIT.ok
}

const examplesCommand = (argv: ReadonlyArray<string>, io: IO): number => {
  const { values, positionals } = parse(argv, { format: { type: "string", short: "f" }, json: { type: "boolean" } })
  if (values.help) return help(io, "examples")
  const files = exampleFiles(io)
  const entry = (f: string) => {
    const file = path.join(io.assets("examples"), f)
    const doc = (YAML.parse(io.readFile(file)) ?? {}) as { name?: string; description?: string }
    return { id: stem(f), title: doc.name ?? stem(f), blurb: (doc.description ?? "").split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").trim() ?? "", file }
  }
  const [sub, id] = positionals
  if (sub === "show" || sub === "path") {
    if (id === undefined) throw new UsageError(`examples ${sub}: give an example id`)
    const file = resolveReference(io, `@${id}`)
    io.stdout(sub === "path" ? `${file}\n` : io.readFile(file))
    return EXIT.ok
  }
  if (sub !== undefined) throw new UsageError(`examples: unknown subcommand "${sub}" (show <id>, path <id>)`)
  const format = formatOf(values)
  const entries = files.map(entry)
  if (format !== "text") io.stdout(dump(entries, format))
  else io.stdout(`${table([["id", "title", "what it is"], ...entries.map((e) => [e.id, e.title, e.blurb.length > 90 ? `${e.blurb.slice(0, 87)}...` : e.blurb])])}\n\nRun one with: infra-sim run @<id> --duration 2m\n`)
  return EXIT.ok
}

const docsCommand = (argv: ReadonlyArray<string>, io: IO): number => {
  const { positionals, values } = parse(argv, {})
  if (values.help) return help(io, "docs")
  const [topic] = positionals
  if (topic === "assertions") io.stdout(`${Scenario.ASSERTION_SYNTAX}\n`)
  else if (topic === "faults") io.stdout(`${Fault.catalog.map((k) => `${k.tag}  targets: ${k.targets.join(", ")}\n  ${k.help}`).join("\n\n")}\n\nIn a scenario: "Outage", "Slow(250ms)", "Errors(20%)", "Loss(10%)", "Blackhole", or an object { type: Slow, extra: 250ms }.\nTargets: node:<id>, edge:<id>, region:<placement> (region:aws:us-east-1).\n`)
  else if (topic === undefined || topic === "cli") {
    const file = io.assets("docs/CLI.md")
    if (!io.exists(file)) throw new UsageError("the CLI guide (docs/CLI.md) isn't available in this install")
    io.stdout(io.readFile(file))
  } else throw new UsageError(`docs: no topic "${topic}"`, ["topics: cli (default), assertions, faults"])
  return EXIT.ok
}

const help = (io: IO, command?: string): number => {
  io.stdout(command === undefined ? HELP : helpFor(command))
  return EXIT.ok
}

// ---------------------------------------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------------------------------------

/** Run the CLI. Returns the exit code; never throws and never exits the process, so it can be embedded and tested. */
export const main = async (argv: ReadonlyArray<string>, io: IO): Promise<number> => {
  const [command, ...rest] = argv
  try {
    switch (command) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        return help(io, rest[0])
      case "--version":
      case "-v":
      case "version": {
        const file = io.assets("package.json")
        io.stdout(`${io.exists(file) ? (JSON.parse(io.readFile(file)) as { version?: string }).version : "unknown"}\n`)
        return EXIT.ok
      }
      case "run":
        return await runCommand(rest, io)
      case "check":
        return checkCommand(rest, io)
      case "import":
        return importCommand(rest, io)
      case "convert":
        return convertCommand(rest, io)
      case "components":
        return componentsCommand(rest, io)
      case "describe":
        return describeCommand(rest, io)
      case "examples":
        return examplesCommand(rest, io)
      case "docs":
        return docsCommand(rest, io)
      default:
        throw new UsageError(`unknown command "${command}"`, ["commands: run, check, import, convert, components, describe, examples, docs, version (see --help)"])
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`infra-sim: ${error.message}\n${error.issues.map((i) => `  ${i}\n`).join("")}`)
      return EXIT.usage
    }
    io.stderr(`infra-sim: internal error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    return EXIT.internal
  }
}

void fmtDuration
