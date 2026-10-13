import * as Setting from "../../Setting.ts"
import { SERVICE_QUOTAS_URL } from "./internal/config.ts"

/** Web ACLs an account may have per Region, regional and CloudFront alike (quota, adjustable). */
export const DEFAULT_WEB_ACLS = 100

/**
 * The account-level quotas AWS WAF contributes. AWS counts regional web ACLs and CloudFront web ACLs separately; the
 * CloudFront ones all live in us-east-1 ("Global (CloudFront)"), so that quota only ever applies there.
 */
export const quotas = (_region: string) => ({
  wafWebAcls: Setting.int({
    default: DEFAULT_WEB_ACLS,
    min: 1,
    max: 100_000,
    label: "WAF web ACLs (regional)",
    help: "Regional web ACLs (for ALBs, API Gateway, AppSync, Cognito, App Runner, Verified Access) the account may have in this Region.",
    limit: Setting.quota(SERVICE_QUOTAS_URL)
  }),
  wafCloudFrontWebAcls: Setting.int({
    default: DEFAULT_WEB_ACLS,
    min: 1,
    max: 100_000,
    label: "WAF web ACLs (CloudFront)",
    help: "Web ACLs for CloudFront distributions the account may have. They are global and created in us-east-1, so this counts only there.",
    limit: Setting.quota(SERVICE_QUOTAS_URL)
  })
})
