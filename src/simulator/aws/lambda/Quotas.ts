import * as Setting from "../../Setting.ts"
import { D } from "./internal/limits.ts"

/**
 * The account-level quotas this service contributes: limits that belong to an AWS account in a region rather than to
 * one resource, and that every resource of the service in that region shares. Each is an editable setting whose default
 * is AWS's published number for that region. They are merged into the provider's account form (`../account.ts`).
 *
 * Lambda publishes one default for every Region (`gettingstarted-limits.html`: 1,000 concurrent executions), so `region`
 * changes nothing here. New AWS accounts start lower and AWS raises them automatically with usage; that is an account
 * state, not a Region, so it is for the user to set (the minimum here is 10).
 */
export const quotas = (_region: string) => ({
  lambdaConcurrency: Setting.int({
    default: 1_000,
    min: 10,
    max: 1_000_000,
    unit: "executions",
    label: "Lambda concurrent executions",
    help: "Shared by every function in this region. At least 100 always stays unreserved, and each unit allows 10 synchronous requests a second.",
    limit: Setting.quota(`${D}gettingstarted-limits.html`, "AWS can raise this to tens of thousands on request. New accounts start with a lower value.")
  })
})
