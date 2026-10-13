import { asBoolean, asNumber, asString } from "../../Intrinsics.ts"
import { type Bag, type Draft, type Handler, listOf, nameOf, type Resource, type Run, SOURCE } from "./model.ts"

/**
 * `AWS::SES::ConfigurationSet` is the SES component, and its event destinations are edges out of its `events` port.
 * What sends through it (a function allowed to `ses:SendEmail`) is inferred with the other permissions, in `infer.ts`.
 * Identities, templates, contact lists, dedicated IP pools and receipt rules have no behaviour in the simulator and
 * are reported as skipped (see `skips.ts`).
 */

/** What a configuration set can suppress, as the component names the choice. */
const reasonsOf = (reasons: ReadonlyArray<unknown>): "both" | "bounces" | "complaints" | undefined => {
  const bounces = reasons.includes("BOUNCE")
  const complaints = reasons.includes("COMPLAINT")
  return bounces && complaints ? "both" : bounces ? "bounces" : complaints ? "complaints" : undefined
}

export const configurationSet: Handler = (run, r) => {
  const d = run.draft(r.id, nameOf(r), "aws.ses", { source: SOURCE, ref: r.id, type: r.type })
  const p = r.props
  // A configuration set may name its own suppression reasons; an empty list switches suppression off for it.
  if (p.SuppressionOptions?.SuppressedReasons !== undefined) {
    const reasons = listOf(p.SuppressionOptions.SuppressedReasons)
    const chosen = reasonsOf(reasons)
    run.set(d, ["suppression", "enabled"], chosen !== undefined, "SuppressionOptions.SuppressedReasons")
    run.set(d, ["suppression", "reasons"], chosen, "SuppressionOptions.SuppressedReasons")
  }
  // How long SES keeps retrying a message; the component's range is AWS's (5 minutes to 14 hours), and is enforced when the design is assembled.
  const delivery = asNumber(p.DeliveryOptions?.MaxDeliverySeconds)
  if (delivery !== undefined) run.set(d, ["timing", "retryWindow"], `${delivery} seconds`, "DeliveryOptions.MaxDeliverySeconds")
  if (asBoolean(p.SendingOptions?.SendingEnabled) === false) {
    run.warn(`${d.name}: sending is disabled on this configuration set (SendingEnabled: false), which the simulator doesn't model, so it sends.`)
  }
}

/** The event types a destination can match, as the component names them. `RENDERING_FAILURE` and `SUBSCRIPTION` have no equivalent. */
const EVENT_TYPES: Record<string, string> = {
  SEND: "send",
  DELIVERY: "delivery",
  BOUNCE: "bounce",
  COMPLAINT: "complaint",
  REJECT: "reject",
  DELIVERY_DELAY: "deliveryDelay",
  OPEN: "open",
  CLICK: "click"
}

/** The configuration set (a node) a destination belongs to: named by reference, or by the set's literal name. */
const configurationSetOf = (run: Run, ref: unknown): Draft | undefined =>
  run.targets(ref).find((d) => d.type === "aws.ses") ?? (asString(ref) === undefined ? undefined : run.byName(["AWS::SES::ConfigurationSet"], "Name", asString(ref)!))

/** `AWS::SES::ConfigurationSetEventDestination`: an edge from the SES node to an SNS topic, carrying the events it matches. */
export const eventDestination = (run: Run, r: Resource): void => {
  const p = r.props
  const ses = configurationSetOf(run, p.ConfigurationSetName)
  const destination = (p.EventDestination ?? {}) as Bag
  if (ses === undefined) {
    run.skip(r, "its configuration set isn't in this template")
    return
  }
  if (asBoolean(destination.Enabled) === false) {
    run.skip(r, "the destination is disabled, so no events go to it", true)
    return
  }

  const matching = listOf(destination.MatchingEventTypes).map(String)
  const unsupported = matching.filter((t) => !(t in EVENT_TYPES))
  if (unsupported.length > 0) {
    run.warn(`${ses.name}: the event ${unsupported.length === 1 ? "type" : "types"} ${unsupported.join(", ")} ${unsupported.length === 1 ? "has" : "have"} no equivalent in the simulator, so they are dropped from what ${asString(destination.Name) ?? r.id} receives.`)
  }

  if (destination.SnsDestination === undefined) {
    // Firehose, EventBridge and CloudWatch are not components, so there is nothing to send the events to.
    const kind = destination.KinesisFirehoseDestination !== undefined ? "Kinesis Firehose" : destination.EventBridgeDestination !== undefined ? "EventBridge" : destination.CloudWatchDestination !== undefined ? "CloudWatch" : "this kind of"
    run.skip(r, `${kind} destinations have no simulator component, so those events go nowhere`)
    return
  }
  const topic = run.targets(destination.SnsDestination.TopicARN).find((d) => d.type === "aws.sns")
  if (topic === undefined) {
    run.skip(r, "its SNS topic isn't in this template")
    return
  }
  // Every event type the component has is written, so the edge carries exactly the types the destination matches (open and click are off unless asked for).
  const events: Record<string, boolean> = {}
  for (const [cfn, name] of Object.entries(EVENT_TYPES)) events[name] = matching.includes(cfn)
  run.wire(ses, "events", topic, { settings: { events }, name: asString(destination.Name) ?? "Events", origin: { source: SOURCE, ref: r.id } })
  run.consumed(r, ses)
}

// ---------------------------------------------------------------------------------------------------------
// Who sends
// ---------------------------------------------------------------------------------------------------------

/**
 * What the sending permissions in a policy say: that it can send, and whether it only does so with the bulk API. A bare `*`
 * is not read as "sends email": an administrator policy says nothing about which service a function uses.
 */
export const sendsMail = (actions: ReadonlyArray<string>): { readonly sends: boolean; readonly bulk: boolean } => {
  const named = actions.map((a) => a.toLowerCase())
  const plain = named.some((a) => ["ses:*", "ses:send*", "ses:sendemail", "ses:sendrawemail", "ses:sendtemplatedemail"].includes(a))
  const bulk = named.some((a) => a === "ses:sendbulkemail" || a === "ses:sendbulktemplatedemail")
  return { sends: plain || bulk, bulk: bulk && !plain }
}

/** The SAM policy templates that let a function send mail. `SESCrudPolicy` includes the plain send actions. */
export const SAM_SENDING_POLICIES: Record<string, { readonly bulk: boolean }> = {
  SESCrudPolicy: { bulk: false },
  SESBulkTemplatedCrudPolicy: { bulk: true },
  SESBulkTemplatedCrudPolicy_v2: { bulk: true }
}

/**
 * The SES node mail goes through. A template that sends but has no configuration set uses the account's default
 * sending, so one is added; with several there is no way to tell which a function means, and nothing is guessed.
 */
export const sesNode = (run: Run, who: Draft): Draft | undefined => {
  const nodes = [...run.drafts.values()].filter((d) => d.type === "aws.ses")
  if (nodes.length === 1) return nodes[0]
  if (nodes.length > 1) {
    run.warn(`${who.name} may send email, but the template has ${nodes.length} configuration sets and doesn't say which it uses, so it isn't connected to any. Connect it to the one it sends through.`)
    return undefined
  }
  const d = run.draft("implicit:ses", "Amazon SES", "aws.ses", { source: "inferred", ref: "ses:SendEmail" })
  run.added.push("An Amazon SES node, because a function in the template is allowed to send email and no configuration set names where: it sends with the account's own limits.")
  return d
}
