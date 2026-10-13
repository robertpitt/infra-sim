import { asBoolean, asString } from "../../Intrinsics.ts"
import { type Bag, type Draft, type Handler, listOf, nameOf, type Resource, type Run, SOURCE, type Wire } from "./model.ts"

/**
 * `AWS::S3::Bucket` and `AWS::S3Express::DirectoryBucket`: versioning, event notifications (to functions, queues and
 * topics) and replication. Lifecycle rules, encryption, public access blocks, CORS, tags and bucket policies don't change
 * how a bucket behaves under load, so they are left out without comment.
 */

export const bucket: Handler = (run, r) => {
  const d = run.draft(r.id, nameOf(r), "aws.s3", { source: SOURCE, ref: r.id, type: r.type })
  if (r.type === "AWS::S3Express::DirectoryBucket") run.set(d, ["bucketType"], "directory", "AWS::S3Express::DirectoryBucket")
  if (r.props.VersioningConfiguration?.Status === "Enabled") run.set(d, ["versioning"], true, "VersioningConfiguration")
}

// ---------------------------------------------------------------------------------------------------------
// What fraction of objects a key filter lets through
// ---------------------------------------------------------------------------------------------------------

/**
 * A prefix or suffix rule keeps some share of a bucket's objects, but which share depends on what is in the bucket, which a
 * template doesn't say. These are assumptions: a rule on one end of the key keeps half, a rule on both ends a quarter.
 */
const KEY_RULE_SHARE = 0.5
const KEY_RULES_BOTH_SHARE = 0.25

/** The key rules of a notification or replication filter (`S3Key.Rules` in CloudFormation, `Key.FilterRules` in CDK's custom resource). */
const keyRules = (filter: Bag | undefined): ReadonlyArray<{ name: string; value: string }> =>
  [...listOf(filter?.S3Key?.Rules), ...listOf(filter?.Key?.FilterRules)].map((rule) => ({ name: String(rule.Name ?? "").toLowerCase(), value: String(rule.Value ?? "") }))

const keyShare = (rules: ReadonlyArray<{ name: string }>): number => (rules.length === 0 ? 1 : new Set(rules.map((x) => x.name)).size > 1 ? KEY_RULES_BOTH_SHARE : KEY_RULE_SHARE)

const describeRules = (rules: ReadonlyArray<{ name: string; value: string }>): string => rules.map((x) => `${x.name} "${x.value}"`).join(" and ")

// ---------------------------------------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------------------------------------

/** What each notification to one destination covers, so several entries to the same function become one edge. */
interface Coverage {
  created: Array<number>
  removed: Array<number>
}
const coverage = new WeakMap<Wire, Coverage>()

/**
 * Event types the component distinguishes. Anything else (restores, replication, tagging, lifecycle) is not simulated, and
 * is reported rather than turned into an edge that would deliver far more than the template asked for.
 */
const kindOf = (event: string): "created" | "removed" | undefined => (event.startsWith("s3:ObjectCreated") ? "created" : event.startsWith("s3:ObjectRemoved") ? "removed" : undefined)

/** Add (or widen) the `events` edge from a bucket to what is notified. */
export const addNotification = (
  run: Run,
  from: Draft,
  to: Draft,
  events: ReadonlyArray<unknown>,
  filter: Bag | undefined,
  origin: { readonly source: string; readonly ref: string }
): void => {
  const names = events.filter((e): e is string => typeof e === "string")
  const kinds = new Set(names.map(kindOf).filter((k): k is "created" | "removed" => k !== undefined))
  const lost = names.filter((e) => kindOf(e) === undefined)
  if (lost.length > 0) {
    run.warn(`${from.name} → ${to.name}: ${lost.join(", ")} ${lost.length === 1 ? "isn't an event" : "aren't events"} the simulator produces (only object creation and removal), so ${kinds.size === 0 ? "the notification isn't connected" : "they are left out of the notification"}.`)
  }
  if (kinds.size === 0) return
  const edge = run.wire(from, "events", to, { origin })
  if (edge === undefined) return
  const covered = coverage.get(edge) ?? { created: [], removed: [] }
  coverage.set(edge, covered)
  const rules = keyRules(filter)
  const share = keyShare(rules)
  for (const kind of kinds) covered[kind].push(share)
  if (rules.length > 0) {
    run.unresolved.push(`${from.name} → ${to.name}: key filter on ${describeRules(rules)} (not computable from a template: assumed to let ${Math.round(share * 100)}% of objects through; set the edge's filter)`)
  }

  const created = covered.created.length > 0
  const removed = covered.removed.length > 0
  edge.settings.eventTypes = created && removed ? "all" : created ? "created" : "removed"
  // One filter for the edge: the widest of what each event type is given (entries for one type add up, as they are alternatives).
  const widest = Math.max(created ? Math.min(1, covered.created.reduce((a, b) => a + b, 0)) : 0, removed ? Math.min(1, covered.removed.reduce((a, b) => a + b, 0)) : 0)
  if (widest < 1) edge.settings.filter = widest
  else delete edge.settings.filter
}

/** The notifications of a bucket, as CloudFormation writes them or as CDK's custom resource does. */
interface Notification {
  readonly target: unknown
  readonly events: ReadonlyArray<unknown>
  readonly filter: Bag | undefined
}

const notificationsOf = (n: Bag): ReadonlyArray<Notification> => [
  ...listOf(n.LambdaConfigurations).map((c) => ({ target: c.Function, events: listOf(c.Event), filter: c.Filter })),
  ...listOf(n.LambdaFunctionConfigurations).map((c) => ({ target: c.LambdaFunctionArn, events: [...listOf(c.Event), ...listOf(c.Events)], filter: c.Filter })),
  ...listOf(n.QueueConfigurations).map((c) => ({ target: c.Queue ?? c.QueueArn, events: [...listOf(c.Event), ...listOf(c.Events)], filter: c.Filter })),
  ...listOf(n.TopicConfigurations).map((c) => ({ target: c.Topic ?? c.TopicArn, events: [...listOf(c.Event), ...listOf(c.Events)], filter: c.Filter }))
]

const draw = (run: Run, from: Draft, configuration: Bag | undefined): void => {
  if (configuration === undefined) return
  for (const n of notificationsOf(configuration)) {
    const targets = run.targets(n.target)
    if (targets.length === 0) run.warn(`${from.name}: a notification goes to a destination that isn't in this template, so it isn't connected.`)
    for (const to of targets) addNotification(run, from, to, n.events, n.filter, { source: SOURCE, ref: "NotificationConfiguration" })
  }
  if (asBoolean(configuration.EventBridgeConfiguration?.EventBridgeEnabled) === true) {
    run.warn(`${from.name} sends its events to EventBridge, which has no component, so what listens there isn't connected.`)
  }
}

/** S3 event notifications from the bucket's own configuration. */
export const notifications = (run: Run, r: Resource): void => {
  const from = run.drafts.get(r.id)
  if (from !== undefined) draw(run, from, r.props.NotificationConfiguration)
}

/** CDK writes bucket notifications as a custom resource next to the bucket. */
export const customNotifications = (run: Run, r: Resource): void => {
  const from = run.target(r.props.BucketName, "aws.s3")
  if (from === undefined) return
  draw(run, from, r.props.NotificationConfiguration)
  run.consumed(r, from)
}

// ---------------------------------------------------------------------------------------------------------
// Replication
// ---------------------------------------------------------------------------------------------------------

/** A replication rule's destination: a bucket in the template, named by reference or by its literal name. */
const destinationBucket = (run: Run, destination: unknown): Draft | undefined => {
  const found = run.target(destination, "aws.s3")
  if (found !== undefined) return found
  const arn = asString(destination)
  const name = arn === undefined ? undefined : /^arn:[^:]*:s3:::([^/]+)/.exec(arn)?.[1]
  return name === undefined ? undefined : run.byName(["AWS::S3::Bucket"], "BucketName", name)
}

/** `ReplicationConfiguration.Rules`: an edge on the `replication` port per destination, and Replication Time Control. */
export const replication = (run: Run, r: Resource): void => {
  const from = run.drafts.get(r.id)
  if (from === undefined) return
  const rules = listOf(r.props.ReplicationConfiguration?.Rules)
  const byDestination = new Map<Draft, Array<number>>()
  for (const rule of rules) {
    if (rule.Status === "Disabled") continue
    const to = destinationBucket(run, rule.Destination?.Bucket)
    if (to === undefined) {
      run.warn(`${from.name} replicates to a bucket that isn't in this template (${asString(rule.Destination?.Bucket) ?? "a bucket elsewhere"}), so that replication isn't connected.`)
      continue
    }
    if (rule.Destination?.ReplicationTime?.Status === "Enabled") run.set(from, ["replicationTimeControl"], true, "ReplicationConfiguration.Rules.Destination.ReplicationTime")
    // A rule can be limited to a prefix or tags (the older form puts the prefix on the rule itself); what share of objects that is, is assumed.
    const filter = rule.Filter as Bag | undefined
    const limited = (filter !== undefined && Object.keys(filter).length > 0) || (rule.Prefix !== undefined && rule.Prefix !== "")
    const shares = byDestination.get(to) ?? []
    shares.push(limited ? KEY_RULE_SHARE : 1)
    byDestination.set(to, shares)
    if (limited) run.unresolved.push(`${from.name} → ${to.name}: replication filter (not computable from a template: assumed to cover ${Math.round(KEY_RULE_SHARE * 100)}% of objects; set the edge's filter)`)
  }
  for (const [to, shares] of byDestination) {
    const share = Math.min(1, shares.reduce((a, b) => a + b, 0))
    run.wire(from, "replication", to, { name: "Replication", settings: share < 1 ? { filter: share } : {}, origin: { source: SOURCE, ref: "ReplicationConfiguration" } })
  }
}
