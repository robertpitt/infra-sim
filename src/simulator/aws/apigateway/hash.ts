/**
 * Splitting a request's key into independent choices.
 *
 * A message carries one uniform `key` in [0, 1) (the hash of its partition key). The gateway needs several choices from
 * it that should not all line up: which route a request is for, which API key it carries, who its caller is, which cache
 * entry it asks for. Each takes the same key through a different salt, so they are independent of one another while a
 * given key always makes the same choices (a hot key is one route, one client and one cache entry).
 */
export const SALT_ROUTE = 0x9e3779b1
export const SALT_CLIENT = 0x85ebca6b
export const SALT_IDENTITY = 0xc2b2ae35
export const SALT_CACHE = 0x27d4eb2f
export const SALT_DENY = 0x165667b1

/** A number in [0, 1) derived from an integer and a salt (a multiplicative hash: deterministic, well spread). */
export const unitOf = (n: number, salt: number): number => {
  let h = Math.imul((n ^ salt) >>> 0, 2654435761)
  h ^= h >>> 15
  h = Math.imul(h, 2246822519)
  h ^= h >>> 13
  return (h >>> 0) / 4294967296
}

/** One of `count` buckets for a key in [0, 1), chosen under `salt`. */
export const bucketOf = (key: number, salt: number, count: number): number => {
  const n = Math.floor(unitOf(Math.floor(key * 4294967296), salt) * count)
  return n < count ? n : count - 1
}
