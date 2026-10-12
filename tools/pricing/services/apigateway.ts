import type { ServiceMap } from "../map.ts"

/**
 * API Gateway: requests to REST and HTTP APIs, each tiered by the month's requests, and a REST stage's cache cluster by
 * the hour by its size.
 * https://aws.amazon.com/api-gateway/pricing/
 *
 * Usage types (after the region prefix): `ApiGatewayRequest` (REST, four tiers from 333 million), `ApiGatewayHttpRequest`
 * (HTTP, two tiers from 300 million), `ApiGatewayCacheUsage:<size>GB` (one per cache size). AWS names two cache sizes
 * by their exact capacity (`1.55GB`, `6.05GB`) where the API and the simulator's `cache.size` say 1.6 and 6.1.
 * Left out: WebSocket APIs (messages and connection minutes; the simulator does not model them), developer portals, and
 * the 12-month free tier (AWS lists no free row for it).
 */

/** AWS's cache size in the usage type, to the `cacheClusterSize` the simulator's `cache.size` uses. */
const CACHE_SIZES: Readonly<Record<string, string>> = {
  "0.5": "0.5",
  "1.55": "1.6",
  "6.05": "6.1",
  "13.5": "13.5",
  "28.4": "28.4",
  "58.2": "58.2",
  "118": "118",
  "237": "237"
}

export const apigateway: ServiceMap = {
  id: "apigateway",
  title: "Amazon API Gateway",
  offers: ["AmazonApiGateway"],
  dimensions: {
    "requests/rest": {
      unit: "request",
      description: "REST API requests, tiered by the month's requests"
    },
    "requests/http": {
      unit: "request",
      description: "HTTP API requests, tiered by the month's requests"
    },
    ...Object.fromEntries(
      Object.values(CACHE_SIZES).map((size) => [
        `cache/${size}`,
        { unit: "hour", description: `REST stage cache cluster of ${size} GB, while it is provisioned` }
      ])
    )
  },
  classify: (row) => {
    if (row.usage === "ApiGatewayRequest") return { dimension: "requests/rest" }
    if (row.usage === "ApiGatewayHttpRequest") return { dimension: "requests/http" }
    const cache = /^ApiGatewayCacheUsage:([\d.]+)GB$/.exec(row.usage)
    const size = cache === null ? undefined : CACHE_SIZES[cache[1]!]
    return size === undefined ? undefined : { dimension: `cache/${size}` }
  }
}
