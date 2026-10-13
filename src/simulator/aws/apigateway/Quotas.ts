import * as Setting from "../../Setting.ts"
import { docs } from "../internal/docs.ts"
import { fmt } from "../internal/service.ts"

/** The page that lists the account-level quotas (throttle rate and burst, with the regions that differ). */
const LIMITS = `${docs.apigateway}limits.html`
/** The General Reference page, which is the Service Quotas data and lists the regions per quota. */
export const SERVICE_QUOTAS = "https://docs.aws.amazon.com/general/latest/gr/apigateway.html"

/**
 * Regions where the account throttle defaults to 2,500 rps with a 1,250 burst instead of 10,000 / 5,000.
 *
 * Two AWS pages list them and they disagree. The developer-guide quotas page (`limits.html`) names Cape Town, Milan,
 * Jakarta, UAE, Hyderabad, Melbourne, Spain, Zurich, Tel Aviv, Calgary, Malaysia, Thailand and Mexico Central. The
 * General Reference quotas page (Service Quotas) names the same minus the UAE, plus Taipei (`ap-east-2`) and New Zealand
 * (`ap-southeast-6`). The simulator uses the union: a region is reduced if either page says so, so the UAE keeps its
 * reduced default and the two newest regions get theirs.
 */
const apiGatewayReduced = new Set([
  "af-south-1", "eu-south-1", "ap-southeast-3", "me-central-1", "ap-south-2", "ap-southeast-4", "eu-south-2",
  "eu-central-2", "il-central-1", "ca-west-1", "ap-southeast-5", "ap-southeast-7", "mx-central-1", "ap-east-2", "ap-southeast-6"
])

/** The account's steady-state request rate in a region (quota: AWS raises it on request). */
export const apiGatewayRate = (region: string): number => (apiGatewayReduced.has(region) ? 2_500 : 10_000)
/** The token-bucket size: AWS says the service team decides it and a customer cannot change it. */
export const apiGatewayBurst = (region: string): number => (apiGatewayReduced.has(region) ? 1_250 : 5_000)

/** The default for the maximum REST API integration timeout: 29 s, in every region. */
export const DEFAULT_MAX_INTEGRATION_TIMEOUT_MS = 29_000

/**
 * The account-level quotas this service contributes: limits that belong to an AWS account in a region rather than to
 * one resource, and that every resource of the service in that region shares. Each is an editable setting whose default
 * is AWS's published number for that region. They are merged into the provider's account form (`../account.ts`).
 */
export const quotas = (region: string) => ({
  apiGatewayRate: Setting.int({
    default: apiGatewayRate(region),
    min: 1,
    max: 10_000_000,
    unit: "req/s",
    label: "API Gateway request rate",
    help: `Steady-state rate shared by every API in this region, REST, HTTP and WebSocket alike. The burst (${fmt(apiGatewayBurst(region))}) is fixed by AWS.`,
    limit: Setting.quota(LIMITS, "AWS can raise it on request; the burst (bucket size) is decided by the service team and cannot be requested.")
  }),
  apiGatewayIntegrationTimeout: Setting.duration({
    default: DEFAULT_MAX_INTEGRATION_TIMEOUT_MS,
    min: "29 seconds",
    max: "5 minutes",
    label: "API Gateway maximum integration timeout",
    help:
      "The longest integration timeout a REST API may be given. AWS raises it for Regional and private REST APIs only (edge-optimized APIs stay at 29 s, HTTP APIs at 30 s), and says a raise may cost some of the regional throttle quota. The 5 minute ceiling here is an assumption: AWS publishes no upper bound.",
    limit: Setting.quota(`${docs.apigateway}api-gateway-execution-service-limits-table.html`, "Adjustable through Service Quotas for Regional and private REST APIs.")
  })
})
