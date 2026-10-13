import { bucketOf, SALT_DENY, SALT_IDENTITY, unitOf } from "./hash.ts"

/** The three things a cached authorizer answer can be. */
export const Verdict = { Unknown: 0, Allow: 1, Deny: 2 } as const
export type Verdict = (typeof Verdict)[keyof typeof Verdict]

/** Which caller a request is from, as an index in [0, identities). */
export const identityOf = (key: number, identities: number): number => bucketOf(key, SALT_IDENTITY, identities)

/**
 * Whether the authorizer refuses this caller. It depends only on who the caller is, so the same caller is always denied
 * or always allowed, and `deny` is the share of callers (not of requests) that are refused.
 */
export const isDenied = (identity: number, deny: number): boolean => deny > 0 && unitOf(identity, SALT_DENY) < deny

/**
 * A Lambda authorizer's result cache: one slot per caller identity holding the verdict and when it expires.
 *
 * API Gateway caches a Lambda authorizer's policy for the TTL (default 300 s, at most 3,600 s) keyed by the identity
 * source, so the function is not invoked again for the same caller until it expires. Two requests for the same caller
 * that arrive before the first answer is back both miss and both invoke the function (AWS does not say it coalesces them).
 * The cache is a pair of typed arrays sized by the number of distinct callers, so it cannot grow past that.
 */
export interface AuthorizerCache {
  /** The cached verdict for `identity` at `now`, or `Unknown` when there is none or it has expired. */
  readonly lookup: (identity: number, now: number, identities: number) => Verdict
  readonly store: (identity: number, verdict: Verdict, expiresAt: number, identities: number) => void
}

export const makeAuthorizerCache = (): AuthorizerCache => {
  let expiry = new Float64Array(0)
  let verdicts = new Uint8Array(0)
  const room = (identities: number): void => {
    if (identities <= expiry.length) return
    const nextExpiry = new Float64Array(identities)
    const nextVerdicts = new Uint8Array(identities)
    nextExpiry.set(expiry)
    nextVerdicts.set(verdicts)
    expiry = nextExpiry
    verdicts = nextVerdicts
  }
  return {
    lookup: (identity, now, identities) => {
      room(identities)
      return now < expiry[identity]! ? (verdicts[identity] as Verdict) : Verdict.Unknown
    },
    store: (identity, verdict, expiresAt, identities) => {
      room(identities)
      verdicts[identity] = verdict
      expiry[identity] = expiresAt
    }
  }
}
