# infra-sim command line

Run designs and scenarios without a browser: from a terminal, a script, CI, or an agent. The same engine as the app, on
virtual time (a simulated hour runs in seconds), and deterministic: the same design and seed always give the same result.

```sh
npm run cli -- <command> ...                 # from this repository
npm run build:cli && node dist-cli/infra-sim.mjs <command> ...   # one bundled file, Node 22+ (also the `infra-sim` bin)
```

Everything below shows `infra-sim <command>`.

The command line is built with [`effect/cli`](https://effect.website) (Effect's CLI framework), so help, `--version`, shell
completions and the reporting of malformed flags come from the framework, and every flag below is described in
`infra-sim <command> --help`:

```sh
infra-sim --help                    # the commands, the file/@id convention, a quick start, exit codes
infra-sim run --help                # one command's arguments, flags and examples (works for every command)
infra-sim --version                 # also -v
infra-sim --completions zsh         # a shell completion script: bash, zsh, fish, powershell (also sh, pwsh)
```

`-h`, `--help`, `-v`, `--version` and `--completions <shell>` are global flags the framework adds to every command.

## Commands

| Command | Does |
| --- | --- |
| `run <file>` | Run a design or scenario and report. Exit 1 if an assertion fails. |
| `check <file>` | Validate without running: every problem at once, by id. |
| `import <file>` | CloudFormation / SAM / CDK template → design (YAML), with a report of what became of everything. |
| `convert <file>` | Design YAML ⇄ JSON. |
| `components` | List the components a design can use. |
| `describe <type>` | One component's settings (default, range, hard limit or adjustable quota), ports, service limits; or one connector's. |
| `examples` | The bundled example designs and their scenarios. `examples show <id>` prints one; `examples path <id>` says where it lives. |
| `schema [design\|scenario]` | The JSON Schema of a design file (or a scenario file), for editors and agents. |
| `docs [topic]` | This guide (`cli`), the assertion syntax (`assertions`), the faults (`faults`). |

`<file>` is a path, or `@<id>` for a bundled example (`infra-sim run @ingestion`). It may be a **design**, a **scenario**, or a
**template** an importer understands; the tool tells which by what is in it.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success: the run finished and every assertion held. |
| `1` | An assertion failed, or a component crashed during the run. (`check --strict`: warnings.) |
| `2` | The input was wrong: unreadable file, invalid design or scenario, unknown id, unknown flag, a missing argument or a value that isn't one (`--seed lots`). The message says what to fix. |
| `3` | Internal error (a bug). |

Messages go to stderr; the result goes to stdout (or `--out`). A malformed command line prints the reason and a pointer to
`infra-sim <command> --help` on stderr, never help text on stdout. `--help` and `--version` print on stdout and exit 0. Text is the default; `--json` (same as `--format json`) or
`--format yaml` prints the full result as data.

## Designs

A design is a YAML or JSON file: `nodes` (components, with only the settings you change), `edges` (who calls whom), optional
`accounts` (account-level quotas by placement). See the [README](../README.md#designs-are-files) and `examples/`.

Find what you can put in one:

```sh
infra-sim components --provider aws          # what exists
infra-sim describe aws.lambda                # every setting: default, range, hard/quota, plus ports and limits
infra-sim describe aws.sqs --json            # the same as data
infra-sim describe aws.sqs.event-source-mapping   # a connector: what sits on an edge, and its settings
```

Or let your editor tell you as you type: a design's first line points the YAML language server at the design's JSON Schema,

```yaml
# yaml-language-server: $schema=https://robertpitt.github.io/infra-sim/schema/design.schema.json
```

and VS Code (Red Hat YAML extension) then completes each component's settings and checks their ranges. `infra-sim schema`
prints the schema (`infra-sim schema scenario` for scenario files); `import` and `convert` write the line for you (in JSON,
`$schema`). The schema is generated from the components, so it never disagrees with `describe` or `check`; `check` still
catches what a schema can't, such as an edge to a node that doesn't exist.

`describe` shows which limits are **hard** (AWS enforces them: the range is the limit) and which are adjustable **quotas**
(the default is AWS's number; yours may differ). Durations are written as `"30 seconds"` or a number of milliseconds.

An edge's settings come from its port, its **connector** and transport. The connector is picked for you (a queue's
consumers get Lambda's event source mapping; every other call a plain link), or named on the edge:

```yaml
edges:
  orders.deliver->workers:
    from: {node: orders, port: deliver}
    to: workers
    connector: core.poller      # a fixed pool instead of Lambda's scaling poller
    settings: {workers: 20, batchSize: 10}
```

A **controller** changes a node while the design runs, the way an autoscaler does (`infra-sim describe core.target-tracking`):

```yaml
controllers:
  workers-autoscaler:
    type: core.target-tracking
    target: workers
    settings: {metric: inflight, targetValue: 0.7, setting: maxConcurrency, min: 2, max: 50}
```

## Running

```sh
infra-sim run design.yaml -d 5m --warmup 30s
infra-sim run @orders -d 5m --scale 3 --seed 11
infra-sim run @orders -d 5m --set "orders-table:mode=on-demand" --set "account:aws:us-east-1:lambdaConcurrency=200"
infra-sim run @multi-region -d 6m --fault "region:aws:us-east-1 Outage at=2m for=2m" --assert "users-us.errorRatio < 5%"
infra-sim run scenario.yaml --json > result.json
infra-sim run @ingestion -d 10m --frames frames.csv --json -o result.json
```

| Flag | |
| --- | --- |
| `-d, --duration <t>` | Simulated time: `90s`, `5m`, `1h30m`. Default 60s, or the scenario's. |
| `--warmup <t>` | Settle first. Summaries and assertions measure only what comes after. |
| `--seed <n>` | Random seed. |
| `--scale <x>` | Multiply every client's `rps`. |
| `--set <id>:<path>=<value>` | Override a setting (repeatable). Edges: `edge:<edge-id>:<path>=…`. Quotas: `account:<placement>:<path>=…`. Values are JSON or plain text. |
| `--fault "<target> <fault> at=<t> [for=<t>]"` | Inject a fault (repeatable). |
| `-a, --assert "<expr>"` | Add an assertion (repeatable). |
| `--frames <file.csv>` | Also write every metrics frame as long-format CSV: `t_ms,scope,id,metric,value`. |
| `--region`, `--rps`, `--importer` | For templates: where to place everything; traffic where the template has none. |
| `--nodes <n>` | Rows in the text node table (default 20). |
| `-o, --out`, `-f, --format`, `--json`, `-q`, `--no-color` | Output control. |

Time values (`--duration`, `at`, `for`, windows) take `250ms`, `90s`, `2m`, `1h30m`; a bare number is **seconds**.

## Scenarios

A scenario is what happens to a design: how long to run, with what traffic, what breaks and when, and what must hold.
Scenarios are usually written **in the design**, under `scenarios`, because they name its nodes; each example carries one
or more (`infra-sim examples` lists them). Play one with `--scenario <id>`:

```yaml
# in the design (examples/05-multi-region.yaml)
scenarios:
  lose-us-east-1:
    name: Lose us-east-1
    duration: 6m
    timeline:
      - { at: 2m, inject: { target: "region:aws:us-east-1", fault: Outage, for: 2m } }
    assert:
      - { check: "users-eu.errorRatio > 90%", from: 2m30s, to: 4m }
```

```bash
infra-sim run @multi-region --scenario lose-us-east-1
infra-sim check @multi-region                    # also checks every scenario the design carries
```

A scenario can also be a file of its own that names its design (useful for scenarios kept apart from the design, or for a
template an importer reads). Its fields are the same, plus `version` and `design`. YAML or JSON:

```yaml
version: 1
name: Lose us-east-1
design: ../examples/05-multi-region.yaml   # path (relative to this file) to a design, or a template an importer reads; or an inline design
seed: 5
duration: 6m
warmup: 30s
traffic: { scale: 1 }               # multiply every client's rps
overrides:                          # applied at the start, merged over the design's own settings
  nodes:    { orders-table: { mode: on-demand } }
  edges:    { "web.out->api": { timeout: 5 seconds } }
  accounts: { "aws:us-east-1": { lambdaConcurrency: 500 } }
timeline:                           # things that happen at a time (one action per event; `note` alone annotates)
  - at: 2m
    inject: { target: "region:aws:us-east-1", fault: Outage, for: 2m, id: us-down }
    note: us-east-1 goes down
  - at: 3m
    set: { node: web, settings: { rps: 500 } }          # a live setting change, merged over what the node has
  - at: 3m30s
    account: { placement: "aws:eu-west-1", settings: { lambdaConcurrency: 2000 } }
  - at: 4m
    clear: us-down                                      # a fault's id, or "all"
assert:
  - api.errorRatio < 1%
  - { name: Europe keeps serving, check: "users-eu.errorRatio < 1%", from: 2m30s, to: 4m }
```

`infra-sim check scenario.yaml` (or `check design.yaml` for the scenarios a design carries) lists every problem at once
(unknown node ids, bad times, unreadable assertions, each named by its scenario) and exits 2 if there are any; `run` refuses
to start with the same list. In the app, the Scenario tab lists the open design's scenarios, plays them live, and can add a
scenario file to the design ("Add from file…") if everything it names is there.

### Faults

`infra-sim docs faults` lists them. Written as `Outage`, `Blackhole`, `Slow(250ms)`, `Errors(20%)`, `Loss(10%)`, `Crash(2)` (two of a fleet's units; `Crash(1 host)` for a host under them), or as an object
`{ type: Slow, extra: 250ms }`. Targets: `node:<id>`, `edge:<id>`, `region:<placement>` (every node in it, e.g.
`region:aws:us-east-1`), `zone:<placement>:<zone>` (every node placed in that zone and every fleet unit running there, e.g.
`zone:aws:us-east-1:us-east-1a`). A fault without `for` lasts until cleared.

### Assertions

`infra-sim docs assertions` prints the grammar. `<subject>.<metric>[:<aggregate>] <op> <value> [@ <from>..<to>]`:

| Part | Values |
| --- | --- |
| subject | a node id; `edge:<edge id>`; `system` (every client together: what users saw) |
| metric | `errorRatio`, `successRatio`, `throughput`; `rate.<counter>` (per second: `rate.ok`, `rate.fail`, `rate.fail.Throttled`, `rate.in`, `rate.sent`); `total.<counter>`; `gauge.<name>` (`gauge.depth`, `gauge.concurrent`); `latency.<p50\|p95\|p99\|mean\|max>`, `dist.<name>.<stat>` |
| aggregate | how to combine the window's frames: `mean` (default), `max`, `min`, `last`, `sum` |
| op | `<` `<=` `>` `>=` `==` `!=` |
| value | a number with an optional unit: `500ms`, `2s`, `1.5%`, `10/s` |
| window | `@ 2m..3m`, or `from` / `to` in the object form; default: after the warm-up to the end |

Examples: `api.errorRatio < 1%` · `system.latency.p99 < 800ms` · `orders-queue.gauge.depth:max < 5000` ·
`fn.rate.fail.Throttled == 0` · `edge:web.out->api.rate.fail < 5/s @ 4m..6m`.

Percentiles over a window are a sample-weighted estimate from per-frame summaries, not an exact quantile; `:max` is exact.
Find node and edge ids and counter names in `run --json` output (`nodes.<id>.rates`, `.gauges`, `.dist`).

## Output

`--json` prints one object:

| Field | |
| --- | --- |
| `scenario`, `seed`, `duration`, `warmup` | What ran. Times in simulated **ms**. |
| `wallMs`, `frameMs` | Real time the run took; metrics window. |
| `passed` | Every assertion held and no component crashed. |
| `system` | What clients saw: `rates`, `gauges`, `dist` (latency percentiles in ms), `totals {in, ok, fail}`, `errorRatio`. |
| `nodes.<id>`, `edges.<id>` | The same summary for each node (with `type`, `name`) and edge, over the measured window. Rates are per second. |
| `timeline` | The scenario's events as they happened. |
| `faults` | Each injected fault: `id`, `target`, `fault`, `from`, `to`. |
| `assertions` | Each: `check`, `name`, `passed`, `actual`, `expected {op, value}`, `window {from, to}`, `problem` if it couldn't be checked. |
| `alerts` | What the standard alarms raised: `rule`, `title`, `severity` (`critical` when clients see it, else `warning`), `target`, `check`, `unit`, `firedAt`, `resolvedAt` (absent if still firing), `value`, `peak`. Information, not a verdict: alerts never fail a run. |
| `defects` | Components that crashed instead of failing a call (any makes `passed` false). |
| `diagnostics` | Warnings about the design (feedback loops, unreachable nodes, quota overages). |
| `input` | The file, its kind, the design it used, and the import report if a template was imported. |

Per node, counters you will see include `in`, `ok`, `fail`, `fail.<Kind>` (`Throttled`, `Unavailable`, `Timeout`, `Failed`,
`Rejected`), plus whatever the component records (`describe` and each service's README under `src/simulator/aws/` list them).

## Importing

```sh
infra-sim import template.yaml --region eu-west-1 -o design.yaml     # design to the file, report to stderr
infra-sim run template.yaml -d 2m --rps 50                           # or run a template directly
infra-sim import template.yaml --json | jq .report                   # { design, report } as data
```

Reads CloudFormation, SAM and `cdk synth` output (YAML or JSON). Carries over the settings it can, draws the wiring the
template states and implies, adds traffic where something is called from outside, and reports everything converted,
inferred, adjusted and left out. See the README.

## For agents

A reliable loop for writing and testing a design:

1. `infra-sim components --json` and `infra-sim describe <type> --json`: what exists and exactly which settings, ranges
   and limits apply. Don't guess setting names.
2. Write the design (see `infra-sim examples show orders` for the shape) and a scenario.
3. `infra-sim check <file> --json`: fix every listed problem in one pass (exit 2 means the input is wrong).
4. `infra-sim run <file> --json`: read `passed`, `assertions[].actual`, and the nodes that throttle or fail
   (`nodes.<id>.rates["fail.Throttled"]`, `totals`, `gauges.depth.max`).
5. Change one thing (`--set`, `--scale`, `--fault`) and rerun. Same seed, same randomness: differences are the change.

Runs are cheap, so sweep: loop `--scale 1 2 4 8` and compare `system.errorRatio` and `system.dist.latency.p99`.
