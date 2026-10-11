import { asNumber, asString, referencesIn } from "../Intrinsics.ts"
import { entryPoint, num, secs, wireDestination } from "./common.ts"
import { type Bag, type Draft, type Handler, nameOf, type Resource, type Run, SOURCE, type TemplateContext } from "./model.ts"
import { attachToVpc } from "./vpc.ts"

/** `AWS::Lambda::Function` and `AWS::Serverless::Function`, and the resources that adjust a function (versions, aliases, URLs, async config). */

export const lambda: Handler = (run, r, ctx) => {
  const sam = r.type === "AWS::Serverless::Function"
  const d = run.draft(r.id, nameOf(r), "aws.lambda", { source: SOURCE, ref: r.id, type: r.type })
  const p = r.props
  run.set(d, ["memory"], num(p.MemorySize), "MemorySize")
  run.set(d, ["timeout"], secs(p.Timeout), "Timeout")
  const reserved = asNumber(p.ReservedConcurrentExecutions)
  if (reserved !== undefined) {
    run.set(d, ["reserved", "enabled"], true, "ReservedConcurrentExecutions")
    run.set(d, ["reserved", "concurrency"], reserved, "ReservedConcurrentExecutions")
  } else run.set(d, ["reserved", "concurrency"], num(p.ReservedConcurrentExecutions), "ReservedConcurrentExecutions")
  const provisioned = asNumber(p.ProvisionedConcurrencyConfig?.ProvisionedConcurrentExecutions)
  if (provisioned !== undefined) run.set(d, ["provisioned"], provisioned, "ProvisionedConcurrencyConfig")
  // SnapStart restores a snapshot of a published version instead of running Init; it only takes effect on a version.
  if (p.SnapStart?.ApplyOn === "PublishedVersions") run.set(d, ["coldStart", "snapStart"], true, "SnapStart")
  // Asynchronous invocation settings, which SAM allows inline.
  invokeConfig(run, d, p.EventInvokeConfig)
  // Where a function that gave up on an event sends it. Resolved once every component exists, as a destination may come later.
  const dlq = p.DeadLetterConfig?.TargetArn ?? p.DeadLetterQueue?.TargetArn
  if (dlq !== undefined) run.later(() => wireDestination(run, d, "onFailure", dlq, { label: "its dead-letter queue", ref: "DeadLetterConfig", name: "Dead letter", allow: ["aws.sqs", "aws.sns"] }))
  if (p.VpcConfig?.SubnetIds !== undefined) run.later(() => attachToVpc(run, d, p.VpcConfig))
  if (sam) for (const [name, event] of Object.entries((p.Events ?? {}) as Bag)) ctx.events.push({ fn: d, name, event: (event ?? {}) as Bag })
  if (p.FunctionUrlConfig !== undefined) entryPoint(run, d, `Function URL for ${d.name}`)
}

/**
 * `EventInvokeConfig` on a function or as its own resource: retries, maximum age, and where events go once they have
 * succeeded or been given up on. SAM writes a destination as `{Type, Destination}`; when `Destination` is left out SAM
 * creates the queue or topic itself, which this template then doesn't contain.
 */
export const invokeConfig = (run: Run, d: Draft, c: Bag | undefined): void => {
  if (c === undefined) return
  run.set(d, ["async", "maxRetries"], num(c.MaximumRetryAttempts), "MaximumRetryAttempts")
  const age = asNumber(c.MaximumEventAgeInSeconds)
  run.set(d, ["async", "maxEventAge"], age !== undefined ? `${age} seconds` : undefined, "MaximumEventAgeInSeconds")
  const destinations = [["onFailure", "OnFailure", "On failure"], ["onSuccess", "OnSuccess", "On success"]] as const
  for (const [port, key, name] of destinations) {
    const config = c.DestinationConfig?.[key] as Bag | undefined
    if (config === undefined) continue
    if (config.Destination === undefined) {
      run.warn(`${d.name}: ${key} is a ${asString(config.Type) ?? "destination"} that SAM creates for you, so it isn't in this template and isn't connected.`)
      continue
    }
    // EventBridge destinations are not components; wireDestination says so when it finds nothing to connect.
    run.later(() => wireDestination(run, d, port, config.Destination, { label: `its ${name.toLowerCase()} destination`, ref: "DestinationConfig", name }))
  }
}

/**
 * Versions and aliases stand for the function they point at, so something that triggers an alias triggers the function.
 * Read before any wiring, because anything in the template may name an alias.
 */
export const aliases = (run: Run, ctx: TemplateContext): void => {
  for (const r of ctx.resources.values()) {
    if (r.type !== "AWS::Lambda::Alias" && r.type !== "AWS::Lambda::Version" && r.type !== "AWS::Lambda::Url") continue
    run.guard(r.id, () => {
      const fn = run.targets(r.type === "AWS::Lambda::Url" ? r.props.TargetFunctionArn : r.props.FunctionName).find((d) => d.type === "aws.lambda")
      if (fn === undefined) return
      run.alias(r.id, fn.key)
      // Provisioned concurrency belongs to a version or alias, and is what the function is held to.
      const pc = asNumber(r.props.ProvisionedConcurrencyConfig?.ProvisionedConcurrentExecutions)
      if (pc !== undefined) run.set(fn, ["provisioned"], pc, "ProvisionedConcurrencyConfig")
      if (r.type !== "AWS::Lambda::Url") run.consumed(r, fn)
    }, r)
  }
}

const url = (run: Run, r: Resource, ctx: TemplateContext): void => {
  const fn = run.targets(r.props.TargetFunctionArn).find((d) => d.type === "aws.lambda")
  if (fn === undefined) return
  // A distribution in front of the URL is what the world calls; the URL isn't a second way in.
  const fronted = [...ctx.resources.values()].some((o) => o.type === "AWS::CloudFront::Distribution" && referencesIn(o.props).includes(r.id))
  if (!fronted) entryPoint(run, fn, `Function URL for ${fn.name}`)
  run.consumed(r, fn)
}

const invokeConfigResource = (run: Run, r: Resource): void => {
  const fn = run.targets(r.props.FunctionName)[0]
  if (fn === undefined) return
  invokeConfig(run, fn, r.props)
  run.consumed(r, fn)
}

export const lambdaWiring: Record<string, Handler> = {
  "AWS::Lambda::EventInvokeConfig": invokeConfigResource,
  "AWS::Lambda::Url": url
}
