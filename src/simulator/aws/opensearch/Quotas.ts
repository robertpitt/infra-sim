import * as Setting from "../../Setting.ts"

const SERVICE_QUOTAS = "https://docs.aws.amazon.com/general/latest/gr/opensearch-service.html"

/**
 * The account-level quotas this service contributes, for one region. AWS publishes the same defaults in every supported
 * region ("Each supported Region: 500", "... 200"), so `region` doesn't change them. Merged into the provider's account
 * form by `../account.ts`; checked by `audit.ts`.
 */
export const quotas = (_region: string) => ({
  opensearchDomains: Setting.int({
    default: 500,
    min: 1,
    max: 100_000,
    unit: "domains",
    label: "OpenSearch domains per region",
    limit: Setting.quota(SERVICE_QUOTAS)
  }),
  opensearchInstancesPerDomain: Setting.int({
    default: 200,
    min: 1,
    max: 1_002,
    unit: "instances",
    label: "OpenSearch instances per domain",
    help: "AWS raises it to at most 1,002 (T2 and T3 domains stay at 10). The developer guide lists 80 as the default for most instance families; this is the Service Quotas default from the General Reference.",
    limit: Setting.quota(SERVICE_QUOTAS)
  })
})
