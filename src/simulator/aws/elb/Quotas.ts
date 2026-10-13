import * as Setting from "../../Setting.ts"
import { URL } from "./internal/config.ts"

/**
 * The account-level quotas Elastic Load Balancing contributes, per Region (Quotas for your Application Load Balancers,
 * Quotas for your Network Load Balancers). Each is adjustable; the defaults are AWS's, the same in every Region.
 */
export const quotas = (_region: string) => ({
  elbApplicationLoadBalancers: Setting.int({
    default: 50,
    min: 0,
    max: 100_000,
    unit: "load balancers",
    label: "Application Load Balancers",
    help: "Application Load Balancers the account may have in this Region.",
    limit: Setting.quota(URL.albQuotas)
  }),
  elbNetworkLoadBalancers: Setting.int({
    default: 50,
    min: 0,
    max: 100_000,
    unit: "load balancers",
    label: "Network Load Balancers",
    help: "Network Load Balancers the account may have in this Region.",
    limit: Setting.quota(URL.nlbQuotas)
  }),
  elbReservedAlbLcus: Setting.int({
    default: 0,
    min: 0,
    max: 10_000_000,
    unit: "LCU",
    label: "Reserved ALB capacity units",
    help: "LCUs the Application Load Balancers in this Region may reserve between them. 0 by default: ask AWS to raise it before reserving capacity for an event.",
    limit: Setting.quota(URL.albQuotas, "0 by default; adjustable.")
  })
})
