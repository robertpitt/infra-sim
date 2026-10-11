import { asBoolean, asString } from "../Intrinsics.ts"
import { apiEvent, implicitApi, apiOf } from "./apigateway.ts"
import { streamConsumer } from "./dynamodb.ts"
import { type Bag, type Draft, type Handler, listOf, nameOf, type Resource, type Run, SOURCE, type TemplateContext } from "./model.ts"
import { addNotification } from "./s3.ts"
import { scheduleRate } from "./schedules.ts"
import { queueConsumer } from "./sqs.ts"
import { snsEvent } from "./sns.ts"

/**
 * What makes a function run: event source mappings, schedules, and the events SAM declares on a function. A trigger
 * that comes from a service with no component is reported, never dropped.
 */

/** `AWS::Lambda::EventSourceMapping`: a function reading from a queue or a table's stream. */
export const eventSourceMapping: Handler = (run, r) => {
  const p = r.props
  const fn = run.targets(p.FunctionName)[0]
  const source = run.targets(p.EventSourceArn)[0]
  if (fn === undefined) return
  const supported = source?.type === "aws.sqs" || source?.type === "aws.dynamodb"
  if (!supported) {
    run.warn(`${fn.name} reads from ${source === undefined ? "a stream outside this template" : source.name}, which the simulator can't model as an event source yet, so it isn't connected.`)
    run.skip(r, "only SQS queues and DynamoDB streams are modelled as event sources")
    return
  }
  if (asBoolean(p.Enabled) === false) {
    run.skip(r, "the mapping is disabled", true)
    return
  }
  const origin = { source: SOURCE, ref: r.id }
  if (source.type === "aws.sqs") queueConsumer(run, source, fn, p, origin)
  else streamConsumer(run, source, fn, p, origin)
  run.consumed(r, fn)
}

/** `AWS::Events::Rule` and `AWS::Scheduler::Schedule`: a schedule becomes a source of traffic; other rules say nothing about how often. */
export const rule: Handler = (run, r) => {
  const p = r.props
  const expression = asString(p.ScheduleExpression)
  const name = asString(p.Name) ?? nameOf(r)
  if (p.State === "DISABLED") {
    run.skip(r, "the rule is disabled", true)
    return
  }
  if (expression === undefined) {
    // A rule that matches events from other services: the traffic comes from whatever emits them.
    run.skip(r, "matches events from other services, so its traffic comes from something this template doesn't contain")
    return
  }
  const rate = scheduleRate(expression)
  if (rate === undefined) {
    run.skip(r, `schedule "${expression}" couldn't be read`)
    return
  }
  const d = run.draft(r.id, `Schedule: ${name}`, "common.client", { source: "assumed", ref: r.id, type: r.type })
  run.set(d, ["rps"], rate.rps, "ScheduleExpression")
  run.set(d, ["arrival"], "constant", "ScheduleExpression")
  run.set(d, ["invocation"], "async", "ScheduleExpression")
  if (!rate.exact) run.warn(`${d.name}: "${expression}" is approximated as about ${(rate.rps * 3600).toFixed(2)} runs an hour.`)
}

/** What a schedule fires at. */
export const scheduleTargets = (run: Run, r: Resource): void => {
  const client = run.drafts.get(r.id)
  if (client === undefined) return
  const targets = r.type === "AWS::Scheduler::Schedule" ? [r.props.Target] : listOf(r.props.Targets)
  for (const t of targets) for (const to of run.targets(t?.Arn)) run.wire(client, "out", to, { origin: { source: SOURCE, ref: r.id } })
}

/** The triggers declared on SAM functions, once every component exists. */
export const samEvents = (run: Run, ctx: TemplateContext): void => {
  const implicit = new Map<"rest" | "http", Draft>()
  for (const declared of ctx.events) run.guard(`${declared.fn.name}'s ${declared.name} event`, () => samEvent(run, declared, implicit))
}

const samEvent = (run: Run, { fn, name, event }: TemplateContext["events"][number], implicit: Map<"rest" | "http", Draft>): void => {
  const type = asString(event.Type)
  const p = (event.Properties ?? {}) as Bag
  const origin = { source: SOURCE, ref: `${fn.origin?.ref ?? fn.name}.Events.${name}` }
  switch (type) {
    case "SQS": {
      const source = run.targets(p.Queue)[0]
      if (source?.type === "aws.sqs" && asBoolean(p.Enabled) !== false) queueConsumer(run, source, fn, p, origin)
      break
    }
    case "DynamoDB": {
      const source = run.targets(p.Stream)[0]
      if (source?.type === "aws.dynamodb" && asBoolean(p.Enabled) !== false) streamConsumer(run, source, fn, p, origin)
      else if (source === undefined) run.warn(`${fn.name} reads a DynamoDB stream (${name}) that isn't in this template, so it isn't connected.`)
      break
    }
    case "SNS":
      snsEvent(run, fn, p, origin)
      break
    case "S3": {
      const from = run.targets(p.Bucket)[0]
      if (from?.type === "aws.s3") addNotification(run, from, fn, listOf(p.Events), p.Filter as Bag | undefined, origin)
      break
    }
    case "Api":
    case "HttpApi": {
      const kind = type === "HttpApi" ? "http" : "rest"
      const explicit = p.RestApiId ?? p.ApiId
      const target = (explicit === undefined ? undefined : apiOf(run, explicit)) ?? implicitApi(run, kind, implicit)
      run.wire(target, "out", fn, { origin })
      apiEvent(target, p)
      break
    }
    case "Schedule":
    case "ScheduleV2":
    case "CloudWatchEvent":
    case "EventBridgeRule": {
      const expression = asString(p.Schedule ?? p.ScheduleExpression)
      if (expression === undefined || asBoolean(p.Enabled) === false || p.State === "DISABLED") break
      const rate = scheduleRate(expression)
      if (rate === undefined) {
        run.warn(`${fn.name}: schedule "${expression}" couldn't be read.`)
        break
      }
      const client = run.draft(`schedule:${fn.key}:${name}`, `Schedule: ${fn.name}`, "common.client", { source: "assumed", ref: origin.ref })
      run.set(client, ["rps"], rate.rps, "Schedule")
      run.set(client, ["arrival"], "constant", "Schedule")
      run.set(client, ["invocation"], "async", "Schedule")
      run.wire(client, "out", fn, { origin })
      if (!rate.exact) run.warn(`${client.name}: "${expression}" is approximated as about ${(rate.rps * 3600).toFixed(2)} runs an hour.`)
      break
    }
    default:
      run.warn(`${fn.name} has a ${type ?? "unknown"} trigger (${name}), which the simulator can't model yet, so it isn't connected.`)
  }
}
