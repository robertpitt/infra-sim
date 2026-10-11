import { asBoolean, asNumber, asString, isUnresolved, referencesIn } from "../Intrinsics.ts"
import { integrationTargets } from "./common.ts"
import { type Bag, type Draft, type Handler, known, listOf, nameOf, type Resource, type Run, SOURCE, type TemplateContext } from "./model.ts"

/**
 * `AWS::CloudFront::Distribution`: the distribution is a component, each origin an edge from it to what the origin's
 * domain names, and the default cache behavior, price class, error caching and edge functions are its settings.
 *
 * A distribution has any number of cache behaviors, each sending a path pattern to an origin with its own caching and
 * functions; the component has one. Only the default behavior is read, and the others are reported.
 */

export const distribution: Handler = (run, r) => {
  if (asBoolean(r.props.DistributionConfig?.Enabled) === false) {
    run.skip(r, "the distribution is disabled, so it serves nothing", true)
    return
  }
  run.draft(r.id, nameOf(r), "aws.cloudfront", { source: SOURCE, ref: r.id, type: r.type })
}

/** The cache policies AWS manages, by the id a template uses, as the TTLs they set (seconds). */
const MANAGED_CACHE_POLICIES: Record<string, { readonly min: number; readonly default: number; readonly max: number }> = {
  // CachingOptimized
  "658327ea-f89d-4fab-a63d-7e88639e58f6": { min: 1, default: 86_400, max: 31_536_000 },
  // CachingOptimizedForUncompressedObjects
  "b2884449-e4de-46a7-ac36-70bc7f1ddd6d": { min: 1, default: 86_400, max: 31_536_000 },
  // CachingDisabled
  "4135ea2d-6df8-44a3-9df3-4b5a84be39ad": { min: 0, default: 0, max: 0 }
}

const PRICE_CLASS: Record<string, string> = { PriceClass_All: "all", PriceClass_200: "200", PriceClass_100: "100" }

/** Where in the component's `functions` an event type goes. */
const FUNCTION_EVENT: Record<string, string> = {
  "viewer-request": "viewerRequest",
  "viewer-response": "viewerResponse",
  "origin-request": "originRequest",
  "origin-response": "originResponse"
}

/** A host that is an S3 endpoint (`bucket.s3.amazonaws.com`, `bucket.s3.eu-west-1.amazonaws.com`, `bucket.s3-website-...`). */
const S3_HOST = /^([^.]+)\.s3[.-]/

const status = (code: number): "clientErrors" | "status500" | "status502" | "status503" | "status504" | undefined =>
  code >= 400 && code < 500 ? "clientErrors" : code === 500 ? "status500" : code === 502 ? "status502" : code === 503 ? "status503" : code === 504 ? "status504" : undefined

export const distributionWiring = (run: Run, r: Resource, ctx: TemplateContext): void => {
  const d = run.drafts.get(r.id)
  if (d === undefined) return
  const config = (r.props.DistributionConfig ?? {}) as Bag
  behavior(run, d, config.DefaultCacheBehavior as Bag | undefined, ctx)
  const extra = listOf(config.CacheBehaviors)
  if (extra.length > 0) {
    const paths = extra.map((b) => asString(b.PathPattern)).filter((x): x is string => x !== undefined).slice(0, 4)
    run.warn(`${d.name} has ${extra.length} more cache ${extra.length === 1 ? "behavior" : "behaviors"}${paths.length > 0 ? ` (${paths.join(", ")}${extra.length > paths.length ? ", ..." : ""})` : ""}: the component has one cache behavior, so only the default one is simulated.`)
  }
  const price = config.PriceClass
  if (price !== undefined) run.set(d, ["edge", "priceClass"], known(PRICE_CLASS[String(price)], price), "PriceClass")

  // How long an error is remembered: the component has one figure, so the longest the template names stands for them all.
  const errors = listOf(config.CustomErrorResponses).map((e) => asNumber(e.ErrorCachingMinTTL)).filter((n): n is number => n !== undefined)
  if (errors.length > 0) {
    run.set(d, ["cache", "errorMinTtl"], `${Math.max(...errors)} seconds`, "CustomErrorResponses.ErrorCachingMinTTL")
    if (new Set(errors).size > 1) run.warn(`${d.name}: its error responses cache for different times, but the component has one error caching TTL; it uses the longest (${Math.max(...errors)} s).`)
  }

  origins(run, d, config)
}

/** The default cache behavior: TTLs, compression, allowed methods, and the functions that run on requests. */
const behavior = (run: Run, d: Draft, b: Bag | undefined, ctx: TemplateContext): void => {
  if (b === undefined) return
  // A cache policy (one of the template's, or a managed one by id) sets the TTLs; older templates put them on the behavior.
  const policyRef = b.CachePolicyId
  const policy = [...ctx.resources.values()].find((o) => o.type === "AWS::CloudFront::CachePolicy" && referencesIn(policyRef).includes(o.id))
  const ttls = policy !== undefined
    ? { default: asNumber(policy.props.CachePolicyConfig?.DefaultTTL), min: asNumber(policy.props.CachePolicyConfig?.MinTTL), max: asNumber(policy.props.CachePolicyConfig?.MaxTTL) }
    : typeof policyRef === "string" && policyRef in MANAGED_CACHE_POLICIES
      ? MANAGED_CACHE_POLICIES[policyRef]!
      : { default: asNumber(b.DefaultTTL), min: asNumber(b.MinTTL), max: asNumber(b.MaxTTL) }
  if (policy !== undefined) run.consumed(policy, d)
  const seconds = (n: number | undefined): string | undefined => (n === undefined ? undefined : `${n} seconds`)
  run.set(d, ["cache", "defaultTtl"], seconds(ttls.default), "DefaultTTL")
  run.set(d, ["cache", "minTtl"], seconds(ttls.min), "MinTTL")
  run.set(d, ["cache", "maxTtl"], seconds(ttls.max), "MaxTTL")
  if (policyRef !== undefined && policy === undefined && typeof policyRef === "string" && !(policyRef in MANAGED_CACHE_POLICIES)) {
    run.warn(`${d.name}: the cache policy ${policyRef} isn't one of the template's or a known managed policy, so the component's default TTLs stand.`)
  }

  // Compression and the methods a behavior allows both default to off/read-only in CloudFront, unlike the component.
  run.set(d, ["compression", "enabled"], known(asBoolean(b.Compress) ?? (isUnresolved(b.Compress) ? undefined : false), b.Compress), "Compress")
  const methods = listOf(b.AllowedMethods).map(String)
  run.set(d, ["allowedMethods"], methods.some((m) => ["PUT", "POST", "PATCH", "DELETE"].includes(m)) ? "all" : "read", "AllowedMethods")

  for (const [key, setting, kind] of [["LambdaFunctionAssociations", "LambdaFunctionARN", "lambda"], ["FunctionAssociations", "FunctionARN", "function"]] as const) {
    for (const association of listOf(b[key])) {
      const slot = FUNCTION_EVENT[String(association.EventType)]
      if (slot === undefined) continue
      run.set(d, ["functions", slot], kind, `${key}.EventType`)
      // Lambda@Edge runs inside CloudFront, whatever the function node says: it isn't called, so it isn't wired.
      for (const fn of run.targets(association[setting])) {
        if (fn.type !== "aws.lambda") continue
        run.edgeFunctions.add(fn)
        run.warn(`${fn.name} runs at the edge for ${d.name} (${String(association.EventType)}): the component models that with its functions settings (duration, timeout, error rate), so the function node itself is not called.`)
      }
      // A CloudFront Function is code inside the distribution, not a component.
      for (const id of referencesIn(association[setting])) {
        const code = ctx.resources.get(id)
        if (code?.type === "AWS::CloudFront::Function") run.consumed(code, d)
      }
    }
  }
}

/** One edge from the distribution to what each origin's domain names, with the origin's settings. */
const origins = (run: Run, d: Draft, config: Bag): void => {
  const groups = listOf(config.OriginGroups?.Items)
  const secondary = new Set(groups.map((g) => asString(listOf(g.Members?.Items)[1]?.OriginId)).filter((x): x is string => x !== undefined))

  // Failover applies to a distribution as a whole in the component; the status codes of every group are added together.
  if (groups.length > 0) {
    const sets = groups.map((g) => new Set(listOf(g.FailoverCriteria?.StatusCodes?.Items).map(Number).map(status).filter((s) => s !== undefined)))
    const all = new Set(sets.flatMap((s) => [...s]))
    for (const key of ["clientErrors", "status500", "status502", "status503", "status504"] as const) run.set(d, ["failover", key], all.has(key), "OriginGroups.FailoverCriteria")
    if (sets.some((s) => s.size !== all.size)) run.warn(`${d.name}: its origin groups fail over on different status codes, but the component has one list; it uses every code any of them names.`)
  }

  for (const origin of listOf(config.Origins)) {
    const id = asString(origin.Id) ?? "origin"
    const target = originTarget(run, origin, id)
    if (target === undefined) {
      run.warn(`${d.name}: the origin ${id} (${isUnresolved(origin.DomainName) ? origin.DomainName.reason : asString(origin.DomainName) ?? "no domain"}) can't be told from the template, so it isn't connected.`)
      continue
    }
    const s3 = origin.S3OriginConfig !== undefined || target.type === "aws.s3" || (target.type === "common.http-endpoint" && S3_HOST.test(asString(origin.DomainName) ?? ""))
    const settings: Record<string, unknown> = {
      originType: s3 ? "s3" : "custom",
      // The call CloudFront makes to fetch an object is a read. The component's own default is read, but a template's wiring is explicit about it.
      request: { operation: "read" }
    }
    if (secondary.has(id)) settings.role = "secondary"
    if (asBoolean(origin.OriginShield?.Enabled) === true) settings.shield = true
    const attempts = asNumber(origin.ConnectionAttempts)
    if (attempts !== undefined) settings.connectionAttempts = attempts
    // What the template calls OriginReadTimeout (the wait for a response) is the component's responseTimeout.
    const read = asNumber(origin.CustomOriginConfig?.OriginReadTimeout)
    if (read !== undefined) settings.responseTimeout = `${read} seconds`
    const completion = asNumber(origin.ResponseCompletionTimeout)
    if (completion !== undefined) settings.responseCompletionTimeout = `${completion} seconds`
    run.wire(d, "out", target, { settings, name: id, origin: { source: SOURCE, ref: `${d.origin?.ref ?? d.name}.Origins.${id}` } })
  }
}

/** The component an origin's domain names: a resource of the template, a bucket by its name, or an external host. */
const originTarget = (run: Run, origin: Bag, id: string): Draft | undefined => {
  const domain = origin.DomainName
  const found = run.targets(domain)[0]
  if (found !== undefined) return found
  const host = asString(domain)
  if (host === undefined || host.includes("${")) return undefined
  const bucket = S3_HOST.exec(host)?.[1]
  const named = bucket === undefined ? undefined : run.byName(["AWS::S3::Bucket", "AWS::S3Express::DirectoryBucket"], "BucketName", bucket)
  return named ?? integrationTargets(run, `https://${host}`, id)[0]
}
