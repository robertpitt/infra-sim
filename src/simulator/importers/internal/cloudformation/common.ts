import { asNumber, asString, isUnresolved } from "../../Intrinsics.ts"
import { type Bag, type Draft, known, type Run, type Wire } from "./model.ts"

/** Pieces several services need: a destination that may not be in the template, and the traffic source in front of an entry point. */

/** How a template refers to something it can't name here, for a warning: the ARN if it is plain text. */
export const describeRef = (value: unknown): string => {
  const text = asString(value)
  if (text !== undefined && !text.includes("${")) return text
  return isUnresolved(value) ? `something not known until deploy (${value.reason})` : "a resource outside this template"
}

/**
 * Wire a single-destination port (`onFailure`, `onSuccess`, a dead-letter queue) to what the template names. A
 * destination the template doesn't contain (an ARN, another stack's export) can't be drawn; that is reported.
 */
export const wireDestination = (
  run: Run,
  from: Draft,
  port: string,
  destination: unknown,
  options: { readonly label: string; readonly ref: string; readonly name?: string; readonly allow?: ReadonlyArray<string>; readonly settings?: Record<string, unknown> }
): Wire | undefined => {
  if (destination === undefined) return undefined
  const to = run.targets(destination).find((d) => options.allow === undefined || options.allow.includes(d.type))
  if (to === undefined) {
    const found = run.targets(destination)[0]
    run.warn(
      found === undefined
        ? `${from.name}: ${options.label} goes to ${describeRef(destination)}, which isn't in this template, so it isn't connected.`
        : `${from.name}: ${options.label} goes to ${found.name}, which can't receive it here (${options.allow?.join(" or ")} only), so it isn't connected.`
    )
    return undefined
  }
  return run.wire(from, port, to, {
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    origin: { source: "cloudformation", ref: options.ref }
  })
}

/** Something called from outside, which the template doesn't say anything about: a source of traffic. */
export const entryPoint = (run: Run, target: Draft, name: string, settings: Record<string, unknown> = {}): void => {
  const client = run.draft(`client:${name}`, name, "common.client", { source: "assumed", ref: name })
  run.set(client, ["rps"], run.options.rps, "traffic")
  run.wire(client, "out", target, { declared: false, settings })
  run.added.push(`A traffic source "${name}" at ${run.options.rps} requests/s (assumed: a template has no traffic).`)
}

/** A policy or configuration that CloudFormation lets be an object or a JSON string; a string with `${Tokens}` in it can't be parsed. */
export const asObject = (value: unknown): Bag | undefined => {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Bag
  const text = asString(value)
  if (text === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Bag) : undefined
  } catch {
    return undefined
  }
}

/** A redrive policy: the dead-letter queue and the receive count. SQS and SNS write it the same way. */
export const redrivePolicy = (run: Run, policy: unknown): { readonly dlq: Draft | undefined; readonly maxReceive: unknown } => {
  if (typeof policy === "string" && policy.includes("${")) {
    // A JSON string with `${Queue.Arn}` tokens left in it.
    const token = /\$\{([A-Za-z0-9]+)/.exec(policy)?.[1]
    return { dlq: token === undefined ? undefined : run.nodeFor(token), maxReceive: /"maxReceiveCount"\s*:\s*"?(\d+)/.exec(policy)?.[1] }
  }
  const object = asObject(policy)
  if (object === undefined) return { dlq: undefined, maxReceive: undefined }
  return { dlq: run.targets(object.deadLetterTargetArn)[0], maxReceive: object.maxReceiveCount }
}

/** A number the template states (kept as the unresolved marker when it isn't known), for `Run.set`. */
export const num = (value: unknown): unknown => known(asNumber(value), value)

/** A duration written as a number of seconds in a template, as the text a design uses. */
export const secs = (value: unknown): unknown => {
  const n = asNumber(value)
  return known(n === undefined ? undefined : `${n} seconds`, value)
}

/** Where an API Gateway integration (or an HTTP subscription, or a CloudFront origin) sends requests: the components it names, or an external URL. */
export const integrationTargets = (run: Run, uri: unknown, why: string): ReadonlyArray<Draft> => {
  const found = run.targets(uri)
  if (found.length > 0) return found
  const url = asString(uri)
  return url !== undefined && /^https?:\/\//i.test(url) ? [run.endpoint(url, why)] : []
}
