import { MANAGED_GROUP_IDS, MANAGED_GROUPS, METHOD_MATCH_WCU, RATE_RULE_WCU, type Settings, SIZE_CONSTRAINT_WCU } from "./config.ts"

/** What a web ACL's rules cost in web ACL capacity units, by part. */
export interface Capacity {
  /** The managed rule groups: each costs its published capacity, whatever rules inside are overridden. */
  readonly managed: number
  /** The rate-based rule: 2, plus 2 for a scope-down on the method. */
  readonly rateRule: number
  /** The size constraint rule that blocks oversized bodies: 1. */
  readonly oversize: number
  /** Your own rules, as you size them. */
  readonly custom: number
  readonly total: number
}

/**
 * The capacity a web ACL with these settings uses. AWS may charge less than the sum when rules share work (one text
 * transformation applied once for two rules), and never more; the sum is the ceiling a design is checked against.
 */
export const capacityOf = (c: Settings): Capacity => {
  let managed = 0
  for (const id of MANAGED_GROUP_IDS) if (c.managed[id]) managed += MANAGED_GROUPS[id].wcu
  const rateRule = c.rateRule.enabled ? RATE_RULE_WCU + (c.rateRule.scope === "all" ? 0 : METHOD_MATCH_WCU) : 0
  const oversize = c.body.blockOversize ? SIZE_CONSTRAINT_WCU : 0
  const custom = c.rules.customWcu
  return { managed, rateRule, oversize, custom, total: managed + rateRule + oversize + custom }
}

/** Whether the web ACL has any rule that inspects content: a managed group or one of your own. */
export const hasContentRules = (c: Settings): boolean => {
  if (c.rules.customWcu > 0) return true
  for (const id of MANAGED_GROUP_IDS) if (c.managed[id]) return true
  return false
}
