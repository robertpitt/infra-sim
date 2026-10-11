/** The text `infra-sim --help` and `infra-sim <command> --help` print. Kept in one place so the guide and the flags agree. */

export const HELP = `infra-sim: simulate cloud infrastructure under traffic and faults, from the command line.

Usage: infra-sim <command> [options]

Commands
  run <file>          Run a design or a scenario and report what happened (exit 1 if an assertion fails)
  check <file>        Validate a design or scenario without running it
  import <file>       Turn a CloudFormation/SAM/CDK template into a design (YAML)
  convert <file>      Convert a design between YAML and JSON
  components          List the components a design can use
  describe <type>     Show one component's settings, ranges, limits and ports (for example: describe aws.lambda)
  examples            List the example designs; "examples show <id>" prints one
  docs [topic]        The full guide: scenarios, assertions, output, exit codes (topics: cli, assertions, faults)

<file> is a path, or @<example-id> for an example that ships with the tool (infra-sim run @poshub).
It can be a design (YAML/JSON), a scenario (YAML/JSON that names a design), or a template an importer reads.

Quick start
  infra-sim examples
  infra-sim run @orders --duration 2m
  infra-sim run @orders -d 5m --scale 3 --fault "node:ingest Outage at=2m for=1m" --assert "system.errorRatio < 5%"
  infra-sim import template.yaml --region eu-west-1 -o design.yaml
  infra-sim run scenario.yaml --json

Output
  Text by default. --json (or --format json|yaml) prints the whole result as data for scripts and agents.
  Exit codes: 0 ok · 1 an assertion failed or a component crashed · 2 bad input (the message says what to fix) · 3 internal error

Run "infra-sim <command> --help" for a command's options, or "infra-sim docs" for the guide.
`

const RUN = `infra-sim run <file> [options]

Run a design or scenario on virtual time and report. A design runs as it is; a scenario adds a timeline of faults and
setting changes and assertions. Flags override what the file says.

  -d, --duration <t>       How long to simulate: 90s, 5m, 1h30m (default 60s, or the scenario's)
      --warmup <t>         Let the system settle first; summaries and assertions start after it
      --seed <n>           Random seed. The same design and seed always give the same result
      --scale <x>          Multiply every client's request rate (3 = three times the traffic)
      --set <id>:<path>=<v>  Override a setting (repeatable): api:stageThrottle.rate=500
                             edges: edge:<edge-id>:<path>=<v>   account quotas: account:aws:us-east-1:lambdaConcurrency=500
      --fault "<target> <fault> at=<t> [for=<t>]"
                           Inject a fault (repeatable): "node:fn Outage at=10s for=20s", "region:aws:us-east-1 Outage at=2m",
                           "edge:web.out->api Slow(250ms) at=1m for=30s". See: infra-sim docs faults
  -a, --assert "<expr>"    Add an assertion (repeatable): "api.errorRatio < 1%". See: infra-sim docs assertions
  -f, --format <text|json|yaml>   Output format (default text)      --json   same as --format json
  -o, --out <file>         Write the result to a file instead of stdout
      --frames <file.csv>  Also write every metrics frame as CSV (t_ms,scope,id,metric,value)
      --region <r>         For templates: the AWS region to place everything in (default us-east-1)
      --rps <n>            For templates: requests per second for traffic sources the template doesn't have
      --importer <id>      Force an importer (cloudformation)
      --nodes <n>          Rows in the node table (default 20)
  -q, --quiet              Don't print the import report
      --no-color

Exit: 0 every assertion held · 1 one failed or a component crashed · 2 the input was wrong
`

const CHECK = `infra-sim check <file> [options]

Validate a design or scenario without running it. Lists every problem at once, by id.

      --strict             Exit 1 on warnings too
      --region <r>, --importer <id>   For templates
  -f, --format <text|json|yaml>   --json
Exit: 0 ok · 2 errors (invalid settings, unknown ids, a scenario that can't run) · 1 only warnings, with --strict
`

const IMPORT = `infra-sim import <template> [options]

Turn a CloudFormation, SAM or "cdk synth" template (YAML or JSON) into a design. The design goes to stdout (or --out);
the report of what was converted, inferred, adjusted and left out goes to stderr.

  -o, --out <file>         Write the design here (.json writes JSON, anything else YAML)
  -f, --format <yaml|json>
      --json               Print { design, report } as JSON on stdout
      --region <r>         The AWS region to place everything in (default us-east-1)
      --rps <n>            Requests per second for traffic sources the template doesn't have (default 20)
      --no-report          Don't print the report
`

const CONVERT = `infra-sim convert <design> [options]

Convert a design file between YAML and JSON (to stdout, or --out; the extension picks the format).

  -o, --out <file>
  -f, --format <yaml|json>
`

const COMPONENTS = `infra-sim components [options]

List the components a design can use.

  -p, --provider <id>      aws | internet
  -c, --category <c>       compute | messaging | storage | network | traffic | external
  -s, --search <text>
  -f, --format <text|json|yaml>   --json
`

const DESCRIBE = `infra-sim describe <type> [options]

Everything needed to configure a component: every setting with its default and range, whether a limit is hard or an
adjustable quota, the ports edges leave from, and the service's published limits. Use it before writing a design.

  -f, --format <text|json|yaml>   --json (the full machine-readable manifest)
`

const EXAMPLES = `infra-sim examples [show <id> | path <id>] [options]

List the example designs, print one (show), or print where it lives (path).
Run one directly with: infra-sim run @<id>

  -f, --format <text|json|yaml>   --json
`

const DOCS = `infra-sim docs [topic]

Print the guide. Topics: cli (default; the full guide), assertions (the assertion syntax), faults (what can be injected).
`

const TOPICS: Readonly<Record<string, string>> = { run: RUN, check: CHECK, import: IMPORT, convert: CONVERT, components: COMPONENTS, describe: DESCRIBE, examples: EXAMPLES, docs: DOCS }

export const helpFor = (command: string): string => TOPICS[command] ?? HELP
