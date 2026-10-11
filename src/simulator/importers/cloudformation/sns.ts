import { asBoolean, asNumber, asString, Reference } from "../Intrinsics.ts"
import { asObject, integrationTargets, redrivePolicy } from "./common.ts"
import { type Bag, type Draft, type Handler, nameOf, type Resource, type Run, SOURCE } from "./model.ts"

/** `AWS::SNS::Topic` and its subscriptions, from the standalone resource, the topic's inline list, and the SAM `SNS` event. */

export const topic: Handler = (run, r) => {
  const d = run.draft(r.id, nameOf(r), "aws.sns", { source: SOURCE, ref: r.id, type: r.type })
  const p = r.props
  const fifo = asBoolean(p.FifoTopic) === true
  if (fifo) run.set(d, ["kind"], "fifo", "FifoTopic")
  if (fifo && p.FifoThroughputScope === "MessageGroup") run.set(d, ["fifoThroughput"], "messageGroup", "FifoThroughputScope")
  if (fifo && asBoolean(p.ContentBasedDeduplication) === true) run.set(d, ["deduplication"], true, "ContentBasedDeduplication")
  // The template counts bytes, the setting kilobytes. Rounded up so a message AWS accepts is never refused here.
  const bytes = asNumber(p.MaximumMessageSize)
  if (bytes !== undefined) run.set(d, ["maxMessageSize"], Math.ceil(bytes / 1024), "MaximumMessageSize")
}

/** What AWS does to an HTTP/S delivery that fails when nobody set a delivery policy: 3 retries, 20 s apart. */
const HTTP_DEFAULT_RETRY = { maxAttempts: 4, backoff: 20, maxBackoff: 20 }

/**
 * Everything a subscription says that becomes a setting of its edge, and the wiring that goes with it (the topic's
 * dead-letter port). `props` is the subscription's own properties: the standalone resource, an inline entry, or a SAM event.
 */
const subscriptionEdge = (run: Run, from: Draft, to: Draft, protocol: string | undefined, props: Bag, origin: { source: string; ref: string }): void => {
  const settings: Record<string, unknown> = {}
  // AWS's own default is the JSON envelope (raw delivery off), and a function always gets the envelope. The component
  // defaults to raw so hand-built designs keep their message sizes, but an import should say what the template means.
  settings.rawMessageDelivery = asBoolean(props.RawMessageDelivery) ?? false

  if (props.FilterPolicy !== undefined) {
    run.warn(`${from.name} → ${to.name}: the FilterPolicy isn't simulated (messages carry no attributes to match), so every message is delivered. Set filterMatch on the subscription to the share you expect to pass.`)
  }

  const http = protocol === "http" || protocol === "https"
  const delivery = asObject(props.DeliveryPolicy)
  if (props.DeliveryPolicy !== undefined && delivery === undefined) run.warn(`${from.name} → ${to.name}: the DeliveryPolicy couldn't be read, so SNS's default delivery policy applies.`)
  if (delivery !== undefined && !http) run.warn(`${from.name} → ${to.name}: a DeliveryPolicy only applies to HTTP/S endpoints, so it is ignored.`)
  if (http) {
    const retry = delivery?.healthyRetryPolicy as Bag | undefined
    const min = asNumber(retry?.minDelayTarget)
    const max = asNumber(retry?.maxDelayTarget)
    const retries = asNumber(retry?.numRetries)
    const attempts = retries !== undefined ? retries + 1 : HTTP_DEFAULT_RETRY.maxAttempts
    const backoff = min ?? HTTP_DEFAULT_RETRY.backoff
    const cap = max ?? (min !== undefined ? Math.max(min, HTTP_DEFAULT_RETRY.maxBackoff) : HTTP_DEFAULT_RETRY.maxBackoff)
    const fn = asString(retry?.backoffFunction)
    settings.retry = {
      maxAttempts: attempts,
      backoff: `${backoff} seconds`,
      maxBackoff: `${cap} seconds`,
      // With no room to grow between the first delay and the last, the delay is constant whatever the function is called.
      ...(backoff === cap ? { backoffFactor: 1 } : {})
    }
    if (fn !== undefined && fn !== "exponential" && fn !== "geometric" && backoff !== cap) {
      run.warn(`${from.name} → ${to.name}: backoffFunction "${fn}" isn't simulated; delays grow geometrically between the first and the last.`)
    }
    const rate = asNumber((delivery?.throttlePolicy as Bag | undefined)?.maxReceivesPerSecond)
    if (rate !== undefined) settings.maxReceivesPerSecond = rate
  }

  // A subscription's redrive policy sends failed deliveries to a queue; the topic has one dead-letter port for all of them.
  if (props.RedrivePolicy !== undefined) {
    const { dlq } = redrivePolicy(run, props.RedrivePolicy)
    const taken = run.wires.find((w) => w.from === from && w.port === "dlq")
    if (dlq === undefined) run.warn(`${from.name} → ${to.name}: its RedrivePolicy names a dead-letter queue that isn't in this template, so failed deliveries are dropped.`)
    else if (taken !== undefined && taken.to !== dlq) {
      run.warn(`${from.name} has one dead-letter port, used by ${taken.to.name}; the subscription to ${to.name} wants ${dlq.name}, so its failed deliveries are dropped.`)
    } else {
      run.wire(from, "dlq", dlq, { name: "Dead letter", origin: { source: SOURCE, ref: "RedrivePolicy" } })
      settings.deadLetterQueue = true
    }
  }

  const edge = run.wire(from, "out", to, { origin })
  if (edge !== undefined) Object.assign(edge.settings, settings)
}

/** An SNS subscription: to a queue or function, or to an HTTP endpoint. */
export const subscribe = (run: Run, topicRef: unknown, p: Bag, r: Resource): void => {
  const from = run.targets(topicRef)[0]
  if (from?.type !== "aws.sns") return
  const protocol = asString(p.Protocol)
  if (protocol === "email" || protocol === "email-json" || protocol === "sms" || protocol === "application" || protocol === "firehose") {
    run.skip(r, `a ${protocol} subscription has no component`)
    return
  }
  const to = protocol === "http" || protocol === "https" ? [integrationTargets(run, p.Endpoint, r.id)[0]].filter((d): d is Draft => d !== undefined) : run.targets(p.Endpoint)
  for (const target of to) subscriptionEdge(run, from, target, protocol, p, { source: SOURCE, ref: r.id })
  if (r.type === "AWS::SNS::Subscription" && to[0] !== undefined) run.consumed(r, to[0])
}

/** The subscriptions written inside a topic, which carry only an endpoint and a protocol. */
export const inlineSubscriptions = (run: Run, r: Resource): void => {
  if (Array.isArray(r.props.Subscription)) for (const s of r.props.Subscription) subscribe(run, new Reference(r.id), s, r)
}

/** The SAM `SNS` event: a function subscribed to a topic. */
export const snsEvent = (run: Run, fn: Draft, p: Bag, origin: { source: string; ref: string }): void => {
  const from = run.targets(p.Topic)[0]
  if (from?.type === "aws.sns") subscriptionEdge(run, from, fn, "lambda", p, origin)
}
