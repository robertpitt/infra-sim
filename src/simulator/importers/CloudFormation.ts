import type { Components } from "../Registry.ts"
import { asNumber, asString, Evaluator, parseTemplate } from "./Intrinsics.ts"
import { type ImportOptions, ImportError, type Importer, type ImportReport, type ImportResult } from "./Importer.ts"
import { api, apiWiring } from "./internal/cloudformation/apigateway.ts"
import { assemble } from "./internal/cloudformation/assemble.ts"
import { distribution, distributionWiring } from "./internal/cloudformation/cloudfront.ts"
import { table } from "./internal/cloudformation/dynamodb.ts"
import { eventSourceMapping, rule, samEvents, scheduleTargets } from "./internal/cloudformation/events.ts"
import { inferred } from "./internal/cloudformation/infer.ts"
import { aliases, lambda, lambdaWiring } from "./internal/cloudformation/lambda.ts"
import { type Bag, type Handler, type Resource, Run, type TemplateContext } from "./internal/cloudformation/model.ts"
import { bucket, customNotifications, notifications, replication } from "./internal/cloudformation/s3.ts"
import { configurationSet, eventDestination } from "./internal/cloudformation/ses.ts"
import { reasonFor } from "./internal/cloudformation/skips.ts"
import { inlineSubscriptions, subscribe, topic } from "./internal/cloudformation/sns.ts"
import { queue, redrive } from "./internal/cloudformation/sqs.ts"
import { traffic } from "./internal/cloudformation/traffic.ts"
import { natGateway, subnet, vpc, vpcEndpoint } from "./internal/cloudformation/vpc.ts"

/**
 * CloudFormation (and SAM, and `cdk synth` output) into a design.
 *
 * What a template describes is the system's parts and how they are wired; how it behaves under load is mostly not in
 * it. So the import carries over everything the template does say (memory, timeouts, visibility timeouts, retention,
 * redrive policies, billing modes and capacity, indexes and streams, batch sizes, throttles, caches, authorizers,
 * concurrency, schedules, subnets), draws the wiring it states (event source mappings, subscriptions, notifications,
 * replication, API integrations, CDN origins, rules) and the wiring it implies (environment variables and permissions
 * that name another resource), and adds traffic sources where something is called from outside. What it cannot know
 * (handler durations, how much traffic, which share of objects a filter lets through) keeps the component's default
 * or a documented assumption, and the report says so. Resources with no component yet are listed, never dropped quietly.
 *
 * Each AWS service has its own module in `./cloudformation/`; this file reads the template and runs the phases:
 *
 *  1. components: resources that become nodes (and settings that depend only on the resource itself);
 *  2. aliases: versions and aliases stand for their function, before anything refers to one;
 *  3. wiring the template states, resource by resource, then the SAM events declared on functions;
 *  4. settings and edges that need everything read first (`Run.later`);
 *  5. wiring the template implies, and traffic;
 *  6. assembly: settings checked against schemas, nodes put in boxes, edges drawn, laid out.
 */

/** Resources that become components. */
const COMPONENTS: Record<string, Handler> = {
  "AWS::Lambda::Function": lambda,
  "AWS::Serverless::Function": lambda,
  "AWS::SQS::Queue": queue,
  "AWS::SNS::Topic": topic,
  "AWS::DynamoDB::Table": table,
  "AWS::DynamoDB::GlobalTable": table,
  "AWS::Serverless::SimpleTable": table,
  "AWS::S3::Bucket": bucket,
  "AWS::S3Express::DirectoryBucket": bucket,
  "AWS::ApiGatewayV2::Api": api,
  "AWS::ApiGateway::RestApi": api,
  "AWS::Serverless::Api": api,
  "AWS::Serverless::HttpApi": api,
  "AWS::Events::Rule": rule,
  "AWS::Scheduler::Schedule": rule,
  "AWS::CloudFront::Distribution": distribution,
  "AWS::SES::ConfigurationSet": configurationSet,
  "AWS::EC2::VPC": vpc,
  "AWS::EC2::NatGateway": natGateway,
  "AWS::EC2::VPCEndpoint": vpcEndpoint
}

/** Types read before the others, because what sits in them is placed by looking them up. */
const CONTAINERS = ["AWS::EC2::VPC"]

/** What each resource says about how components connect, and the settings that need other components to exist. */
const WIRING: Record<string, Handler> = {
  "AWS::SQS::Queue": redrive,
  "AWS::Lambda::EventSourceMapping": eventSourceMapping,
  "AWS::SNS::Subscription": (run, r) => subscribe(run, r.props.TopicArn, r.props, r),
  "AWS::SNS::Topic": inlineSubscriptions,
  "AWS::S3::Bucket": (run, r) => {
    notifications(run, r)
    replication(run, r)
  },
  "Custom::S3BucketNotifications": customNotifications,
  "AWS::Events::Rule": scheduleTargets,
  "AWS::Scheduler::Schedule": scheduleTargets,
  "AWS::EC2::Subnet": subnet,
  "AWS::CloudFront::Distribution": distributionWiring,
  "AWS::SES::ConfigurationSetEventDestination": eventDestination,
  ...lambdaWiring,
  ...apiWiring
}

const run = (text: string, registry: Components, options: ImportOptions = {}): ImportResult => {
  let template: Bag
  try {
    template = parseTemplate(text)
  } catch (error) {
    throw new ImportError(`This isn't a CloudFormation template: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`)
  }
  const raw = template.Resources as Bag | undefined
  if (raw === undefined || typeof raw !== "object" || Object.keys(raw).length === 0) throw new ImportError("This isn't a CloudFormation template: it has no Resources section.")

  const regions = registry.provider("aws")?.regions.map((r) => r.id) ?? []
  const wanted = options.region ?? "us-east-1"
  const state = new Run({ region: regions.includes(wanted) ? wanted : "us-east-1", rps: options.rps ?? 20, knownRegions: regions })
  if (!regions.includes(wanted)) state.warnings.push(`${wanted} isn't an AWS region the simulator knows; using us-east-1.`)
  const fileName = options.fileName?.replace(/^.*[\\/]/, "")
  const stem = fileName?.replace(/\.[^.]+$/, "")

  // Parameters take their defaults; the rest of the template is evaluated against them.
  const parameters: Bag = {}
  const evaluator0 = new Evaluator({ parameters: {}, mappings: {}, conditions: {}, region: state.options.region, stackName: stem ?? "stack" })
  const declared = (template.Parameters ?? {}) as Bag
  for (const [name, def] of Object.entries(declared)) {
    if (def?.Default === undefined) continue
    parameters[name] = def.Type === "Number" ? (asNumber(def.Default) ?? def.Default) : evaluator0.value(def.Default)
  }
  const evaluator = new Evaluator({ parameters, mappings: (template.Mappings ?? {}) as Bag, conditions: (template.Conditions ?? {}) as Bag, region: state.options.region, stackName: stem ?? "stack" })
  for (const name of Object.keys(declared)) evaluator.parameterNames.add(name)

  for (const [id, def] of Object.entries(raw) as Array<[string, Bag]>) {
    const type = asString(def?.Type)
    if (type === undefined) continue
    if (def.Condition !== undefined) {
      const active = evaluator.condition(String(def.Condition))
      if (active === false) {
        state.skipped.push({ id, type, reason: `condition ${def.Condition} is false with the default parameters`, quiet: true })
        continue
      }
    }
    try {
      state.resources.set(id, { id, type, props: (evaluator.value(def.Properties ?? {}) ?? {}) as Bag, metadata: (def.Metadata ?? {}) as Bag })
    } catch (error) {
      // A property written in a way the evaluator can't follow costs that resource, and is reported.
      state.skipped.push({ id, type, reason: `its properties couldn't be read (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`, quiet: false })
    }
  }
  const resources = state.resources
  const context: TemplateContext = { resources, evaluator, events: [] }

  // 1. The components. Containers first: what sits in one finds it by name.
  const ordered: Array<Resource> = [...resources.values()].sort((a, b) => Number(CONTAINERS.includes(b.type)) - Number(CONTAINERS.includes(a.type)))
  for (const r of ordered) {
    const handler = COMPONENTS[r.type]
    if (handler === undefined) continue
    const before = state.drafts.size
    state.guard(r.id, () => handler(state, r, context), r)
    // A resource usually becomes one node; a global table becomes one per region.
    for (const made of [...state.drafts.values()].slice(before)) {
      if (made.origin?.ref === r.id && made.origin.type === r.type) state.converted.push({ id: r.id, type: r.type, node: made.id })
    }
  }
  // 2. Versions and aliases, 3. wiring, 4. what needed it all read, 5. what the template implies, and traffic.
  state.guard("Its versions and aliases", () => aliases(state, context))
  for (const r of resources.values()) {
    const wire = WIRING[r.type]
    if (wire !== undefined) state.guard(r.id, () => wire(state, r, context), r)
  }
  state.guard("A function's events", () => samEvents(state, context))
  state.flush()
  state.guard("What its functions use", () => inferred(state, context))
  traffic(state)

  const consumed = new Set(state.converted.map((c) => c.id))
  const skipped = new Set(state.skipped.map((c) => c.id))
  for (const r of resources.values()) {
    if (consumed.has(r.id) || skipped.has(r.id)) continue
    state.skipped.push({ id: r.id, type: r.type, ...reasonFor(r.type) })
  }

  // 6. The design.
  const { doc: assembled, preserved } = assemble(state, registry, options.name ?? (stem !== undefined && stem !== "" ? stem : "Imported template"))
  const declaredCount = state.wires.filter((w) => w.declared).length
  const inferredCount = state.wires.length - declaredCount
  const description = [
    asString(template.Description) ?? `Imported from ${fileName ?? "a CloudFormation template"}.`,
    "",
    `Imported from CloudFormation${fileName ? ` (${fileName})` : ""}: ${state.converted.length} resources became components, ${preserved} settings carried over, ${state.wires.length} connections (${inferredCount} inferred from environment variables and permissions).`,
    "Handler durations and traffic aren't in a template, so they are the defaults; set them to match your system."
  ].join("\n")

  const report: ImportReport = {
    importer: "cloudformation",
    converted: state.converted,
    skipped: state.skipped,
    added: state.added,
    settings: { preserved, adjusted: state.adjusted, unresolved: state.unresolved },
    connections: { declared: declaredCount, inferred: inferredCount },
    warnings: state.warnings
  }
  return { doc: { ...assembled, description }, report }
}

const detect = (text: string): boolean => {
  if (!text.includes("Resources")) return false
  try {
    const t = parseTemplate(text)
    const resources = t.Resources
    return (
      t.AWSTemplateFormatVersion !== undefined ||
      (typeof resources === "object" && resources !== null && Object.values(resources).some((r) => typeof (r as Bag)?.Type === "string" && /^(AWS|Custom)::/.test((r as Bag).Type)))
    )
  } catch {
    return false
  }
}

export const CloudFormation: Importer = {
  id: "cloudformation",
  title: "CloudFormation template",
  extensions: [".yaml", ".yml", ".json", ".template"],
  detect,
  run
}
