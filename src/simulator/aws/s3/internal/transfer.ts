import { MAX_OBJECT_BYTES, MAX_PARTS, MULTIPART_CONTROL_REQUESTS, SINGLE_PUT_MAX_BYTES } from "./limits.ts"
import { MiB } from "../../internal/units.ts"

/**
 * What one call asks of S3, by the kind of request it is, and how long moving its bytes takes. Pure arithmetic over
 * numbers so the handler stays a plain function, and so the multipart maths can be tested without a simulation.
 */

/** The seven operations the component tells apart. GET, HEAD and LIST are reads; PUT, COPY and DELETE are writes (POST is folded into PUT). */
export type Kind = "get" | "head" | "list" | "put" | "copy" | "delete"

/** Kinds that carry a body into the object store: they are the ones the 5 GB single-request limit and multipart apply to. */
export const isUpload = (kind: Kind): boolean => kind === "put" || kind === "copy"

/** Bytes that move for a request: only GET, PUT and COPY have a body. */
export const carriesBody = (kind: Kind): boolean => kind === "get" || kind === "put" || kind === "copy"

export interface Multipart {
  readonly enabled: boolean
  /** MiB */
  readonly threshold: number
  /** MiB */
  readonly partSize: number
  readonly concurrency: number
}

/** The plan for one call. Reused between calls (one per node) so planning allocates nothing. */
export interface Plan {
  /** Requests charged to the prefix: one per call, or per part plus the two multipart POSTs. */
  tokens: number
  /** Parts moved (UploadPart or ranged GET); 0 for a plain request. */
  parts: number
  /** Multipart control requests (initiate and complete). */
  posts: number
  /** Time before the first byte beyond the sampled first-byte latency: a multipart upload starts with an initiate round trip. */
  beforeMs: number
  /** Time after the first byte: moving the bytes, plus the first-byte overhead of every part after the first wave. */
  afterMs: number
}

export const newPlan = (): Plan => ({ tokens: 1, parts: 0, posts: 0, beforeMs: 0, afterMs: 0 })

/**
 * Whether a call is refused for size: a body over 5 GB without multipart, or over the largest object S3 stores.
 * `bytes` is the whole message and `count` the requests in it; the limits apply to each request.
 */
export const tooLarge = (kind: Kind, bytes: number, count: number, multipart: boolean): boolean => {
  if (!isUpload(kind)) return false
  const each = bytes / count
  return each > MAX_OBJECT_BYTES || (each > SINGLE_PUT_MAX_BYTES && !multipart)
}

/**
 * Work out how many requests a call is and how long its transfer takes.
 *
 * Plain: one connection moves `bytes` at `perConnection` (bytes per ms), serially for a batch.
 *
 * Multipart (when enabled and each object reaches the threshold): each object is cut into parts of `partSize`, raised
 * if that would need more than 10,000 parts. `concurrency` parts move at once, so the bytes move at up to
 * `concurrency` times the per-connection rate, and every wave of parts after the first pays a first-byte latency
 * (`firstByteMs`, the mean: a draw per wave would cost more than it tells). An upload also pays an initiate and a
 * complete round trip, and both are requests on the prefix.
 */
export const plan = (
  out: Plan,
  kind: Kind,
  count: number,
  bytes: number,
  multipart: Multipart,
  perConnection: number,
  firstByteMs: number
): Plan => {
  const each = bytes / count
  if (multipart.enabled && carriesBody(kind) && each >= multipart.threshold * MiB) {
    const partBytes = Math.max(multipart.partSize * MiB, Math.ceil(each / MAX_PARTS))
    const parts = Math.ceil(each / partBytes) * count
    const posts = isUpload(kind) ? MULTIPART_CONTROL_REQUESTS * count : 0
    const connections = Math.min(multipart.concurrency, parts)
    const waves = Math.ceil(parts / connections)
    out.tokens = parts + posts
    out.parts = parts
    out.posts = posts
    out.beforeMs = posts > 0 ? firstByteMs : 0
    out.afterMs = (waves - 1) * firstByteMs + bytes / (connections * perConnection) + (posts > 0 ? firstByteMs : 0)
  } else {
    out.tokens = count
    out.parts = 0
    out.posts = 0
    out.beforeMs = 0
    out.afterMs = carriesBody(kind) ? bytes / perConnection : 0
  }
  return out
}
