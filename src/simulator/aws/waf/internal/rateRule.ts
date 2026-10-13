import { MAX_RATE_LIMITED } from "./config.ts"

/**
 * The counting behind a rate-based rule that aggregates on the client IP address.
 *
 * AWS WAF counts each address's requests over a trailing evaluation window, checks "about every 10 seconds" whether an
 * address is over the limit, and rate limits the ones that are until a later check finds them back under it. So the
 * window is kept here as slices of the check interval: at a check, an address's total is exactly its count over the
 * window. Changing the limit, the window or the aggregation resets the counts, as AWS says it does.
 *
 * A request carries no IP address. Each traffic source (the node that made the request, its `origin`) is taken to send
 * from a fixed number of addresses, and a request's key picks one: a client's hot key is one address flooding, and the
 * rest of its traffic is spread evenly. Sources never share addresses, so a botnet's addresses are not real users'.
 *
 * Memory is `addresses x slices` counters per source (12 MB at the extremes of 50,000 addresses and a 10-minute window),
 * and sources are the nodes that send through the web ACL, so it is bounded.
 */

/** What the rule's counting depends on. Any change resets the counts. */
export interface RateSpec {
  readonly limit: number
  /** The evaluation window, in check intervals. */
  readonly slices: number
  /** Addresses per traffic source. */
  readonly addresses: number
}

/** One traffic source: its addresses' counts, by slice. */
class Source {
  /** Requests per slice and address, slice-major: `counts[slice * addresses + address]`. */
  readonly counts: Uint32Array
  /** Each address's requests over the window: the sum of its slices. */
  readonly totals: Uint32Array
  /** 1 while the rule rate limits the address. */
  readonly limited: Uint8Array
  constructor(readonly addresses: number, slices: number) {
    this.counts = new Uint32Array(addresses * slices)
    this.totals = new Uint32Array(addresses)
    this.limited = new Uint8Array(addresses)
  }
}

/** Which addresses to rate limit, as one check decided. It is applied after the propagation delay. */
export interface Decision {
  /** The counts it was made from; a reset in between makes it stale. */
  readonly generation: number
  readonly seq: number
  readonly sources: ReadonlyArray<Source>
  readonly addresses: ReadonlyArray<number>
}

export interface RateTracker {
  /** Take on new settings; resets the counts if any of them changed. `undefined` turns the rule off and forgets everything. */
  readonly configure: (spec: RateSpec | undefined) => void
  /** Count one request from `origin` with `key`, and say whether its address is being rate limited. */
  readonly see: (origin: string, key: number) => boolean
  /** A check: every address over the limit, at most 10,000, the highest counts first. */
  readonly evaluate: () => Decision
  /** Rate limit exactly the addresses a check decided on. A decision older than one already applied, or than a reset, is ignored. */
  readonly apply: (decision: Decision) => void
  /** Close the current slice and open a new one, dropping the slice that falls out of the window. */
  readonly advance: () => void
  /** Addresses being rate limited now. */
  readonly limitedCount: () => number
  /** The highest count over the window of any address, at the last check. */
  readonly busiest: () => number
  readonly sources: () => number
}

/** The address of a key in [0, 1) among `n`; anything odd (NaN, out of range) lands on an end. */
export const addressOf = (key: number, n: number): number => {
  const i = Math.floor(key * n)
  return i >= 0 ? (i < n ? i : n - 1) : 0
}

export const makeRateTracker = (): RateTracker => {
  let spec: RateSpec | undefined
  const sources = new Map<string, Source>()
  let slot = 0
  let generation = 0
  let seq = 0
  let applied = 0
  let limitedNow = 0
  let busiestAtCheck = 0
  // The last source looked up: a run of requests from one client skips the map.
  let lastOrigin: string | undefined
  let lastSource: Source | undefined

  const reset = (): void => {
    sources.clear()
    lastOrigin = undefined
    lastSource = undefined
    slot = 0
    generation++
    limitedNow = 0
    busiestAtCheck = 0
  }

  const sourceOf = (origin: string, s: RateSpec): Source => {
    if (origin === lastOrigin && lastSource !== undefined) return lastSource
    let source = sources.get(origin)
    if (source === undefined) sources.set(origin, (source = new Source(s.addresses, s.slices)))
    lastOrigin = origin
    lastSource = source
    return source
  }

  const evaluate = (): Decision => {
    const picked: Array<Source> = []
    const at: Array<number> = []
    const counts: Array<number> = []
    let busiest = 0
    if (spec !== undefined) {
      const limit = spec.limit
      // Map order is the order sources first sent, which a seed fixes: ties break the same way every run.
      for (const source of sources.values()) {
        const totals = source.totals
        for (let a = 0; a < source.addresses; a++) {
          const n = totals[a]!
          if (n > busiest) busiest = n
          if (n > limit) {
            picked.push(source)
            at.push(a)
            counts.push(n)
          }
        }
      }
    }
    busiestAtCheck = busiest
    seq++
    if (picked.length <= MAX_RATE_LIMITED) return { generation, seq, sources: picked, addresses: at }
    // Past 10,000, AWS WAF "limits those with the highest rates". A stable sort keeps ties in source order.
    const order = Array.from(picked.keys()).sort((x, y) => counts[y]! - counts[x]!).slice(0, MAX_RATE_LIMITED)
    return { generation, seq, sources: order.map((i) => picked[i]!), addresses: order.map((i) => at[i]!) }
  }

  const apply = (d: Decision): void => {
    if (d.generation !== generation || d.seq <= applied) return
    applied = d.seq
    for (const source of sources.values()) source.limited.fill(0)
    for (let i = 0; i < d.sources.length; i++) d.sources[i]!.limited[d.addresses[i]!] = 1
    limitedNow = d.sources.length
  }

  const advance = (): void => {
    if (spec === undefined) return
    slot = (slot + 1) % spec.slices
    for (const source of sources.values()) {
      const n = source.addresses
      const base = slot * n
      const { counts, totals } = source
      for (let a = 0; a < n; a++) {
        totals[a]! -= counts[base + a]!
        counts[base + a] = 0
      }
    }
  }

  return {
    configure: (next) => {
      if (next === undefined) {
        if (spec !== undefined) reset()
        spec = undefined
        return
      }
      if (spec !== undefined && spec.limit === next.limit && spec.slices === next.slices && spec.addresses === next.addresses) return
      if (spec !== undefined) reset()
      spec = next
    },
    see: (origin, key) => {
      const s = spec
      if (s === undefined) return false
      const source = sourceOf(origin, s)
      const a = addressOf(key, source.addresses)
      source.counts[slot * source.addresses + a]!++
      source.totals[a]!++
      return source.limited[a] === 1
    },
    evaluate,
    apply,
    advance,
    limitedCount: () => limitedNow,
    busiest: () => busiestAtCheck,
    sources: () => sources.size
  }
}
