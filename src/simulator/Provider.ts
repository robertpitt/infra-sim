import type { Schema } from "effect"
import type { AnyConnector } from "./Connector.ts"
import type { AnyController } from "./Controller.ts"
import type { Diagnostic } from "./Diagnostic.ts"

/**
 * Providers and where things run.
 *
 * Every component belongs to a provider (`aws`, later `cloudflare`, `azure`...) or to the public `internet`,
 * and every node runs in one of that provider's regions. A `Placement` is the pair. It decides how far apart two
 * nodes are (and so the default latency of an edge between them), which regional quotas they share, and which
 * regional failures take them down.
 */

export interface Region {
  readonly id: string
  readonly name: string
  readonly lat: number
  readonly lon: number
}

export interface Provider {
  readonly id: string
  readonly title: string
  readonly regions: ReadonlyArray<Region>
  readonly defaultRegion: string
  /**
   * Quotas that belong to an account in a region rather than to a component: Lambda's regional concurrency, API
   * Gateway's regional throttle. Components in the same placement share them. A `Schema.Struct` of `Setting`s,
   * built per region because published defaults differ by region.
   */
  readonly account: (region: string) => Schema.Struct<Schema.Struct.Fields>
  /**
   * Check what a design asks of one account and region against that account's quotas: reservations that add up to
   * more than the account has, provisioned capacity over the account total. `account` is the decoded quota settings.
   */
  readonly audit?: (region: string, members: ReadonlyArray<Member>, account: unknown) => ReadonlyArray<Diagnostic>
  /**
   * What the provider puts between its components: Lambda's event source mapping between a queue and a function, say.
   * A registry built with the provider offers them, and picks them for wires they fit (see `Connector.ts`).
   */
  readonly connectors?: ReadonlyArray<AnyConnector>
  /** Controllers the provider offers besides the core ones (a provider's own autoscaling policies, say). */
  readonly controllers?: ReadonlyArray<AnyController>
}

/** A node in a placement, as an audit sees it: its decoded settings. */
export interface Member {
  readonly id: string
  readonly name: string
  readonly type: string
  readonly config: unknown
}

export interface Placement {
  readonly provider: string
  readonly region: string
}

/** `aws:us-east-1`: the identity of a placement, used for shared quotas and regional faults. */
export const keyOf = (p: Placement): string => `${p.provider}:${p.region}`

export const parseKey = (key: string): Placement => {
  const i = key.indexOf(":")
  return { provider: key.slice(0, i), region: key.slice(i + 1) }
}

const EARTH_KM = 6371

const distanceKm = (a: Region, b: Region): number => {
  const rad = (d: number) => (d * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLon = rad(b.lon - a.lon)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h))
}

/** The "provider" for things outside any cloud: end users, third-party APIs. Its regions are just places. */
export const INTERNET = "internet"

/**
 * Typical one-way network latency between two placements, in milliseconds.
 *
 * Clouds don't publish inter-region latency, so this is an estimate: fibre carries light at about 200 km/ms, real
 * routes are longer than great circles (x1.35), plus a millisecond inside a region. Crossing providers adds transit,
 * and anything touching the public internet adds a last mile. It is a starting point; every edge's latency stays editable.
 */
export const oneWayLatencyMs = (a: Placement, b: Placement, regionOf: (p: Placement) => Region | undefined): number => {
  const ra = regionOf(a)
  const rb = regionOf(b)
  const sameRegion = a.provider === b.provider && a.region === b.region
  const base = sameRegion || ra === undefined || rb === undefined ? 1 : 1 + (distanceKm(ra, rb) / 200) * 1.35
  const touchesInternet = a.provider === INTERNET || b.provider === INTERNET
  const crossProvider = a.provider !== b.provider
  return base + (touchesInternet ? 10 : crossProvider ? 3 : 0)
}
