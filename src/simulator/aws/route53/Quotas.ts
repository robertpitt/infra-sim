import * as Setting from "../../Setting.ts"
import { QUOTAS_URL } from "./internal/config.ts"

/**
 * The account-level quotas Route 53 contributes. Route 53 is a global service and its quotas belong to the account, not
 * to a region; the simulator keeps account quotas per placement, so each placement gets AWS's one number and the
 * records placed there share it.
 */
export const quotas = (_region: string) => ({
  route53HealthChecks: Setting.int({
    default: 200,
    min: 0,
    max: 1_000_000,
    unit: "health checks",
    label: "Route 53 active health checks",
    help: "Health checks the account may have. AWS refuses to create one past it, so a record that asks for one when none are left has no health check and is always treated as healthy.",
    limit: Setting.quota(QUOTAS_URL)
  })
})
