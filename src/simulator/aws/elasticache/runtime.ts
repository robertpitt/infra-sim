import { Effect } from "effect"
import * as Distribution from "../../Distribution.ts"
import type { Link } from "../../Edge.ts"
import * as Flow from "../../Flow.ts"
import { type Call, type CallFailure, Failed, type Message, Rejected, Throttled, Unavailable } from "../../Message.ts"
import type { TimerHandle } from "../../VirtualTime.ts"
import type * as Aws from "../provider.ts"
import { Cluster, type Utilization, ZoneMap } from "./cluster.ts"
import type { Config, ports, State } from "./config.ts"
import { derive, type Derived } from "./derived.ts"
import { ecpuOf, ServerlessCapacity } from "./serverless.ts"
import { keyOf, shardOfSlot, slotOf, Tally } from "./store.ts"

/** The recent-rate gauges look back over this many one-second slots. */
const WINDOW = 10
const SECOND = 1000
const IDLE: Utilization = { hottest: 0, hottestShard: 0, mean: 0, hottestEngine: 0, meanEngine: 0, hottestNetwork: 0 }

export type ElastiCacheNode = Aws.Node<typeof Config, typeof ports>

/** A request whose answer waits on the database (a miss, or a write): its end of the call. */
class Waiter {
  open = true
  timer: TimerHandle | undefined
  failure: CallFailure | undefined
  constructor(readonly resume: (effect: Effect.Effect<void, CallFailure>) => void) {}
}

const deliver = (waiter: Waiter): void => {
  waiter.timer = undefined
  if (!waiter.open) return
  waiter.open = false
  waiter.resume(waiter.failure === undefined ? Effect.void : Effect.fail(waiter.failure))
}

const close = (waiter: Waiter): Effect.Effect<void> =>
  Effect.sync(() => {
    waiter.open = false
    waiter.timer?.cancel()
  })

/** How a cache command went: `undefined` for done, or why not (the shard cannot take it, the node refuses it, memory is full). */
type CacheFailure = CallFailure | undefined

/**
 * The cluster at run time. A read is one lookup on the node it goes to and is answered there on a hit; a miss reads
 * the database through `misses` and fills the key on the shard's primary. A write goes to the database (`writes`) and then
 * invalidates or rewrites the key. See `README.md` for what each mechanism models.
 */
export const makeRuntime = (node: ElastiCacheNode) => {
  const { fast } = node
  // Usually the same database at the end of both. Each edge's own default operation keeps reads reads and writes writes.
  const missesTo: Link | undefined = node.out("misses")[0]
  const writesTo: Link | undefined = node.out("writes")[0]
  const random = (): number => fast.random.nextDoubleUnsafe()

  // Counters (per second, in frames) and plain totals (for probes and the recent-rate gauges: counters reset every frame).
  const reads = node.meter.counter("reads")
  const writes = node.meter.counter("writes")
  const cacheHits = node.meter.counter("cacheHits")
  const cacheMisses = node.meter.counter("cacheMisses")
  const collapsed = node.meter.counter("collapsed")
  const databaseReads = node.meter.counter("databaseReads")
  const databaseWrites = node.meter.counter("databaseWrites")
  const bypassed = node.meter.counter("bypassed")
  const fillFailures = node.meter.counter("fillFailures")
  const cacheErrors = node.meter.counter("cacheErrors")
  const refused = node.meter.counter("refused")
  const throttled = node.meter.counter("throttled")
  const failovers = node.meter.counter("failovers")
  const flushes = node.meter.counter("flushes")
  const ecpu = node.meter.counter("ecpu")
  const tally = new Tally({ evictions: node.meter.counter("evictions"), expired: node.meter.counter("expired"), oom: node.meter.counter("oom") })
  // As CloudWatch counts them: SET-type commands (fills, write-throughs, invalidations), the values written to the cache
  // and read from it (NetworkBytesIn and NetworkBytesOut of client traffic; the replication stream is ReplicationBytes),
  // and the latency of the cache commands that succeeded, the database's time apart.
  const setTypeCmds = node.meter.counter("setTypeCmds")
  const networkBytesIn = node.meter.counter("networkBytesIn")
  const networkBytesOut = node.meter.counter("networkBytesOut")
  const readLatency = node.meter.sampler("readLatency")
  const writeLatency = node.meter.sampler("writeLatency")
  const replication = { bytes: node.meter.counter("replicationBytes"), lag: node.meter.sampler("replicationLag") }
  const total = { reads: 0, writes: 0, hits: 0, misses: 0, collapsed: 0, databaseReads: 0, databaseWrites: 0, bypassed: 0, refused: 0, throttled: 0, failovers: 0 }

  // ---------------------------------------------------------------------------------------------------------------
  // Settings, quotas and the shape of the cluster, worked out when they change
  // ---------------------------------------------------------------------------------------------------------------

  const initial = fast.settings()
  let settingsFrom: Config | undefined
  let accountFrom: Aws.Account | undefined
  let d: Derived = derive(initial, fast.account() as Aws.Account)
  // The nodes are spread over the region's zones from the node's own zone (or the region's first).
  const home = node.placement.zone === undefined ? 0 : Math.max(0, node.zones.all.indexOf(node.placement.zone))
  const zones = new ZoneMap(node.zones.all, home)
  let cluster = new Cluster<Waiter>(d.shards, d.group, tally, zones, replication)
  const serverless = new ServerlessCapacity(`${node.id}/elasticache`, d)
  let failSeen = initial.actions.failPrimary
  let flushSeen = initial.actions.flush

  const current = (): Derived => {
    const c = fast.settings()
    const account = fast.account() as Aws.Account
    if (c === settingsFrom && account === accountFrom) return d
    settingsFrom = c
    accountFrom = account
    d = derive(c, account)
    if (cluster.shards !== d.shards || cluster.group !== d.group) cluster = cluster.reshape(d.shards, d.group, d)
    serverless.configure(d)
    // The "break it" controls: a changed number is a press of the button.
    if (c.actions.failPrimary !== failSeen) {
      failSeen = c.actions.failPrimary
      failPrimary(Math.min(c.actions.failShard, d.shards - 1))
    }
    if (c.actions.flush !== flushSeen) {
      flushSeen = c.actions.flush
      flushes.n++
      for (const store of cluster.stores) store.clear()
    }
    return d
  }

  const failPrimary = (shard: number): void => {
    // Serverless replaces failed nodes behind its proxy without the application noticing (a 99.99% SLA): nothing to do.
    if (d.serverless) return
    if (cluster.fail(shard, fast.now(), d).started) {
      failovers.n++
      total.failovers++
    }
  }

  /**
   * Faults changed: a zone that went down takes its nodes with it (the shards whose primary was there fail over), and
   * one that came back has its nodes replaced. The engine leaves zone faults to this component (`handlesZoneFaults`);
   * an Outage on the node itself is still the whole cluster unreachable, refused before it runs.
   */
  const zonesChanged = (): void => {
    const names = zones.names
    for (let z = 0; z < names.length; z++) {
      const down = node.zones.down(names[z]!)
      if (down === (zones.lost[z] === 1)) continue
      zones.lost[z] = down ? 1 : 0
      zones.anyLost = zones.lost.includes(1)
      current()
      // Serverless replicates across zones behind its endpoint, out of sight: nothing to lose.
      if (d.serverless) continue
      if (down) {
        const started = cluster.zoneLost(z, fast.now(), d)
        failovers.n += started
        total.failovers += started
      } else cluster.zoneBack(z, fast.now(), d)
    }
  }
  const unwatch = node.faults.watch(zonesChanged)

  /**
   * The shard that owns a slot now. Work that finishes later (a fill, the update after a write) asks again rather than
   * keeping the shard it started on, since the cluster may have been resharded meanwhile.
   */
  const shardOf = (slot: number): number => (d.serverless ? 0 : shardOfSlot(slot, d.shards))

  /** When a key filled now expires: the TTL, shortened by a random share of up to the jitter. */
  const expiry = (now: number): number => (d.ttlMs === Infinity ? Infinity : now + (d.jitter > 0 ? d.ttlMs * (1 - d.jitter * random()) : d.ttlMs))

  /** The call the application makes to the database: one item, the same key. The edge says whether it reads or writes. */
  const toDatabase = (message: Message, operation: "read" | "write"): Message => ({
    ...message,
    operation,
    bytes: d.itemBytes,
    count: 1,
    invocation: "sync"
  })

  /** Answer a waiting request after `delay`, with `failure` or success. */
  const settle = (waiter: Waiter, failure: CallFailure | undefined, delay: number): void => {
    if (!waiter.open) return
    waiter.failure = failure
    waiter.timer = fast.after(delay, deliver, waiter)
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Cache commands
  // ---------------------------------------------------------------------------------------------------------------

  /** Delay of a command on a node, or the failure it meets: maxclients reached. */
  let commandDelay = 0
  const onNode = (n: number, now: number, bytes: number): CacheFailure => {
    if (cluster.waiting(n, now, d) > d.maxClients) {
      refused.n++
      total.refused++
      return Throttled({ node: node.id, reason: "ERR max number of clients reached" })
    }
    commandDelay = cluster.occupy(n, now, bytes, d)
    return undefined
  }

  /** The same on a serverless cache: ECPUs for the slot and the cache, then the proxy's latency. */
  const onServerless = (slot: number, bytes: number, read: boolean): CacheFailure => {
    const cost = ecpuOf(bytes)
    if (!serverless.admit(node.limiter, slot, cost, read, d)) {
      throttled.n++
      total.throttled++
      return Throttled({ node: node.id, reason: "throttled: ECPU per second limit" })
    }
    ecpu.n += cost
    commandDelay = Distribution.latencyMs(fast.settings().serverless.latency, fast.random)
    return undefined
  }

  /** A SET (a fill or a write-through) or a DEL on the shard's primary, with its replication. */
  const writeKey = (key: number, slot: number, now: number, set: boolean): CacheFailure => {
    const shard = shardOf(slot)
    const store = cluster.stores[shard]!
    if (d.serverless) {
      const failure = onServerless(slot, set ? d.itemBytes : 0, false)
      if (failure !== undefined) return failure
    } else {
      if (!cluster.writable(shard, now)) return Unavailable({ node: node.id, reason: "primary failing over: writes refused" })
      const failure = onNode(cluster.primaryOf(shard, now), now, 0)
      if (failure !== undefined) return failure
      cluster.replicate(shard, now, set ? d.itemBytes : 0, d, now + commandDelay)
    }
    setTypeCmds.n++
    if (!set) {
      store.delete(key)
      writeLatency.add(commandDelay)
      return undefined
    }
    networkBytesIn.n += d.itemBytes
    if (!d.storable) return Rejected({ node: node.id, reason: "SERVER_ERROR object too large for cache" })
    if (!store.set(key, expiry(now), d.capacity, d.policy, now)) {
      return Failed({ node: node.id, reason: "OOM command not allowed when used memory > 'maxmemory'" })
    }
    writeLatency.add(commandDelay)
    return undefined
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------------------------------------------

  /** The cache could not answer a read: read the database instead (fail open), or fail. */
  const cacheDown = (message: Message, failure: CallFailure): Call => {
    cacheErrors.n++
    if (!d.failOpen || missesTo === undefined) return Effect.fail(failure)
    bypassed.n++
    total.bypassed++
    databaseReads.n++
    total.databaseReads++
    return missesTo.invoke(toDatabase(message, "read"))
  }

  /** The database answered a miss: fill the key, then answer everyone who waited on it. */
  const fetched = (key: number, slot: number, waiters: Array<Waiter>, failure: CallFailure | undefined): void => {
    current()
    let delay = 0
    if (failure === undefined) {
      const now = fast.now()
      const fillFailure = writeKey(key, slot, now, true)
      // A failed fill does not fail the read: the application has the value, it just isn't cached.
      if (fillFailure === undefined) delay = commandDelay
      else fillFailures.n++
    }
    for (const waiter of waiters) settle(waiter, failure, delay)
  }

  /** After the GET that missed: read the database, alone or (with the lock) once for everyone missing this key. */
  const fetch = (message: Message, key: number, slot: number, waiter: Waiter): void => {
    waiter.timer = undefined
    if (!waiter.open) return
    current()
    const shard = shardOf(slot)
    const lockedOn = d.lock ? cluster.pending[shard] : undefined
    const waiting = lockedOn?.get(key)
    // With a lock, code checks the cache again once it has the lock: another reader may have filled the key meanwhile.
    if (waiting !== undefined || (lockedOn !== undefined && cluster.stores[shard]!.get(key, fast.now()) !== undefined)) {
      collapsed.n++
      total.collapsed++
      if (waiting !== undefined) waiting.push(waiter)
      else settle(waiter, undefined, 0)
      return
    }
    const waiters = [waiter]
    lockedOn?.set(key, waiters)
    databaseReads.n++
    total.databaseReads++
    missesTo!.send(toDatabase(message, "read"), (failure) => {
      if (lockedOn?.get(key) === waiters) lockedOn.delete(key)
      fetched(key, slot, waiters, failure)
    })
  }

  const read = (message: Message, key: number, slot: number, shard: number, now: number): Call => {
    reads.n++
    total.reads++
    const store = cluster.stores[shard]!
    const fresh = store.get(key, now) !== undefined
    const bytes = fresh ? d.itemBytes : 0
    let failure: CacheFailure
    if (d.serverless) failure = onServerless(slot, bytes, true)
    else {
      const n = cluster.reader(shard, now, d.readFrom, random)
      failure = n < 0 ? Unavailable({ node: node.id, reason: "no node of the shard can serve reads: failing over" }) : onNode(n, now, bytes)
    }
    if (failure !== undefined) return cacheDown(message, failure)
    const delay = commandDelay
    readLatency.add(delay)
    networkBytesOut.n += bytes
    if (fresh) {
      cacheHits.n++
      total.hits++
      return Flow.wait(fast, delay)
    }
    cacheMisses.n++
    total.misses++
    // Nothing on `misses`: the cache is the store, and a miss is an empty answer.
    if (missesTo === undefined) return Flow.wait(fast, delay)
    return Effect.callback<void, CallFailure>((resume) => {
      const waiter = new Waiter(resume)
      waiter.timer = fast.after(delay, () => fetch(message, key, slot, waiter), undefined)
      return close(waiter)
    })
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------------------------------------------

  /** The database took the write: invalidate or rewrite the key, and answer. */
  const written = (key: number, slot: number, waiter: Waiter, failure: CallFailure | undefined): void => {
    if (failure !== undefined) return settle(waiter, failure, 0)
    current()
    const cacheFailure = writeKey(key, slot, fast.now(), d.writeThrough)
    if (cacheFailure === undefined) return settle(waiter, undefined, commandDelay)
    // The database has the write; the cache update failed. Fail open shrugs; otherwise the application sees the error.
    cacheErrors.n++
    settle(waiter, d.failOpen ? undefined : cacheFailure, 0)
  }

  const write = (message: Message, key: number, slot: number, now: number): Call => {
    writes.n++
    total.writes++
    if (writesTo === undefined) {
      // Nothing on `writes`: the cache is where writes are kept, so a write is a SET, and fails if the shard cannot take it.
      const failure = writeKey(key, slot, now, true)
      if (failure !== undefined) return Effect.fail(failure)
      return Flow.wait(fast, commandDelay)
    }
    databaseWrites.n++
    total.databaseWrites++
    return Effect.callback<void, CallFailure>((resume) => {
      const waiter = new Waiter(resume)
      writesTo.send(toDatabase(message, "write"), (failure) => written(key, slot, waiter, failure))
      return close(waiter)
    })
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The request
  // ---------------------------------------------------------------------------------------------------------------

  const call = (message: Message): Call => {
    current()
    const now = fast.now()
    const key = keyOf(message.key, d.keys, d.skew)
    const slot = slotOf(key)
    return message.operation === "write" ? write(message, key, slot, now) : read(message, key, slot, shardOf(slot), now)
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The clock: recent rates, utilisation, active expiry, serverless scaling, and the "break it" controls
  // ---------------------------------------------------------------------------------------------------------------

  const recent = { hits: new Float64Array(WINDOW), misses: new Float64Array(WINDOW) }
  let seen = { hits: 0, misses: 0 }
  let slot = 0
  let utilization: Utilization = IDLE
  const sum = (values: Float64Array): number => {
    let s = 0
    for (let i = 0; i < WINDOW; i++) s += values[i]!
    return s
  }
  const ratio = (num: number, den: number): number => (den > 0 ? num / den : 0)

  const tick = (): void => {
    current()
    const now = fast.now()
    slot = (slot + 1) % WINDOW
    recent.hits[slot] = total.hits - seen.hits
    recent.misses[slot] = total.misses - seen.misses
    seen = { hits: total.hits, misses: total.misses }
    // A serverless cache has no nodes to be busy: its limit is ECPUs.
    utilization = d.serverless ? IDLE : cluster.utilization(SECOND)
    for (const store of cluster.stores) store.sweep(now)
    if (d.serverless) serverless.tick(now, d)
    fast.after(SECOND, tick, undefined)
  }
  fast.after(SECOND, tick, undefined)

  const items = (): number => cluster.items()
  const memoryUsed = (): number => cluster.memoryUsed(d.capacity)
  const blocked = (): number => (d.serverless ? 0 : cluster.writeBlocked(fast.now()))
  const recentHitRate = (): number => ratio(sum(recent.hits), sum(recent.hits) + sum(recent.misses))

  node.meter.gaugeUnsafe("hitRate", recentHitRate)
  node.meter.gaugeUnsafe("items", items)
  node.meter.gaugeUnsafe("memoryUsed", memoryUsed)
  node.meter.gaugeUnsafe("engineUtilization", () => utilization.hottest)
  node.meter.gaugeUnsafe("meanUtilization", () => utilization.mean)
  node.meter.gaugeUnsafe("engineCpu", () => utilization.hottestEngine)
  node.meter.gaugeUnsafe("engineCpuMean", () => utilization.meanEngine)
  node.meter.gaugeUnsafe("networkUtilization", () => utilization.hottestNetwork)
  node.meter.gaugeUnsafe("shardsWriteBlocked", blocked)
  // Only a serverless cache has ECPUs (a cluster can't become serverless in place, so this holds for the whole run).
  if (d.serverless) node.meter.gaugeUnsafe("ecpuCeiling", () => (d.serverless ? serverless.ceiling : 0))
  node.meter.gaugeUnsafe("nodesDown", () => (d.serverless ? 0 : cluster.nodesDown(fast.now())))

  const probe = Effect.sync((): State => {
    current()
    return {
      engine: fast.settings().engine,
      deployment: d.serverless ? "serverless" : "node-based",
      shards: d.shards,
      nodes: d.serverless ? 0 : cluster.nodes,
      nodesDown: d.serverless ? 0 : cluster.nodesDown(fast.now()),
      capacityPerShard: d.capacity === Infinity ? -1 : d.capacity,
      items: items(),
      memoryUsed: memoryUsed(),
      hitRatio: ratio(total.hits, total.hits + total.misses),
      recentHitRatio: recentHitRate(),
      reads: total.reads,
      writes: total.writes,
      hits: total.hits,
      misses: total.misses,
      collapsed: total.collapsed,
      databaseReads: total.databaseReads,
      databaseWrites: total.databaseWrites,
      bypassed: total.bypassed,
      evictions: tally.evictions,
      expired: tally.expired,
      oom: tally.oom,
      refused: total.refused,
      failovers: total.failovers,
      shardsWriteBlocked: blocked(),
      hottestShard: utilization.hottestShard,
      hottestUtilization: utilization.hottest,
      ecpuCeiling: d.serverless ? serverless.ceiling : 0,
      throttled: total.throttled
    }
  })

  /** Stop hearing about faults (the simulation is over). */
  const stop = (): void => unwatch()

  return { call, probe, stop }
}
