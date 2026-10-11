import { asBoolean, asNumber, asString } from "../Intrinsics.ts"
import { num, wireDestination } from "./common.ts"
import { type Bag, type Draft, type Handler, listOf, nameOf, type Run, SOURCE, seconds } from "./model.ts"
import { unsimulatedMappingFeatures } from "./sqs.ts"

/**
 * `AWS::DynamoDB::Table`, `AWS::DynamoDB::GlobalTable` and SAM's `SimpleTable`: capacity, on-demand limits, indexes,
 * the stream (and the functions that read it), and a global table's replicas.
 */

/** `StreamViewType` as the component spells it. */
const STREAM_VIEW: Record<string, string> = { KEYS_ONLY: "keys", NEW_IMAGE: "new", OLD_IMAGE: "old", NEW_AND_OLD_IMAGES: "new-and-old" }

/**
 * An index entry that holds only the keys: about what a stream's key record weighs (the component's own assumption), as
 * the template can't say how big an item is. `ALL` leaves the component's 0, "the whole item".
 */
const KEYS_ONLY_ENTRY_BYTES = 128

/** `-1` is how a template says "no maximum"; the component says it with 0. */
const limit = (v: unknown): unknown => {
  const n = asNumber(v)
  return n === undefined ? num(v) : n < 0 ? 0 : n
}

/** The capacity a global table's autoscaling settings can reach: the simulator has no autoscaling, so its ceiling stands in. */
const autoscaled = (s: Bag | undefined, fixed: string, scaling: string): number | undefined => asNumber(s?.[fixed]) ?? asNumber(s?.[scaling]?.MaxCapacity)

export const table: Handler = (run, r) => {
  const global = r.type === "AWS::DynamoDB::GlobalTable"
  const home = run.draft(r.id, nameOf(r), "aws.dynamodb", { source: SOURCE, ref: r.id, type: r.type })
  const replicas = global ? listOf(r.props.Replicas) : []
  const regions = [...new Set(replicas.map((x) => asString(x.Region)).filter((x): x is string => x !== undefined))]
  const unknown = regions.filter((x) => !run.options.knownRegions.includes(x))
  for (const region of unknown) run.warn(`${home.name}: a replica in ${region}, which isn't an AWS region the simulator knows, is left out.`)
  const wanted = regions.filter((x) => !unknown.includes(x))

  const simple = r.type === "AWS::Serverless::SimpleTable"
  if (!global || wanted.length === 0) {
    applyTable(run, home, r.props, { name: home.name, global, simple })
    return
  }
  // The stack's own region hosts the table that functions in the template talk to; the others are its replicas. If the
  // template doesn't list its own region (it must in AWS) the first replica takes that place.
  const here = wanted.includes(run.options.region) ? run.options.region : wanted[0]!
  if (here !== run.options.region) {
    home.region = here
    run.warn(`${home.name}: the stack's region (${run.options.region}) isn't one of the table's replicas, so ${here} stands in as the table's home.`)
  }
  applyTable(run, home, r.props, { name: home.name, global, simple, replica: replicas.find((x) => x.Region === here) })
  const nodes: Array<Draft> = [home]
  for (const region of wanted.filter((x) => x !== here)) {
    const copy = run.draft(`${r.id}@${region}`, `${home.name} (${region})`, "aws.dynamodb", { source: SOURCE, ref: r.id, type: r.type })
    copy.region = region
    run.replicaCopies.add(copy)
    applyTable(run, copy, r.props, { name: home.name, global, simple, replica: replicas.find((x) => x.Region === region) })
    nodes.push(copy)
  }
  // Every replica writes to every other, so a write anywhere reaches the rest (the component has no echo to guard against).
  for (const from of nodes) for (const to of nodes) if (from !== to) run.wire(from, "replicas", to, { name: "Replication", origin: { source: SOURCE, ref: `${r.id}.Replicas` } })
}

/** The settings of one table (a global table's replica is one table per region). `replica` carries what the template says per region. */
const applyTable = (run: Run, d: Draft, p: Bag, kind: { readonly name: string; readonly global: boolean; readonly simple: boolean; readonly replica?: Bag | undefined }): void => {
  const { global, simple, replica, name } = kind
  // A table's own throughput; a global table says it per direction, the write side for all and the read side per replica.
  const provisioned = (p.ProvisionedThroughput ?? {}) as Bag
  const onDemand = p.BillingMode === "PAY_PER_REQUEST"
  if (onDemand) run.set(d, ["mode"], "on-demand", "BillingMode")
  else if (global) {
    const write = autoscaled(p.WriteProvisionedThroughputSettings, "WriteCapacityUnits", "WriteCapacityAutoScalingSettings")
    const read = autoscaled(replica?.ReadProvisionedThroughputSettings, "ReadCapacityUnits", "ReadCapacityAutoScalingSettings")
    if (read !== undefined || write !== undefined) run.set(d, ["mode"], "provisioned", "BillingMode")
    run.set(d, ["readCapacity"], read, "ReadProvisionedThroughputSettings")
    run.set(d, ["writeCapacity"], write, "WriteProvisionedThroughputSettings")
    if (p.WriteProvisionedThroughputSettings?.WriteCapacityAutoScalingSettings !== undefined) {
      run.warn(`${name}: autoscaling isn't simulated, so the table gets the most its autoscaling settings allow.`)
    }
  } else {
    const read = asNumber(provisioned.ReadCapacityUnits) ?? (simple ? 5 : undefined)
    const write = asNumber(provisioned.WriteCapacityUnits) ?? (simple ? 5 : undefined)
    if (read !== undefined || write !== undefined) run.set(d, ["mode"], "provisioned", "BillingMode")
    run.set(d, ["readCapacity"], read ?? num(provisioned.ReadCapacityUnits), "ReadCapacityUnits")
    run.set(d, ["writeCapacity"], write ?? num(provisioned.WriteCapacityUnits), "WriteCapacityUnits")
  }

  // On-demand maximum throughput and pre-warmed throughput.
  const maximum = (p.OnDemandThroughput ?? {}) as Bag
  run.set(d, ["onDemand", "maxReadUnits"], limit(maximum.MaxReadRequestUnits ?? replica?.ReadOnDemandThroughputSettings?.MaxReadRequestUnits), "OnDemandThroughput.MaxReadRequestUnits")
  run.set(d, ["onDemand", "maxWriteUnits"], limit(maximum.MaxWriteRequestUnits ?? p.WriteOnDemandThroughputSettings?.MaxWriteRequestUnits), "OnDemandThroughput.MaxWriteRequestUnits")
  const warm = (replica?.WarmThroughput ?? p.WarmThroughput ?? {}) as Bag
  run.set(d, ["onDemand", "warmReadUnits"], num(warm.ReadUnitsPerSecond), "WarmThroughput.ReadUnitsPerSecond")
  run.set(d, ["onDemand", "warmWriteUnits"], num(warm.WriteUnitsPerSecond), "WarmThroughput.WriteUnitsPerSecond")

  indexes(run, d, name, p, replica, onDemand)

  // The stream. What reads it is wired with the event source mappings.
  const view = STREAM_VIEW[asString(p.StreamSpecification?.StreamViewType) ?? ""]
  if (view !== undefined) run.set(d, ["stream", "view"], view, "StreamSpecification.StreamViewType")
  if (view !== undefined && !global) {
    run.later(() => {
      if (!run.wires.some((w) => w.from === d && w.port === "stream")) run.warn(`${d.name} has a stream that nothing in this template reads (a consumer in another stack, say), so no stream records are produced.`)
    })
  }

  // Time to live deletes items after they expire; how many that is each second depends on the data, which a template doesn't hold.
  if (asBoolean(p.TimeToLiveSpecification?.Enabled) === true) {
    run.warn(`${name}: TTL is on (${asString(p.TimeToLiveSpecification.AttributeName) ?? "an attribute"}), but a template can't say how many items expire each second, so ttl.expiresPerSecond stays 0. Set it to model the deletes.`)
  }
}

/**
 * The component models every global secondary index alike, as large as the biggest: the capacity of the widest index
 * stands in for all of them, and the report says when they differed.
 */
const indexes = (run: Run, d: Draft, name: string, p: Bag, replica: Bag | undefined, onDemand: boolean): void => {
  const gsis = listOf(p.GlobalSecondaryIndexes)
  if (gsis.length > 0) {
    run.set(d, ["gsi", "count"], gsis.length, "GlobalSecondaryIndexes")
    const reads = gsis.map((g) => provisionedOf(g, replica, "read"))
    const writes = gsis.map((g) => provisionedOf(g, replica, "write"))
    const maxReads = gsis.map((g) => limitOf(g, "MaxReadRequestUnits"))
    const maxWrites = gsis.map((g) => limitOf(g, "MaxWriteRequestUnits"))
    const largest = (xs: ReadonlyArray<number | undefined>): number | undefined => (xs.some((x) => x !== undefined) ? Math.max(...xs.map((x) => x ?? 0)) : undefined)
    if (!onDemand) {
      run.set(d, ["gsi", "readCapacity"], largest(reads), "GlobalSecondaryIndexes.ProvisionedThroughput.ReadCapacityUnits")
      run.set(d, ["gsi", "writeCapacity"], largest(writes), "GlobalSecondaryIndexes.ProvisionedThroughput.WriteCapacityUnits")
    }
    run.set(d, ["gsi", "maxReadUnits"], largest(maxReads), "GlobalSecondaryIndexes.OnDemandThroughput.MaxReadRequestUnits")
    run.set(d, ["gsi", "maxWriteUnits"], largest(maxWrites), "GlobalSecondaryIndexes.OnDemandThroughput.MaxWriteRequestUnits")

    const projections = new Set(gsis.map((g) => asString(g.Projection?.ProjectionType) ?? "ALL"))
    // Indexes of keys only write small entries; any index that copies the item (ALL), or some of its attributes (INCLUDE, whose size
    // the template doesn't give), makes the whole item the right size to charge for.
    if (projections.size === 1 && projections.has("KEYS_ONLY")) run.set(d, ["gsi", "entryBytes"], KEYS_ONLY_ENTRY_BYTES, "GlobalSecondaryIndexes.Projection")
    if (projections.has("INCLUDE")) run.warn(`${name}: an index with ProjectionType INCLUDE copies attributes the template doesn't size, so its entries are charged as whole items.`)

    const alike = new Set(gsis.map((_, i) => `${reads[i]}/${writes[i]}/${maxReads[i]}/${maxWrites[i]}`)).size === 1 && projections.size === 1
    if (!alike && gsis.length > 1) run.warn(`${name}: its ${gsis.length} global secondary indexes differ in capacity or projection, but the component models them alike; they take the biggest index's capacity.`)
  }
  const lsis = listOf(p.LocalSecondaryIndexes)
  if (lsis.length > 0) run.set(d, ["lsi", "count"], lsis.length, "LocalSecondaryIndexes")
}

/** An index's provisioned units: on a table it is in its own throughput; on a global table, writes are the table's and reads the replica's. */
const provisionedOf = (g: Bag, replica: Bag | undefined, direction: "read" | "write"): number | undefined => {
  if (direction === "read") {
    const own = asNumber(g.ProvisionedThroughput?.ReadCapacityUnits)
    if (own !== undefined) return own
    const per = listOf(replica?.GlobalSecondaryIndexes).find((x) => x.IndexName === g.IndexName)
    return autoscaled(per?.ReadProvisionedThroughputSettings, "ReadCapacityUnits", "ReadCapacityAutoScalingSettings")
  }
  return asNumber(g.ProvisionedThroughput?.WriteCapacityUnits) ?? autoscaled(g.WriteProvisionedThroughputSettings, "WriteCapacityUnits", "WriteCapacityAutoScalingSettings")
}

const limitOf = (g: Bag, key: "MaxReadRequestUnits" | "MaxWriteRequestUnits"): number | undefined => {
  const n = asNumber(g.OnDemandThroughput?.[key] ?? g[key === "MaxReadRequestUnits" ? "ReadOnDemandThroughputSettings" : "WriteOnDemandThroughputSettings"]?.[key])
  return n === undefined ? undefined : Math.max(0, n)
}

/**
 * A function reading a table's stream: batch size, batching window, parallelization, record age, retries and bisecting,
 * plus where discarded batches go. Shared by `AWS::Lambda::EventSourceMapping` and the SAM `DynamoDB` event.
 */
export const streamConsumer = (run: Run, source: Draft, fn: Draft, p: Bag, origin: { readonly source: string; readonly ref: string }): void => {
  const settings: Record<string, unknown> = {}
  const batch = asNumber(p.BatchSize)
  if (batch !== undefined) settings.batchSize = batch
  const window = asNumber(p.MaximumBatchingWindowInSeconds)
  if (window !== undefined) settings.batchWindow = seconds(window)
  const parallelization = asNumber(p.ParallelizationFactor)
  if (parallelization !== undefined) settings.parallelization = parallelization
  const age = asNumber(p.MaximumRecordAgeInSeconds)
  if (age !== undefined) settings.maxRecordAge = age
  const retries = asNumber(p.MaximumRetryAttempts)
  if (retries !== undefined) settings.maxRetries = retries
  const bisect = asBoolean(p.BisectBatchOnFunctionError)
  if (bisect !== undefined) settings.bisectOnError = bisect
  run.wire(source, "stream", fn, { settings, origin, name: "Stream" })
  unsimulatedMappingFeatures(run, fn, p)
  // A batch given up on sends a small record of it (not the data) to the destination, which can only be a queue or a topic.
  const destination = p.DestinationConfig?.OnFailure?.Destination
  if (destination !== undefined) {
    run.later(() => wireDestination(run, source, "discarded", destination, { label: `the on-failure destination of ${fn.name}'s stream mapping`, ref: origin.ref, name: "Discarded batches", allow: ["aws.sqs", "aws.sns"] }))
  }
}
