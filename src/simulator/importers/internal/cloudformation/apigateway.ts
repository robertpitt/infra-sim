import { asBoolean, asNumber, asString, isUnresolved, referencesIn } from "../../Intrinsics.ts"
import { integrationTargets, num } from "./common.ts"
import { type Bag, type Draft, type Handler, listOf, millis, nameOf, type Resource, type Run, SOURCE } from "./model.ts"

/**
 * REST APIs (`AWS::ApiGateway::*`), HTTP APIs (`AWS::ApiGatewayV2::*`) and SAM's `Api` and `HttpApi`: the integration each
 * method or route calls, throttles, the endpoint type, the stage cache, usage plans, authorizers, and how many routes there are.
 *
 * The component is one gateway with one setting for each of these, whatever the number of methods, so several things
 * a template says per method are folded into one here. Each such fold that could change the result is reported.
 */

// ---------------------------------------------------------------------------------------------------------
// What is learned about an API from the resources around it
// ---------------------------------------------------------------------------------------------------------

type AuthorizerType = "lambda" | "jwt" | "cognito"

interface Authorizer {
  readonly type: AuthorizerType
  readonly ttl: number | undefined
  /** The function that checks, for a Lambda authorizer. Looked up when needed: SAM names it before every function has been read. */
  readonly fn: () => Draft | undefined
}

/** What methods and routes, read one by one, add up to for the API they belong to. */
interface ApiState {
  /** Methods or routes that traffic can use (not the CORS preflight OPTIONS that CDK adds to every resource). */
  routes: number
  /** Routes found in an inline OpenAPI document, used when no method or route resources say. */
  bodyRoutes: number
  mock: number
  proxied: number
  /** Routes that are authorized, whichever way. */
  authorized: number
  iam: boolean
  authorizers: Map<string, Authorizer>
  /** SAM's `DefaultAuthorizer`: every route that doesn't say otherwise uses it. */
  defaultAll: boolean
  /** A method names an authorizer the template doesn't contain. */
  externalAuthorizer: boolean
}

const states = new WeakMap<Draft, ApiState>()

const stateOf = (d: Draft): ApiState => {
  let s = states.get(d)
  if (s === undefined) {
    s = { routes: 0, bodyRoutes: 0, mock: 0, proxied: 0, authorized: 0, iam: false, authorizers: new Map(), defaultAll: false, externalAuthorizer: false }
    states.set(d, s)
  }
  return s
}

/** The API a satellite resource (integration, stage, method) belongs to. */
const apiOf = (run: Run, id: unknown): Draft | undefined => {
  const d = run.targets(id)[0]
  return d?.type === "aws.apigateway" ? d : undefined
}

// ---------------------------------------------------------------------------------------------------------
// The API itself
// ---------------------------------------------------------------------------------------------------------

/** REST endpoint types as the component names them. HTTP APIs are always regional. */
const ENDPOINT: Record<string, string> = { REGIONAL: "regional", EDGE: "edge", PRIVATE: "private" }

export const api: Handler = (run, r) => {
  const http = r.type === "AWS::ApiGatewayV2::Api" || r.type === "AWS::Serverless::HttpApi"
  if (r.type === "AWS::ApiGatewayV2::Api" && r.props.ProtocolType === "WEBSOCKET") {
    run.skip(r, "WebSocket APIs aren't modelled")
    return
  }
  const d = run.draft(r.id, nameOf(r), "aws.apigateway", { source: SOURCE, ref: r.id, type: r.type })
  const p = r.props
  run.set(d, ["apiType"], http ? "http" : "rest", r.type)
  if (!http) {
    // CloudFormation writes `Types: [REGIONAL]`; SAM writes `Type: REGIONAL`, or just the word.
    const config = p.EndpointConfiguration
    const first = listOf(typeof config === "string" ? config : config?.Types ?? config?.Type)[0]
    const endpoint = ENDPOINT[String(first)]
    if (first !== undefined && endpoint === undefined) run.warn(`${d.name}: the endpoint type ${String(first)} isn't one the simulator knows (regional, edge or private).`)
    run.set(d, ["endpoint"], endpoint, "EndpointConfiguration")
  }
  // Throttling and caching from a stage definition inlined on the API (SAM).
  throttle(run, d, p.DefaultRouteSettings ?? p.MethodSettings)
  if (!http) stageCache(run, d, p)
  samAuth(run, d, p.Auth)
  // Everything that is learned from methods, routes and authorizers is applied once they have all been read.
  run.later(() => finish(run, d))
}

/** Stage or method throttling: `ThrottlingRateLimit` and `ThrottlingBurstLimit`. */
const throttle = (run: Run, d: Draft, settings: unknown): void => {
  const list = listOf(settings)
  const wide = list.find((s) => (s.HttpMethod === undefined || s.HttpMethod === "*") && s.ThrottlingRateLimit !== undefined) ?? list.find((s) => s.ThrottlingRateLimit !== undefined)
  if (wide === undefined) return
  run.set(d, ["stageThrottle", "rate"], asNumber(wide.ThrottlingRateLimit), "ThrottlingRateLimit")
  run.set(d, ["stageThrottle", "burst"], asNumber(wide.ThrottlingBurstLimit), "ThrottlingBurstLimit")
}

/**
 * The stage's response cache: `CacheClusterEnabled` and `CacheClusterSize` on the stage, and the time to live and which
 * methods are cached in `MethodSettings`. A method setting of `*` caches every method, anything else only GETs.
 */
const stageCache = (run: Run, d: Draft, p: Bag): void => {
  const enabled = asBoolean(p.CacheClusterEnabled)
  if (enabled !== undefined) run.set(d, ["cache", "enabled"], enabled, "CacheClusterEnabled")
  const size = p.CacheClusterSize
  if (size !== undefined) run.set(d, ["cache", "size"], isUnresolved(size) ? size : String(size), "CacheClusterSize")
  const cached = listOf(p.MethodSettings).filter((m) => asBoolean(m.CachingEnabled) === true)
  const wide = cached.find((m) => m.HttpMethod === undefined || m.HttpMethod === "*") ?? cached[0]
  if (wide !== undefined) {
    const ttl = asNumber(wide.CacheTtlInSeconds)
    // The cache is the stage's; CachingEnabled on a method does nothing without a cache cluster.
    if (ttl !== undefined) run.set(d, ["cache", "ttl"], `${ttl} seconds`, "CacheTtlInSeconds")
    if (cached.some((m) => m.HttpMethod === "*")) run.set(d, ["cache", "scope"], "all", "MethodSettings.HttpMethod")
    if (enabled !== true) run.warn(`${d.name}: methods have CachingEnabled but the stage has no cache cluster (CacheClusterEnabled), so nothing is cached.`)
  }
}

// ---------------------------------------------------------------------------------------------------------
// Authorizers and usage plans
// ---------------------------------------------------------------------------------------------------------

/** Authorizer types of both API flavours as the component names them. */
const authorizerType = (type: unknown): AuthorizerType | undefined => {
  switch (type) {
    case "TOKEN":
    case "REQUEST":
    case "CUSTOM":
      return "lambda"
    case "COGNITO_USER_POOLS":
      return "cognito"
    case "JWT":
      return "jwt"
    default:
      return undefined
  }
}

/** The function an authorizer calls: the `functions/${Fn.Arn}/invocations` in its URI, or SAM's `FunctionArn`. */
const authorizerFunction = (run: Run, uri: unknown): Draft | undefined => run.target(uri, "aws.lambda")

/** `AWS::ApiGateway::Authorizer` and `AWS::ApiGatewayV2::Authorizer`. */
const authorizer = (run: Run, r: Resource): void => {
  const p = r.props
  const d = apiOf(run, p.RestApiId ?? p.ApiId)
  if (d === undefined) {
    run.skip(r, "its API isn't in this template")
    return
  }
  const type = authorizerType(p.Type ?? p.AuthorizerType)
  if (type === undefined) {
    run.warn(`${d.name}: the authorizer ${r.id} has a type (${String(p.Type ?? p.AuthorizerType)}) the simulator doesn't know.`)
  } else {
    const ttl = asNumber(p.AuthorizerResultTtlInSeconds)
    stateOf(d).authorizers.set(r.id, { type, ttl, fn: () => (type === "lambda" ? authorizerFunction(run, p.AuthorizerUri) : undefined) })
  }
  run.consumed(r, d)
}

/** SAM authorizers by name, kept until the default or a function's event says one is used. */
const named = new WeakMap<Draft, Map<string, Authorizer>>()

/**
 * SAM's `Auth` on an API: named authorizers, which one is the default, and a usage plan. A function's own `Auth` picks
 * among them per route (read with its event).
 */
const samAuth = (run: Run, d: Draft, auth: unknown): void => {
  if (auth === null || typeof auth !== "object") return
  const a = auth as Bag
  const s = stateOf(d)
  const known = new Map<string, Authorizer>()
  named.set(d, known)
  for (const [name, def] of Object.entries((a.Authorizers ?? {}) as Bag)) {
    const type: AuthorizerType | undefined = def.FunctionArn !== undefined ? "lambda" : def.UserPoolArn !== undefined ? "cognito" : def.JwtConfiguration !== undefined || def.OpenIdConnectUrl !== undefined ? "jwt" : undefined
    if (type === undefined) continue
    known.set(name, { type, ttl: asNumber(def.Identity?.ReauthorizeEvery), fn: () => (type === "lambda" ? authorizerFunction(run, def.FunctionArn) : undefined) })
  }
  const chosen = asString(a.DefaultAuthorizer)
  if (chosen === "AWS_IAM") {
    s.iam = true
    s.defaultAll = true
  } else if (chosen !== undefined && chosen !== "NONE" && known.has(chosen)) {
    s.authorizers.set(chosen, known.get(chosen)!)
    s.defaultAll = true
  }
  if (a.UsagePlan !== undefined) usagePlanSettings(run, d, a.UsagePlan)
}

/** `AWS::ApiGateway::UsagePlan`, and SAM's `Auth.UsagePlan`: a per-key throttle and quota. */
const usagePlanSettings = (run: Run, d: Draft, plan: Bag, clients?: number): void => {
  run.set(d, ["usagePlan", "enabled"], true, "UsagePlan")
  // A plan with a quota and no throttle doesn't limit the rate, whereas the component's default plan does.
  run.set(d, ["usagePlan", "rate"], plan.Throttle === undefined ? 0 : num(plan.Throttle.RateLimit), "UsagePlan.Throttle.RateLimit")
  run.set(d, ["usagePlan", "burst"], num(plan.Throttle?.BurstLimit), "UsagePlan.Throttle.BurstLimit")
  run.set(d, ["usagePlan", "quota"], num(plan.Quota?.Limit), "UsagePlan.Quota.Limit")
  const period = asString(plan.Quota?.Period)?.toLowerCase()
  run.set(d, ["usagePlan", "period"], period, "UsagePlan.Quota.Period")
  if (clients !== undefined && clients > 0) run.set(d, ["usagePlan", "clients"], clients, "UsagePlanKey")
}

const usagePlan = (run: Run, r: Resource, ctx: { readonly resources: ReadonlyMap<string, Resource> }): void => {
  const apis = [...new Set(listOf(r.props.ApiStages).map((s) => apiOf(run, s.ApiId)).filter((d): d is Draft => d !== undefined))]
  if (apis.length === 0) {
    run.skip(r, "its API isn't in this template")
    return
  }
  // Every key attached to the plan is a client the API tells apart.
  const keys = [...ctx.resources.values()].filter((o) => o.type === "AWS::ApiGateway::UsagePlanKey" && referencesIn(o.props.UsagePlanId).includes(r.id)).length
  for (const d of apis) usagePlanSettings(run, d, r.props, keys)
  run.consumed(r, apis[0]!)
}

// ---------------------------------------------------------------------------------------------------------
// Methods, routes and integrations
// ---------------------------------------------------------------------------------------------------------

const isPreflight = (method: unknown): boolean => String(method).toUpperCase() === "OPTIONS"

/** One method or route is found: it counts as a route, and says how it is authorized. */
const countRoute = (
  d: Draft,
  how: { readonly authorization: unknown; readonly authorizerId: unknown; readonly integration: "mock" | "proxy" | undefined },
  ctx: { readonly resources: ReadonlyMap<string, Resource> }
): void => {
  const s = stateOf(d)
  s.routes++
  if (how.integration === "mock") s.mock++
  else if (how.integration === "proxy") s.proxied++
  switch (how.authorization) {
    case "AWS_IAM":
      s.iam = true
      s.authorized++
      break
    case "CUSTOM":
    case "COGNITO_USER_POOLS":
    case "JWT":
      s.authorized++
      if (!referencesIn(how.authorizerId).some((id) => ctx.resources.get(id)?.type.endsWith("::Authorizer") === true)) s.externalAuthorizer = true
      break
  }
}

/** `AWS::ApiGateway::Method`: the integration it calls, its timeout, and how it is authorized. */
const method = (run: Run, r: Resource, ctx: { readonly resources: ReadonlyMap<string, Resource> }): void => {
  const p = r.props
  const d = apiOf(run, p.RestApiId)
  if (d === undefined) return
  const integration = (p.Integration ?? {}) as Bag
  const targets = integrationTargets(run, integration.Uri, r.id)
  for (const to of targets) run.wire(d, "out", to, { origin: { source: SOURCE, ref: r.id } })
  if (targets.length === 0 && integration.Type === "AWS") run.warn(`${d.name} calls an AWS service directly (${asString(integration.Uri) ?? "service integration"}): that call isn't drawn.`)
  const timeout = asNumber(integration.TimeoutInMillis)
  if (timeout !== undefined) run.set(d, ["integrationTimeout"], millis(timeout), "TimeoutInMillis")
  // CDK adds a mock OPTIONS method for CORS to every resource; real traffic doesn't use it, so it is not a route.
  if (!isPreflight(p.HttpMethod)) countRoute(d, { authorization: p.AuthorizationType, authorizerId: p.AuthorizerId, integration: integration.Type === "MOCK" ? "mock" : "proxy" }, ctx)
  run.consumed(r, d)
}

/** `AWS::ApiGatewayV2::Integration`: where an HTTP API's route goes. */
const v2Integration = (run: Run, r: Resource): void => {
  const p = r.props
  const d = apiOf(run, p.ApiId)
  if (d === undefined) return
  for (const to of integrationTargets(run, p.IntegrationUri, r.id)) run.wire(d, "out", to, { origin: { source: SOURCE, ref: r.id } })
  const timeout = asNumber(p.TimeoutInMillis)
  if (timeout !== undefined) run.set(d, ["integrationTimeout"], millis(timeout), "TimeoutInMillis")
  // A route is mock or proxied by its integration; the integration is the one that says, so it is counted here.
  if (p.IntegrationType === "MOCK") stateOf(d).mock++
  else stateOf(d).proxied++
  run.consumed(r, d)
}

/** `AWS::ApiGatewayV2::Route`: counts as a route, and how it is authorized. */
const v2Route = (run: Run, r: Resource, ctx: { readonly resources: ReadonlyMap<string, Resource> }): void => {
  const p = r.props
  const d = apiOf(run, p.ApiId)
  if (d === undefined) return
  // The integration a route calls is counted with its own resource.
  countRoute(d, { authorization: p.AuthorizationType, authorizerId: p.AuthorizerId, integration: undefined }, ctx)
  run.consumed(r, d)
}

/** Routes in an inline OpenAPI document, and the integrations it names. */
const OPERATIONS = ["get", "put", "post", "delete", "patch", "head", "any", "x-amazon-apigateway-any-method"]
const body = (run: Run, d: Draft, value: unknown, ref: string): void => {
  for (const to of run.targets(value)) if (to.type !== "aws.apigateway") run.wire(d, "out", to, { origin: { source: SOURCE, ref } })
  const paths = value !== null && typeof value === "object" ? ((value as Bag).paths as Bag | undefined) : undefined
  if (paths !== undefined && typeof paths === "object") {
    for (const item of Object.values(paths)) if (item !== null && typeof item === "object") stateOf(d).bodyRoutes += Object.keys(item).filter((k) => OPERATIONS.includes(k.toLowerCase())).length
  }
}

/** `AWS::ApiGateway::Stage` and `AWS::ApiGatewayV2::Stage`: throttling, and for a REST stage the cache. */
const stage = (run: Run, r: Resource): void => {
  const p = r.props
  const d = apiOf(run, p.RestApiId ?? p.ApiId)
  if (d === undefined) return
  if (r.type === "AWS::ApiGatewayV2::Stage") throttle(run, d, p.DefaultRouteSettings)
  else {
    throttle(run, d, p.MethodSettings)
    stageCache(run, d, p)
  }
  run.consumed(r, d)
}

// ---------------------------------------------------------------------------------------------------------
// SAM events
// ---------------------------------------------------------------------------------------------------------

/** A function's `Api` or `HttpApi` event: a route on the API it names (or the one SAM makes), and how that route is authorized. */
export const apiEvent = (target: Draft, p: Bag): void => {
  const s = stateOf(target)
  s.routes++
  s.proxied++
  const choice = asString(p.Auth?.Authorizer)
  if (choice === "AWS_IAM") {
    s.iam = true
    s.authorized++
  } else if (choice === "NONE") {
    // This route opts out of whatever the API's default is.
  } else if (choice !== undefined) {
    const held = named.get(target)?.get(choice)
    if (held !== undefined) s.authorizers.set(choice, held)
    s.authorized++
  } else if (s.defaultAll) s.authorized++
}

// ---------------------------------------------------------------------------------------------------------
// Putting what was learned onto the API
// ---------------------------------------------------------------------------------------------------------

/** The settings that no single resource decides: the number of routes, mock integrations, and the authorizer. */
const finish = (run: Run, d: Draft): void => {
  const s = stateOf(d)
  const routes = s.routes > 0 ? s.routes : s.bodyRoutes
  if (routes > 1) run.set(d, ["routes"], routes, "the methods and routes of the API")

  // Mock answers at the gateway; the component does that for every request or for none.
  if (s.mock > 0 && s.proxied === 0) run.set(d, ["integrationType"], "mock", "Integration.Type")
  else if (s.mock > 0) run.warn(`${d.name}: ${s.mock} of ${s.mock + s.proxied} routes are MOCK integrations, but the component answers at the gateway for all calls or none, so it calls the integrations.`)

  const authorizers = [...s.authorizers.values()]
  const first = authorizers[0]
  if (first !== undefined) {
    run.set(d, ["authorizer", "type"], first.type, "Authorizer.Type")
    if (first.ttl !== undefined) run.set(d, ["authorizer", "ttl"], `${first.ttl} seconds`, "AuthorizerResultTtlInSeconds")
    const checker = first.fn()
    if (checker !== undefined) run.wire(d, "authorizer", checker, { name: "Authorizer", origin: { source: SOURCE, ref: "Authorizer" } })
    if (new Set(authorizers.map((a) => a.type)).size > 1 || new Set(authorizers.filter((a) => a.type === "lambda").map((a) => a.fn())).size > 1) {
      run.warn(`${d.name} has authorizers of different kinds or functions, but the component has one authorizer for the whole API; it uses the first (${first.type}).`)
    }
    if (s.iam) run.warn(`${d.name} uses both an authorizer and IAM authorization on different routes; the component has one authorizer for the whole API, so it uses the ${first.type} one.`)
  } else if (s.iam) run.set(d, ["authorizer", "type"], "iam", "AuthorizationType")
  if ((first !== undefined || s.iam) && routes > 0 && s.authorized < routes) {
    run.warn(`${d.name}: ${s.authorized} of ${routes} routes are authorized, but the component applies its authorizer to every call.`)
  }
  if (s.externalAuthorizer) run.warn(`${d.name}: a method names an authorizer that isn't in this template, so its type isn't known.`)
}

// ---------------------------------------------------------------------------------------------------------
// Handlers by resource type
// ---------------------------------------------------------------------------------------------------------

export const apiWiring: Record<string, (run: Run, r: Resource, ctx: { readonly resources: ReadonlyMap<string, Resource> }) => void> = {
  "AWS::ApiGatewayV2::Integration": v2Integration,
  "AWS::ApiGatewayV2::Route": v2Route,
  "AWS::ApiGateway::Method": method,
  "AWS::ApiGateway::Authorizer": authorizer,
  "AWS::ApiGatewayV2::Authorizer": authorizer,
  "AWS::ApiGateway::UsagePlan": usagePlan,
  "AWS::ApiGatewayV2::Stage": stage,
  "AWS::ApiGateway::Stage": stage,
  // An API defined by an inline OpenAPI document names its integrations in `x-amazon-apigateway-integration`.
  "AWS::ApiGateway::RestApi": (run, r) => {
    const d = run.drafts.get(r.id)
    if (d !== undefined) body(run, d, r.props.Body, "Body")
  },
  "AWS::ApiGatewayV2::Api": (run, r) => {
    const d = run.drafts.get(r.id)
    if (d !== undefined) body(run, d, r.props.Body ?? r.props.Target, "Body")
  },
  "AWS::Serverless::Api": (run, r) => {
    const d = run.drafts.get(r.id)
    if (d !== undefined) body(run, d, r.props.DefinitionBody, "DefinitionBody")
  },
  "AWS::Serverless::HttpApi": (run, r) => {
    const d = run.drafts.get(r.id)
    if (d !== undefined) body(run, d, r.props.DefinitionBody, "DefinitionBody")
  }
}

/** The implicit API SAM makes for function events that name none. */
export const implicitApi = (run: Run, kind: "rest" | "http", cache: Map<"rest" | "http", Draft>): Draft => {
  let d = cache.get(kind)
  if (d === undefined) {
    d = run.draft(`implicit:${kind}`, kind === "http" ? "ServerlessHttpApi" : "ServerlessRestApi", "aws.apigateway", { source: SOURCE, ref: kind === "http" ? "ServerlessHttpApi" : "ServerlessRestApi" })
    run.set(d, ["apiType"], kind, "implicit API")
    cache.set(kind, d)
    run.added.push(`The ${kind === "http" ? "HTTP" : "REST"} API that SAM creates from your function's API events.`)
    run.later(() => finish(run, d!))
  }
  return d
}

export { apiOf }
