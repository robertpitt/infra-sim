import { Duration } from "effect"
import type { Diagnostic } from "../../Diagnostic.ts"
import type { Account } from "../internal/account.ts"
import { type Audit, fmt } from "../internal/service.ts"
import { MAX_CACHED_RESPONSE_BYTES, type Settings } from "./internal/config.ts"
import { timeoutCapMs } from "./internal/plan.ts"
import { apiGatewayBurst, DEFAULT_MAX_INTEGRATION_TIMEOUT_MS } from "./Quotas.ts"

/**
 * What the APIs in a region ask of the account, against the account's quotas and against what API Gateway allows: limits
 * set above the account's (which cannot exceed it), timeouts above what the API type permits, and settings that have no
 * effect on the API type they are set on.
 */
export const audit: Audit = (region, members, quotas) => {
  const account = quotas as Account
  const out: Array<Diagnostic> = []
  const gateways = members.filter((m) => m.type === "aws.apigateway")
  const warn = (node: { readonly id: string; readonly name: string }, code: string, message: string): void => {
    out.push({ level: "warning", code, message: `${node.name}: ${message}`, node: node.id })
  }
  const burst = apiGatewayBurst(region)
  for (const m of gateways) {
    const c = m.config as Settings
    const rest = c.apiType === "rest"
    if (c.stageThrottle.rate > account.apiGatewayRate) {
      warn(m, "apigateway-stage-above-account", `the stage limit of ${fmt(c.stageThrottle.rate)} requests/s is above the account's ${fmt(account.apiGatewayRate)} in ${region}; stage limits cannot exceed the account's, so the account limit applies.`)
    }
    if (c.stageThrottle.burst > burst) {
      warn(m, "apigateway-burst-above-account", `the stage burst of ${fmt(c.stageThrottle.burst)} is above the account's ${fmt(burst)} in ${region}; the account bucket runs out first.`)
    }
    if (rest && c.usagePlan.enabled && c.usagePlan.rate > account.apiGatewayRate) {
      warn(m, "apigateway-plan-above-account", `the usage plan rate of ${fmt(c.usagePlan.rate)} requests/s per client is above the account's ${fmt(account.apiGatewayRate)}; per-client limits cannot exceed the account's.`)
    }
    const cap = timeoutCapMs(c, account)
    if (Duration.toMillis(c.integrationTimeout) > cap) {
      const why = !rest
        ? "HTTP APIs wait at most 30 s"
        : c.endpoint === "edge"
        ? "edge-optimized REST APIs wait at most 29 s"
        : `the account's maximum REST integration timeout is ${cap / 1000} s (raise it in the account quotas)`
      warn(m, "apigateway-timeout-capped", `the integration timeout of ${Duration.toMillis(c.integrationTimeout) / 1000} s is longer than API Gateway allows: ${why}, so ${cap / 1000} s applies.`)
    }
    if (!rest && c.usagePlan.enabled) warn(m, "apigateway-usage-plan-http", "usage plans and API keys exist only for REST APIs; this HTTP API ignores them.")
    if (!rest && c.cache.enabled) warn(m, "apigateway-cache-http", "the response cache exists only for REST APIs; this HTTP API ignores it.")
    if (rest && c.cache.enabled && c.cache.responseSize * 1024 > MAX_CACHED_RESPONSE_BYTES) {
      warn(m, "apigateway-cache-response-size", "responses over 1,048,576 bytes are never cached, so the cache will not hit.")
    }
    if (c.authorizer.type === "jwt" && rest) warn(m, "apigateway-jwt-rest", "JWT authorizers exist only for HTTP APIs; a REST API uses a Cognito user pool or a Lambda authorizer. It is simulated as a JWT check anyway.")
    if (c.authorizer.type === "cognito" && !rest) warn(m, "apigateway-cognito-http", "Cognito user pool authorizers exist only for REST APIs; an HTTP API uses a JWT authorizer. It is simulated as a JWT-style check anyway.")
  }
  // A raised timeout costs regional throttle (AWS: "might require a reduction in your Region-level throttle quota").
  if (gateways.length > 0 && Duration.toMillis(account.apiGatewayIntegrationTimeout) > DEFAULT_MAX_INTEGRATION_TIMEOUT_MS) {
    out.push({
      level: "info",
      code: "apigateway-timeout-quota-raised",
      message: `API Gateway in ${region} has its maximum integration timeout raised above 29 s. AWS says that can require a lower regional throttle quota (the account rate is ${fmt(account.apiGatewayRate)} requests/s here).`
    })
  }
  return out
}
