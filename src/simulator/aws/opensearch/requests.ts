import { Duration } from "effect"
import type { Fast } from "../../Component.ts"
import * as Distribution from "../../Distribution.ts"
import type { Cancel } from "../../Flow.ts"
import { type CallFailure, type Message, Rejected, Throttled, Unavailable } from "../../Message.ts"
import { bodyBytes, records } from "../../kit/Shape.ts"
import type { Tally } from "../../kit/Tally.ts"
import type { Sampler } from "../../Telemetry.ts"
import type { Cluster, Shard } from "./cluster.ts"
import { type Config, heapBytes, INDEXING_PRESSURE_SHARE, INSTANCE_TYPES, payloadBytes, REPLICA_PRESSURE_FACTOR } from "./config.ts"
import { type DataNode, Task } from "./node.ts"
import type { Refresh } from "./refresh.ts"

/**
 * What a request does inside the domain: a write (index or bulk) split into one request per shard, each run on the
 * primary's write pool and then on every replica's; a search fanned out to one copy of every shard on the search pools.
 * Both are callbacks all the way down, one object per request and one per shard, answered once through `answer`.
 */

export type Counter =
  | "writeRequests"
  | "searchRequests"
  | "indexed"
  | "replicated"
  | "searchShards"
  | "partialSearches"
  | "writeRejected"
  | "searchRejected"
  | "pressureRejected"
  | "replicaRejected"
  | "unavailableDocs"
  | "unavailableShards"
  | "lostTasks"

export interface Context {
  readonly id: string
  readonly fast: Fast<Config>
  readonly cluster: Cluster
  readonly refresh: Refresh
  readonly tallies: Record<Counter, Tally>
  /** From a document's creation to it being searchable, in ms. */
  readonly searchable: Sampler
}

/** Answer a call once: `undefined` for success. */
export type Answer = (failure?: CallFailure) => void

const REJECTED = "429 rejected_execution_exception"

/** A request the domain is working on, as its coordinating node sees it. */
abstract class Request {
  answered = false
  constructor(readonly ctx: Context, readonly coordinator: DataNode, private readonly reply: Answer) {}

  answer(failure?: CallFailure): void {
    if (this.answered) return
    this.answered = true
    this.reply(failure)
  }

  /** The coordinating node failed: the caller's connection is gone, though the shards' work carries on. */
  readonly lost = (): void => this.answer(Unavailable({ node: this.ctx.id, reason: "503 coordinating node left the cluster: connection closed" }))

  /** The caller gave up: nobody is waiting for the answer, though the cluster finishes what it started. */
  readonly abandon: Cancel = () => {
    this.answered = true
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------------------------------

class Bulk extends Request {
  parts = 0
  rejected = 0
  pressure = 0
  unavailable = 0
  constructor(ctx: Context, coordinator: DataNode, reply: Answer, readonly docs: number, readonly bytes: number, readonly bornAt: number) {
    super(ctx, coordinator, reply)
  }
}

/** The documents of a write that go to one shard: a shard-level bulk request. */
class WritePart {
  /** Where its bytes are held against the indexing pressure limit, while they are. */
  heldOn: DataNode | undefined = undefined
  replicasLeft = 0
  constructor(readonly bulk: Bulk, readonly shard: number, readonly docs: number, readonly bytes: number) {}
}

const pressureLimit = (c: Config): number => heapBytes(INSTANCE_TYPES[c.instanceType]) * INDEXING_PRESSURE_SHARE

/** Index `count` documents (a bulk request when more than one). Returns how to abandon it. */
export const write = (ctx: Context, message: Message, reply: Answer): Cancel | CallFailure => {
  const { fast, cluster, tallies } = ctx
  const c = fast.settings()
  cluster.reconcile(c)
  tallies.writeRequests.add(1)
  const docs = records(message)
  const bytes = bodyBytes(message)
  const type = INSTANCE_TYPES[c.instanceType]
  if (bytes > payloadBytes(type)) return Rejected({ node: ctx.id, reason: `413 Request Entity Too Large: ${c.instanceType} accepts at most ${type.payloadMiB} MiB` })
  const coordinator = cluster.coordinator(fast.random)
  if (coordinator === undefined) {
    tallies.unavailableDocs.add(docs)
    return Unavailable({ node: ctx.id, reason: "503 no data node available" })
  }
  // Coordinating indexing pressure: the whole request's bytes are held on the node that received it.
  if (coordinator.indexingBytes + bytes > pressureLimit(c)) {
    tallies.pressureRejected.add(docs)
    return Throttled({ node: ctx.id, reason: `${REJECTED}: rejected execution of coordinating operation (indexing pressure: 10% of the heap in flight)` })
  }
  coordinator.indexingBytes += bytes
  const bulk = new Bulk(ctx, coordinator, reply, docs, bytes, message.bornAt)
  coordinator.coordinating.add(bulk)

  const shards = cluster.shards.length
  // Routed by key, documents go to the key's shard; in a bulk, those whose keys are their own (`Message.spread`) don't.
  const keyed = c.routing !== "key" ? 0 : docs > 1 ? Math.round(docs * (1 - Math.min(1, Math.max(0, message.spread ?? 1)))) : docs
  const spread = docs - keyed
  // Documents spread (routed by ID, or by keys of their own) go evenly over the shards; which get the odd ones out is random.
  const base = Math.floor(spread / shards)
  const extra = spread % shards
  const parts = base > 0 ? shards : extra
  const start = parts > 0 ? Math.floor(fast.random.nextDoubleUnsafe() * shards) : 0
  bulk.parts = parts + (keyed > 0 ? 1 : 0)
  if (keyed > 0) dispatch(new WritePart(bulk, cluster.shardOf(message.key).id, keyed, (bytes * keyed) / docs))
  for (let j = 0; j < parts; j++) {
    const n = base + (j < extra ? 1 : 0)
    dispatch(new WritePart(bulk, (start + j) % shards, n, (bytes * n) / docs))
  }
  return bulk.abandon
}

/** Send a shard's documents to its primary, or wait for the shard to have one. */
const dispatch = (part: WritePart): void => {
  const ctx = part.bulk.ctx
  const { fast, cluster, tallies } = ctx
  const c = fast.settings()
  const shard = cluster.shard(part.shard)
  if (shard.primary < 0) {
    // OpenSearch's replication action waits for a new cluster state with an active primary, up to the request's timeout.
    cluster.waitForPrimary(shard, Duration.toMillis(c.indexing.timeout), () => dispatch(part), () => {
      tallies.unavailableDocs.add(part.docs)
      settle(part, "unavailable")
    })
    return
  }
  const node = cluster.nodes[shard.primary]!
  // Primary indexing pressure, unless the primary is on the coordinating node, which already holds these bytes.
  if (node !== part.bulk.coordinator) {
    if (node.indexingBytes + part.bytes > pressureLimit(c)) {
      tallies.pressureRejected.add(part.docs)
      return settle(part, "pressure")
    }
    node.indexingBytes += part.bytes
    part.heldOn = node
  }
  const demand = c.indexing.cpuPerRequest + part.docs * c.indexing.cpuPerDocument
  const task = new Task("write", demand, () => indexed(part, shard, node, demand), () => {
    // The primary's node failed under it: the coordinating node retries once the shard has a primary again.
    tallies.lostTasks.add(1)
    release(part)
    dispatch(part)
  })
  if (!node.submit(task)) {
    release(part)
    tallies.writeRejected.add(part.docs)
    settle(part, "rejected")
  }
}

const release = (part: WritePart): void => {
  if (part.heldOn === undefined) return
  part.heldOn.indexingBytes -= part.bytes
  part.heldOn = undefined
}

/**
 * The primary has indexed the documents: every live replica indexes them too, forced into its write queue. Only the
 * replica indexing pressure limit (1.5 times the primary one) can refuse a replica; the write still succeeds on the
 * primary, and the refused copy is counted (OpenSearch would also fail that copy and rebuild it, which isn't modelled).
 */
const indexed = (part: WritePart, shard: Shard, primary: DataNode, demand: number): void => {
  const ctx = part.bulk.ctx
  const { cluster, refresh, tallies } = ctx
  release(part)
  tallies.indexed.add(part.docs)
  const visibleAt = refresh.indexed(part.docs, part.bulk.bornAt)
  if (visibleAt !== Infinity) ctx.searchable.add(visibleAt - part.bulk.bornAt)
  const limit = pressureLimit(ctx.fast.settings()) * REPLICA_PRESSURE_FACTOR
  for (const copy of shard.copies) {
    const node = cluster.nodes[copy]!
    if (node === primary || !node.up) continue
    if (node.replicaBytes + part.bytes > limit) {
      tallies.replicaRejected.add(part.docs)
      continue
    }
    node.replicaBytes += part.bytes
    part.replicasLeft++
    const replica = new Task("write", demand, () => {
      node.replicaBytes -= part.bytes
      tallies.replicated.add(part.docs)
      replicaDone(part)
    }, () => {
      // A replica lost with its node is dropped from the write, which still succeeds on the primary.
      node.replicaBytes -= part.bytes
      tallies.lostTasks.add(1)
      replicaDone(part)
    })
    node.submit(replica, true)
  }
  if (part.replicasLeft === 0) settle(part, "ok")
}

const replicaDone = (part: WritePart): void => {
  if (--part.replicasLeft === 0) settle(part, "ok")
}

/** One shard's part of a write is over; the last one answers the request. */
const settle = (part: WritePart, outcome: "ok" | "rejected" | "pressure" | "unavailable"): void => {
  const bulk = part.bulk
  if (outcome === "rejected") bulk.rejected += part.docs
  else if (outcome === "pressure") bulk.pressure += part.docs
  else if (outcome === "unavailable") bulk.unavailable += part.docs
  if (--bulk.parts > 0) return
  bulk.coordinator.indexingBytes -= bulk.bytes
  bulk.coordinator.coordinating.delete(bulk)
  const id = bulk.ctx.id
  const refused = bulk.rejected + bulk.pressure
  // A bulk response is 200 with an error per failed item; a client that retries on any 429 resends the whole request.
  if (refused > 0) {
    const why = bulk.pressure > 0 ? "rejected execution of primary operation (indexing pressure)" : "write thread pool queue full"
    return bulk.answer(Throttled({ node: id, reason: `${REJECTED}: ${refused} of ${bulk.docs} documents refused, ${why}` }))
  }
  if (bulk.unavailable > 0) return bulk.answer(Unavailable({ node: id, reason: `503 UnavailableShardsException: primary shard is not active, ${bulk.unavailable} of ${bulk.docs} documents not indexed` }))
  const c = bulk.ctx.fast.settings()
  if (c.indexing.waitForRefresh) bulk.ctx.refresh.wait(() => bulk.answer())
  else bulk.answer()
}

// ---------------------------------------------------------------------------------------------------------------------
// Searches
// ---------------------------------------------------------------------------------------------------------------------

class Search extends Request {
  parts = 0
  shards = 0
  rejected = 0
  unavailable = 0
}

/** One shard's part of a search: tried on one copy, and on the next if that copy can't take it. */
class SearchPart {
  readonly tried: Array<number> = []
  wasRejected = false
  constructor(readonly search: Search, readonly shard: number) {}
}

/** Search one copy of every shard (or the one shard a routing key names). Returns how to abandon it. */
export const search = (ctx: Context, message: Message, reply: Answer): Cancel | CallFailure => {
  const { fast, cluster, tallies } = ctx
  const c = fast.settings()
  cluster.reconcile(c)
  tallies.searchRequests.add(1)
  const coordinator = cluster.coordinator(fast.random)
  if (coordinator === undefined) return Unavailable({ node: ctx.id, reason: "503 no data node available" })
  const s = new Search(ctx, coordinator, reply)
  coordinator.coordinating.add(s)
  if (c.routing === "key") {
    s.parts = s.shards = 1
    query(new SearchPart(s, cluster.shardOf(message.key).id))
  } else {
    const shards = cluster.shards.length
    s.parts = s.shards = shards
    for (let i = 0; i < shards; i++) query(new SearchPart(s, i))
  }
  return s.abandon
}

/**
 * Send a shard's query to the least busy live copy not tried yet. OpenSearch's adaptive replica selection (on by
 * default) prefers the copy answering fastest; the copy whose node has the fewest searches running and queued stands
 * in for it. A copy that rejects it, or fails under it, passes it to the next, as OpenSearch's shard failover does.
 */
const query = (part: SearchPart): void => {
  const ctx = part.search.ctx
  const { fast, cluster, tallies } = ctx
  const shard = cluster.shard(part.shard)
  const copies = shard.copies
  const start = copies.length > 1 ? Math.floor(fast.random.nextDoubleUnsafe() * copies.length) : 0
  let best: DataNode | undefined
  let load = Infinity
  for (let k = 0; k < copies.length; k++) {
    const n = copies[(start + k) % copies.length]!
    const node = cluster.nodes[n]!
    if (!node.up || part.tried.includes(n)) continue
    const busy = node.search.running + node.search.queued
    if (busy < load) {
      best = node
      load = busy
    }
  }
  if (best === undefined) return answered(part, part.wasRejected ? "rejected" : "unavailable")
  part.tried.push(best.index)
  const c = fast.settings()
  const task = new Task("search", Distribution.latencyMs(c.search.cpuPerShard, fast.random), () => {
    tallies.searchShards.add(1)
    answered(part, "ok")
  }, () => {
    tallies.lostTasks.add(1)
    query(part)
  })
  if (!best.submit(task)) {
    tallies.searchRejected.add(1)
    part.wasRejected = true
    query(part)
  }
}

/** One shard has answered or given up; the last one answers the search. */
const answered = (part: SearchPart, outcome: "ok" | "rejected" | "unavailable"): void => {
  const s = part.search
  const { tallies } = s.ctx
  if (outcome === "rejected") s.rejected++
  else if (outcome === "unavailable") {
    s.unavailable++
    tallies.unavailableShards.add(1)
  }
  if (--s.parts > 0) return
  s.coordinator.coordinating.delete(s)
  const failed = s.rejected + s.unavailable
  if (failed === 0) return s.answer()
  const id = s.ctx.id
  const c = s.ctx.fast.settings()
  if (failed === s.shards || !c.search.allowPartialResults) {
    // With every shard failed the status is the shards' own: 429 if they were rejected, 503 if no copy was left.
    return s.answer(
      s.rejected > 0
        ? Throttled({ node: id, reason: `${REJECTED}: search rejected on ${s.rejected} of ${s.shards} shards (search queue full)` })
        : Unavailable({ node: id, reason: `503 search_phase_execution_exception: no copy of ${s.unavailable} of ${s.shards} shards available` })
    )
  }
  // A 200 with `_shards.failed` above zero: the search succeeded on what it could reach.
  tallies.partialSearches.add(1)
  s.answer()
}
