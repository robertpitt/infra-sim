import { Duration, Effect, SubscriptionRef } from "effect"
import type * as Aws from "../provider.ts"
import * as Distribution from "../../Distribution.ts"
import * as Flow from "../../Flow.ts"
import type { Bucket } from "../../Limiter.ts"
import { type Call, type CallFailure, type Message, Rejected, Throttled, Unavailable } from "../../Message.ts"
import { keyOf } from "../../Provider.ts"
import type { TimerHandle } from "../../VirtualTime.ts"
import { Entry, Layer, Pending } from "./cache.ts"
import { bodyTooLarge, type Config, type ports } from "./config.ts"
import { CLOUDFRONT_FUNCTION, derive, type Derived, LAMBDA_AT_EDGE } from "./derived.ts"
import { OriginCall, type OriginLink } from "./origin.ts"
import { CONNECT_FAILED, failureFor, isCachedError, isServerError, NO_ORIGIN, OK, type Outcome, statusOf } from "./outcome.ts"

/** Where a response came from, for the hit and miss counts. */
const FROM_ORIGIN = 0
const FROM_REGIONAL = 1
const FROM_SHIELD = 2

/** The recent-rate gauges look back over this many one-second slots. */
const WINDOW = 10
const SECOND = 1000
/** Gbit/s to bytes/s. */
const BYTES_PER_GBPS = 1e9 / 8

type Done = (outcome: Outcome, source: number) => void

/** A viewer waiting on a fetch: its end of the call, and what to charge it when the fetch lands. */
class Viewer {
  open = true
  leader = true
  timer: TimerHandle | undefined
  failure: CallFailure | undefined
  constructor(
    readonly resume: (effect: Effect.Effect<void, CallFailure>) => void,
    /** What the edge adds on top: processing, a farther edge, viewer-side functions. */
    readonly overhead: number,
    /** The bytes a successful response carries to the viewer. */
    readonly bytes: number,
    /** A write is proxied: no cache, so no hit or miss to record. */
    readonly proxied: boolean
  ) {}
}

const deliver = (viewer: Viewer): void => {
  viewer.timer = undefined
  if (!viewer.open) return
  viewer.open = false
  viewer.resume(viewer.failure === undefined ? Effect.void : Effect.fail(viewer.failure))
}

const run = (fn: () => void): void => fn()

type EdgeLayer = Layer<Viewer>
type TierLayer = Layer<Done>

export type CloudFrontNode = Aws.Node<typeof import("./config.ts").Config, typeof ports>

/**
 * The distribution at run time. Every request makes one cache lookup at its edge location and is answered at once on a
 * hit; a miss walks the tiers (regional edge cache, Origin Shield) to the origin, with one fetch per object per tier
 * however many requests wait on it. See `README.md` for what each mechanism models.
 */
export const makeRuntime = (node: CloudFrontNode) => {
  const { fast } = node
  const links = node.out("out") as ReadonlyArray<OriginLink>
  const placementKey = keyOf(node.placement)
  const rpsKey = `${node.id}/cloudfront/requests`
  const bandwidthKey = `${node.id}/cloudfront/bytes`
  const lambdaKey = `${placementKey}/cloudfront/lambda-edge`

  // Counters (per second, in frames) and plain totals (for probes and the recent-rate gauges: counters reset every frame).
  const requests = node.meter.counter("requests")
  const cacheHit = node.meter.counter("cacheHit")
  const cacheMiss = node.meter.counter("cacheMiss")
  const edgeHit = node.meter.counter("edgeHit")
  const regionalHit = node.meter.counter("regionalHit")
  const shieldHit = node.meter.counter("shieldHit")
  const collapsedCount = node.meter.counter("collapsed")
  const originRequests = node.meter.counter("originRequests")
  const originRetries = node.meter.counter("originRetries")
  const originErrors = node.meter.counter("originErrors")
  const failoverCount = node.meter.counter("failover")
  const staleServed = node.meter.counter("staleServed")
  const errorsCached = node.meter.counter("errorsCached")
  const proxied = node.meter.counter("proxied")
  const invalidationCount = node.meter.counter("invalidations")
  const functionErrors = node.meter.counter("functionErrors")
  const rejectedCount = node.meter.counter("rejected")
  const bytesDownloaded = node.meter.counter("bytesDownloaded")
  const bytesUploaded = node.meter.counter("bytesUploaded")
  const err4xx = node.meter.counter("err4xx")
  const err5xx = node.meter.counter("err5xx")
  const err502 = node.meter.counter("err502")
  const err503 = node.meter.counter("err503")
  const err504 = node.meter.counter("err504")
  const originLatency = node.meter.sampler("originLatency")
  const total = { requests: 0, hits: 0, misses: 0, err4xx: 0, err5xx: 0, originRequests: 0, staleServed: 0, collapsed: 0 }

  // One cache per edge location and per regional cache, created the first time traffic reaches it; one shield per origin.
  const edges: Array<EdgeLayer> = []
  const regionals: Array<TierLayer> = []
  const shields = new Map<string, TierLayer>()
  const edgeAt = (i: number): EdgeLayer => edges[i] ?? (edges[i] = new Layer())
  const regionalAt = (i: number): TierLayer => regionals[i] ?? (regionals[i] = new Layer())
  const shieldOf = (link: OriginLink): TierLayer => {
    let layer = shields.get(link.id)
    if (layer === undefined) shields.set(link.id, (layer = new Layer()))
    return layer
  }
  const sizeOf = (layers: ReadonlyArray<{ readonly entries: ReadonlyMap<number, Entry> } | undefined>): number => {
    let n = 0
    for (const layer of layers) if (layer !== undefined) n += layer.entries.size
    return n
  }
  const pendingFetches = (): number => {
    let n = 0
    for (const layer of edges) if (layer !== undefined) n += layer.pending.size
    return n
  }
  const evictions = (): number => {
    let n = 0
    for (const layer of edges) if (layer !== undefined) n += layer.evictions
    for (const layer of regionals) if (layer !== undefined) n += layer.evictions
    for (const layer of shields.values()) n += layer.evictions
    return n
  }

  // Settings-derived values, and the account's buckets, recomputed only when what they come from is replaced.
  let derivedFrom: Config | undefined
  let derived!: Derived
  let purgeSeen = fast.settings().invalidation.purgeVersion
  const refresh = (c: Config): Derived => {
    derivedFrom = c
    derived = derive(c)
    // Fewer locations than before: the caches beyond them are dropped, so memory follows the setting down as well as up.
    if (edges.length > derived.edgeLocations) edges.length = derived.edgeLocations
    if (regionals.length > derived.regionalLocations) regionals.length = derived.regionalLocations
    if (c.invalidation.purgeVersion !== purgeSeen) {
      purgeSeen = c.invalidation.purgeVersion
      purgeLater(c, 1)
    }
    return derived
  }
  let accountFrom: Aws.Account | undefined
  let rpsBucket: Bucket = { rate: 0, burst: 0 }
  let bandwidthBucket: Bucket = { rate: 0, burst: 0 }
  let lambdaBucket: Bucket = { rate: 0, burst: 0 }
  const buckets = (): void => {
    const account = fast.account() as Aws.Account
    if (account === accountFrom) return
    accountFrom = account
    rpsBucket = { rate: account.cloudfrontRequestRate, burst: account.cloudfrontRequestRate }
    const bytesPerSecond = account.cloudfrontDataTransferRate * BYTES_PER_GBPS
    bandwidthBucket = { rate: bytesPerSecond, burst: bytesPerSecond }
    lambdaBucket = { rate: account.cloudfrontLambdaEdgeRate, burst: account.cloudfrontLambdaEdgeRate }
  }

  /** The object a request is for, from its key. Skew above 1 piles requests onto the low numbers. */
  const objectOf = (key: number, d: Derived): number => {
    let u = key >= 0 ? (key < 1 ? key : 0.999999999999) : 0
    if (d.skew !== 1) u = u ** d.skew
    const id = Math.floor(u * d.objects)
    return id < d.objects ? id : d.objects - 1
  }

  const later = (ms: number, fn: () => void): void => {
    if (ms > 0) fast.after(ms, run, fn)
    else fn()
  }

  const countError = (outcome: Outcome): void => {
    const status = statusOf(outcome)
    if (status >= 500) {
      err5xx.n++
      total.err5xx++
      if (status === 502) err502.n++
      else if (status === 503) err503.n++
      else if (status === 504) err504.n++
    } else {
      err4xx.n++
      total.err4xx++
    }
  }
  const countHit = (): void => {
    cacheHit.n++
    total.hits++
  }
  const countMiss = (): void => {
    cacheMiss.n++
    total.misses++
  }

  // -----------------------------------------------------------------------------------------------------------------
  // Edge functions (CloudFront Functions and Lambda@Edge)
  // -----------------------------------------------------------------------------------------------------------------

  let functionFailed = false
  /** How long one function hook takes; sets `functionFailed` when it errors, times out or is throttled (the viewer gets a 503). */
  const hook = (kind: number, c: Config, d: Derived): number => {
    const f = c.functions
    if (kind === CLOUDFRONT_FUNCTION) {
      if (f.errorRate > 0 && fast.random.nextDoubleUnsafe() < f.errorRate) functionFailed = true
      return Distribution.latencyMs(f.cloudFrontFunction, fast.random)
    }
    if (kind !== LAMBDA_AT_EDGE) return 0
    // Lambda@Edge counts against the region's rate; over it the function is throttled.
    buckets()
    if (!node.limiter.takeUnsafe(lambdaKey, lambdaBucket)) {
      functionFailed = true
      return 0
    }
    let ms = Distribution.latencyMs(f.lambdaAtEdge, fast.random)
    if (ms > d.lambdaTimeoutMs) {
      functionFailed = true
      ms = d.lambdaTimeoutMs
    }
    if (f.errorRate > 0 && fast.random.nextDoubleUnsafe() < f.errorRate) functionFailed = true
    return ms
  }

  // -----------------------------------------------------------------------------------------------------------------
  // Origins
  // -----------------------------------------------------------------------------------------------------------------

  /** Choose an origin of the given role for an object, by the edges' weights over the object's place in the key space. */
  const pickOrigin = (position: number, role: "primary" | "secondary"): OriginLink | undefined => {
    let weight = 0
    for (const link of links) {
      const c = SubscriptionRef.getUnsafe(link.config)
      if (c.role === role && c.weight > 0) weight += c.weight
    }
    if (weight <= 0) return undefined
    let r = position * weight
    let last: OriginLink | undefined
    for (const link of links) {
      const c = SubscriptionRef.getUnsafe(link.config)
      if (c.role !== role || !(c.weight > 0)) continue
      last = link
      r -= c.weight
      if (r < 0) return link
    }
    return last
  }

  const failsOver = (outcome: Outcome, d: Derived): boolean => {
    // A failed connection counts as a 503 for failover, and a timeout as a 504 (the origin group page says so).
    const status = outcome === CONNECT_FAILED ? 503 : outcome
    switch (status) {
      case 500:
        return d.fail500
      case 502:
        return d.fail502
      case 503:
        return d.fail503
      case 504:
        return d.fail504
      case 400:
      case 403:
      case 404:
      case 416:
      case 429:
        return d.failClient
      default:
        return false
    }
  }

  /** Make the request to one origin, with the origin-facing functions around it. */
  const callOrigin = (link: OriginLink, position: number, d: Derived, c: Config, write: boolean, message: Message, done: Done): void => {
    const cfg = SubscriptionRef.getUnsafe(link.config)
    originRequests.n++
    total.originRequests++
    functionFailed = false
    const before = d.originRequest === 0 ? 0 : hook(d.originRequest, c, d)
    if (functionFailed) {
      functionErrors.n++
      return later(before, () => done(503, FROM_ORIGIN))
    }
    functionFailed = false
    const after = d.originResponse === 0 ? 0 : hook(d.originResponse, c, d)
    const afterFailed = functionFailed
    // The origin is sent the object's own place in the key space, so what it partitions by (S3 prefixes) is the object.
    const forwarded: Message = { ...message, key: position, bytes: write ? message.bytes : d.rawBytes, count: 1, invocation: "sync" }
    later(before, () => {
      new OriginCall(fast, link, cfg, forwarded, !write, originRetries, (outcome) => {
        if (outcome !== OK) originErrors.n++
        later(after, () => done(afterFailed && outcome === OK ? 503 : outcome, FROM_ORIGIN))
      }).start()
    })
  }

  /** One origin, behind its Origin Shield if it has one. */
  const callThroughShield = (link: OriginLink, id: number, position: number, d: Derived, c: Config, cacheable: boolean, write: boolean, message: Message, done: Done): void => {
    if (!SubscriptionRef.getUnsafe(link.config).shield) return callOrigin(link, position, d, c, write, message, done)
    const layer = shieldOf(link)
    const hop = (): number => Distribution.latencyMs(c.originShield.hop, fast.random)
    if (!cacheable) {
      // Proxied requests always pass through Origin Shield (an incremental layer), but there is nothing to cache.
      const out = hop()
      return later(out, () => callOrigin(link, position, d, c, write, message, (outcome, source) => later(hop(), () => done(outcome, source))))
    }
    const now = fast.now()
    const held = layer.entries.get(id)
    if (held !== undefined && held.expires > now) {
      held.referenced = true
      shieldHit.n++
      return later(hop() + hop(), () => done(OK, FROM_SHIELD))
    }
    const waiting = layer.pending.get(id)
    if (waiting !== undefined) {
      waiting.waiters.push(done)
      return
    }
    const pending = new Pending<Done>(now)
    pending.waiters.push(done)
    layer.pending.set(id, pending)
    later(hop(), () =>
      callOrigin(link, position, d, c, write, message, (outcome, source) => {
        layer.pending.delete(id)
        if (outcome === OK) layer.put(id, new Entry(fast.now() + d.ttlMs, OK, Infinity), d.shieldCapacity)
        finishWaiters(pending.waiters, outcome, source, FROM_SHIELD, hop(), shieldHit)
      }))
  }

  /** Answer everyone waiting on a fetch: the one that started it hears the real source, the rest hear this tier's. */
  const finishWaiters = (waiters: ReadonlyArray<Done>, outcome: Outcome, source: number, tier: number, hopBack: number, hits: { n: number }): void => {
    for (let i = 0; i < waiters.length; i++) {
      const waiter = waiters[i]!
      const heard = i === 0 ? source : tier
      if (i > 0 && outcome === OK) hits.n++
      later(hopBack, () => waiter(outcome, heard))
    }
  }

  /** Get an object (or proxy a write) from the origins: the chosen primary, then the secondary if it fails over. */
  const fromOrigins = (id: number, position: number, d: Derived, c: Config, cacheable: boolean, write: boolean, message: Message, done: Done): void => {
    const primary = pickOrigin(position, "primary") ?? pickOrigin(position, "secondary")
    if (primary === undefined) return done(NO_ORIGIN, FROM_ORIGIN)
    callThroughShield(primary, id, position, d, c, cacheable, write, message, (outcome, source) => {
      // Failover is for reads only, and only to a secondary origin that is not the one that just failed.
      if (outcome !== OK && !write && failsOver(outcome, d)) {
        const secondary = pickOrigin(position, "secondary")
        if (secondary !== undefined && secondary !== primary) {
          failoverCount.n++
          return callThroughShield(secondary, id, position, d, c, cacheable, write, message, done)
        }
      }
      done(outcome, source)
    })
  }

  /** The regional edge cache between an edge location and the origins. */
  const fromRegional = (edge: number, id: number, position: number, d: Derived, c: Config, message: Message, done: Done): void => {
    const layer = regionalAt(edge % d.regionalLocations)
    const hop = (): number => Distribution.latencyMs(c.regionalEdgeCache.hop, fast.random)
    const now = fast.now()
    const held = layer.entries.get(id)
    if (held !== undefined && held.expires > now) {
      held.referenced = true
      regionalHit.n++
      return later(hop() + hop(), () => done(OK, FROM_REGIONAL))
    }
    const waiting = layer.pending.get(id)
    if (waiting !== undefined) {
      waiting.waiters.push(done)
      return
    }
    const pending = new Pending<Done>(now)
    pending.waiters.push(done)
    layer.pending.set(id, pending)
    later(hop(), () =>
      fromOrigins(id, position, d, c, true, false, message, (outcome, source) => {
        layer.pending.delete(id)
        if (outcome === OK) layer.put(id, new Entry(fast.now() + d.ttlMs, OK, Infinity), d.regionalCapacity)
        finishWaiters(pending.waiters, outcome, source, FROM_REGIONAL, hop(), regionalHit)
      }))
  }

  // -----------------------------------------------------------------------------------------------------------------
  // The edge location: lookup, collapsing, and settling viewers
  // -----------------------------------------------------------------------------------------------------------------

  /** Charge a viewer for how its request ended, and send it its answer once the edge has finished its own work. */
  const settle = (viewer: Viewer, outcome: Outcome, source: number, stale: boolean): void => {
    if (!viewer.open) return
    if (outcome === OK) {
      bytesDownloaded.n += viewer.bytes
      if (!viewer.proxied) {
        if (stale) {
          staleServed.n++
          total.staleServed++
          countHit()
        } else if (!viewer.leader) {
          collapsedCount.n++
          total.collapsed++
          countHit()
        } else if (source === FROM_ORIGIN) countMiss()
        else countHit()
      }
    } else {
      countError(outcome)
      viewer.failure = failureFor(node.id, outcome)
    }
    viewer.timer = fast.after(viewer.overhead, deliver, viewer)
  }

  /** A fetch from upstream (regional cache or origins) for an object an edge location does not hold has finished. */
  const edgeFetched = (layer: EdgeLayer, id: number, pending: Pending<Viewer>, stale: Entry | undefined, d: Derived, outcome: Outcome, source: number): void => {
    const now = fast.now()
    layer.pending.delete(id)
    let servedStale = false
    if (outcome === OK) {
      if (source === FROM_ORIGIN) originLatency.add(now - pending.startedAt)
      layer.put(id, new Entry(now + d.ttlMs, OK, d.staleIfErrorMs > 0 ? now + d.ttlMs + d.staleIfErrorMs : Infinity), d.edgeCapacity)
    } else if (stale !== undefined && isServerError(outcome) && now < stale.staleLimit) {
      // The origin is failing and an expired copy is still here: serve it, and leave it for the error caching TTL.
      servedStale = true
      stale.expires = now + d.errorTtlMs
      if (layer.entries.get(id) !== stale) layer.put(id, stale, d.edgeCapacity)
    } else if (isCachedError(statusOf(outcome)) && d.errorTtlMs > 0) {
      layer.put(id, new Entry(now + d.errorTtlMs, statusOf(outcome), Infinity), d.edgeCapacity)
    }
    const effective = servedStale ? OK : outcome
    for (const viewer of pending.waiters) settle(viewer, effective, source, servedStale)
  }

  /** Start the one fetch for an object at an edge location, with `viewer` (if any) waiting on it. */
  const fetchForEdge = (layer: EdgeLayer, edge: number, id: number, position: number, d: Derived, c: Config, stale: Entry | undefined, viewer: Viewer | undefined, message: Message): void => {
    const pending = new Pending<Viewer>(fast.now())
    if (viewer !== undefined) pending.waiters.push(viewer)
    layer.pending.set(id, pending)
    const finished: Done = (outcome, source) => edgeFetched(layer, id, pending, stale, d, outcome, source)
    if (d.regional) fromRegional(edge, id, position, d, c, message, finished)
    else fromOrigins(id, position, d, c, true, false, message, finished)
  }

  // -----------------------------------------------------------------------------------------------------------------
  // Invalidation
  // -----------------------------------------------------------------------------------------------------------------

  const purge = (share: number): void => {
    invalidationCount.n++
    for (const layer of edges) layer?.invalidate(share)
    for (const layer of regionals) layer?.invalidate(share)
    for (const layer of shields.values()) layer.invalidate(share)
  }
  /** An invalidation takes the propagation time to reach every location; until then the cache keeps serving. */
  function purgeLater(c: Config, share: number): void {
    later(Duration.toMillis(c.invalidation.propagation), () => purge(share))
  }

  // -----------------------------------------------------------------------------------------------------------------
  // The request
  // -----------------------------------------------------------------------------------------------------------------

  const reject = (failure: CallFailure, outcome: Outcome): Call => {
    rejectedCount.n++
    countError(outcome)
    return Effect.fail(failure)
  }

  const call = (message: Message): Call => {
    const c = fast.settings()
    const d = c === derivedFrom ? derived : refresh(c)
    requests.n++
    total.requests++
    const write = message.operation === "write"
    const uploaded = message.bytes > 0 ? message.bytes : 0

    // The behaviour's methods and body limit.
    if (write) {
      if (d.readOnly) return reject(Rejected({ node: node.id, reason: "403 Forbidden: this distribution does not allow that HTTP method" }), 403)
      if (bodyTooLarge(uploaded)) return reject(Rejected({ node: node.id, reason: "413 request body larger than 64 GB" }), 413)
    }
    // The distribution's quotas: requests, then bytes.
    buckets()
    const bytes = write ? uploaded : d.responseBytes
    if (!node.limiter.takeUnsafe(rpsKey, rpsBucket) || !node.limiter.takeUnsafe(bandwidthKey, bandwidthBucket, bytes)) {
      rejectedCount.n++
      countError(503)
      return Effect.fail(Throttled({ node: node.id, reason: "503 capacity exceeded: distribution request or bandwidth quota" }))
    }

    // What the edge adds to the viewer's wait: its own processing, a farther edge for viewers the price class leaves out, and viewer functions.
    let overhead = Distribution.latencyMs(c.edge.latency, fast.random)
    if (d.farShare > 0 && fast.random.nextDoubleUnsafe() < d.farShare) overhead += Distribution.latencyMs(c.edge.farLatency, fast.random)
    if (d.viewerRequest !== 0 || d.viewerResponse !== 0) {
      functionFailed = false
      overhead += (d.viewerRequest === 0 ? 0 : hook(d.viewerRequest, c, d)) + (d.viewerResponse === 0 ? 0 : hook(d.viewerResponse, c, d))
      if (functionFailed) {
        functionErrors.n++
        countError(503)
        return Flow.delayed(fast, overhead, () => Unavailable({ node: node.id, reason: "503 edge function failed" }))
      }
    }

    const id = objectOf(message.key, d)
    const position = (id + 0.5) / d.objects

    // Proxied methods are never cached and skip the regional edge cache; so does a GET with nothing to cache.
    if (write || d.ttlMs <= 0) {
      if (write) {
        proxied.n++
        bytesUploaded.n += uploaded
      }
      return Effect.callback<void, CallFailure>((resume) => {
        const viewer = new Viewer(resume, overhead, write ? 0 : d.responseBytes, write)
        fromOrigins(id, position, d, c, false, write, message, (outcome, source) => settle(viewer, outcome, source, false))
        return Effect.sync(() => {
          viewer.open = false
          viewer.timer?.cancel()
        })
      })
    }

    const edge = d.edgeLocations > 1 ? Math.floor(fast.random.nextDoubleUnsafe() * d.edgeLocations) : 0
    const layer = edgeAt(edge)
    const now = fast.now()
    const held = layer.entries.get(id)
    let stale: Entry | undefined
    if (held !== undefined) {
      if (held.expires > now) {
        held.referenced = true
        if (held.status === OK) {
          countHit()
          edgeHit.n++
          bytesDownloaded.n += d.responseBytes
          return Flow.wait(fast, overhead)
        }
        // A cached error: CloudFront answers with it until the error caching TTL runs out.
        errorsCached.n++
        countError(held.status)
        const status = held.status
        return Flow.delayed(fast, overhead, () => failureFor(node.id, status))
      }
      if (held.status === OK) {
        if (now < held.expires + d.staleWhileRevalidateMs) {
          // stale-while-revalidate: answer from the expired copy and let one request refresh it.
          if (!layer.pending.has(id)) fetchForEdge(layer, edge, id, position, d, c, held, undefined, message)
          staleServed.n++
          total.staleServed++
          countHit()
          bytesDownloaded.n += d.responseBytes
          return Flow.wait(fast, overhead)
        }
        stale = held
      } else layer.entries.delete(id)
    }

    // A miss, or an expired object to check with the origin: wait for the one fetch for it.
    return Effect.callback<void, CallFailure>((resume) => {
      const viewer = new Viewer(resume, overhead, d.responseBytes, false)
      const waiting = layer.pending.get(id)
      if (waiting !== undefined) {
        viewer.leader = false
        waiting.waiters.push(viewer)
      } else fetchForEdge(layer, edge, id, position, d, c, stale, viewer, message)
      return Effect.sync(() => {
        viewer.open = false
        viewer.timer?.cancel()
      })
    })
  }


  // -----------------------------------------------------------------------------------------------------------------
  // The clock: recent rates for the gauges, and scheduled invalidation
  // -----------------------------------------------------------------------------------------------------------------

  const recent = { hits: new Float64Array(WINDOW), misses: new Float64Array(WINDOW), requests: new Float64Array(WINDOW), err4xx: new Float64Array(WINDOW), err5xx: new Float64Array(WINDOW) }
  let seen = { hits: 0, misses: 0, requests: 0, err4xx: 0, err5xx: 0 }
  let slot = 0
  let lastPurgeAt = 0
  const sum = (values: Float64Array): number => {
    let s = 0
    for (let i = 0; i < WINDOW; i++) s += values[i]!
    return s
  }
  const ratio = (num: number, den: number): number => (den > 0 ? num / den : 0)
  const tick = (): void => {
    slot = (slot + 1) % WINDOW
    recent.hits[slot] = total.hits - seen.hits
    recent.misses[slot] = total.misses - seen.misses
    recent.requests[slot] = total.requests - seen.requests
    recent.err4xx[slot] = total.err4xx - seen.err4xx
    recent.err5xx[slot] = total.err5xx - seen.err5xx
    seen = { hits: total.hits, misses: total.misses, requests: total.requests, err4xx: total.err4xx, err5xx: total.err5xx }
    const c = fast.settings()
    const every = Duration.toMillis(c.invalidation.every)
    const now = fast.now()
    if (every > 0 && now - lastPurgeAt >= every) {
      lastPurgeAt = now
      purgeLater(c, c.invalidation.share)
    }
    fast.after(SECOND, tick, undefined)
  }
  fast.after(SECOND, tick, undefined)

  /** CacheHitRate: of the cacheable requests (not writes, not errors), the share answered without going to the origin. */
  const recentHitRate = (): number => ratio(sum(recent.hits), sum(recent.hits) + sum(recent.misses))
  node.meter.gaugeUnsafe("cacheHitRate", recentHitRate)
  node.meter.gaugeUnsafe("errorRate4xx", () => ratio(sum(recent.err4xx), sum(recent.requests)))
  node.meter.gaugeUnsafe("errorRate5xx", () => ratio(sum(recent.err5xx), sum(recent.requests)))
  node.meter.gaugeUnsafe("edgeObjects", () => sizeOf(edges))
  node.meter.gaugeUnsafe("regionalObjects", () => sizeOf(regionals))
  node.meter.gaugeUnsafe("shieldObjects", () => sizeOf([...shields.values()]))
  node.meter.gaugeUnsafe("fetching", pendingFetches)

  const probe = Effect.sync(() => {
    const c = fast.settings()
    const d = c === derivedFrom ? derived : refresh(c)
    return {
      objects: d.objects,
      ttlSeconds: d.ttlMs / 1000,
      edgeObjects: sizeOf(edges),
      regionalObjects: sizeOf(regionals),
      shieldObjects: sizeOf([...shields.values()]),
      fetching: pendingFetches(),
      hitRatio: ratio(total.hits, total.hits + total.misses),
      recentHitRatio: recentHitRate(),
      requests: total.requests,
      hits: total.hits,
      misses: total.misses,
      collapsed: total.collapsed,
      staleServed: total.staleServed,
      originRequests: total.originRequests,
      evictions: evictions(),
      errors: { client: total.err4xx, server: total.err5xx }
    }
  })

  return { call, probe }
}
