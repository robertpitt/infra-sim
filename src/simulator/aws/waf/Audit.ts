import type { Diagnostic } from "../../Diagnostic.ts"
import type { Account } from "../internal/account.ts"
import { type Audit, fmt } from "../internal/service.ts"
import { capacityOf, hasContentRules } from "./internal/capacity.ts"
import { BODY_LIMITS_KB, DEFAULT_REQUEST_RATE, hasFixedBodyLimit, isGlobal, MAX_WCU, PRICED_WCU, type Settings, WCU_URL } from "./internal/config.ts"

/** Where AWS keeps every CloudFront web ACL ("Global (CloudFront)" is us-east-1). */
const GLOBAL_REGION = "us-east-1"

/**
 * What the web ACLs in a placement ask of AWS WAF: capacity over the 5,000 WCUs AWS allows (the web ACL cannot be
 * created) or over the 1,500 the base price includes, more web ACLs than the account may have, a CloudFront web ACL placed
 * outside us-east-1, and settings that have no effect on the resource the web ACL protects.
 *
 * It cannot check what the web ACL is in front of (audits see nodes, not edges): that a CloudFront web ACL really fronts
 * a distribution, or that a regional one is in the same Region as its resource.
 */
export const audit: Audit = (region, members, quotas) => {
  const account = quotas as Partial<Account>
  const out: Array<Diagnostic> = []
  const acls = members.filter((m) => m.type === "aws.waf")
  const say = (level: Diagnostic["level"], m: { readonly id: string; readonly name: string }, code: string, message: string): void => {
    out.push({ level, code, message: `${m.name}: ${message}`, node: m.id })
  }
  let regional = 0
  let global = 0
  for (const m of acls) {
    const c = m.config as Settings
    const wcu = capacityOf(c).total
    if (wcu > MAX_WCU) {
      say("error", m, "waf-capacity-exceeded", `its rules need ${fmt(wcu)} WCUs and a web ACL may use at most ${fmt(MAX_WCU)}; AWS WAF refuses to create it (${WCU_URL}). Drop a rule group or trim your own rules.`)
    } else if (wcu > PRICED_WCU) {
      say("info", m, "waf-capacity-priced", `its rules use ${fmt(wcu)} WCUs; the base price includes ${fmt(PRICED_WCU)} and each tier above costs more.`)
    }
    if (isGlobal(c.protects)) {
      global++
      if (region !== GLOBAL_REGION) {
        say("warning", m, "waf-cloudfront-region", `a web ACL for CloudFront is global and lives in ${GLOBAL_REGION}, not ${region}. Leave it outside region boxes, as CloudFront is.`)
      }
      if (c.requestRate !== DEFAULT_REQUEST_RATE) {
        say("info", m, "waf-request-rate-cloudfront", "the request quota is applied to regional web ACLs only; for CloudFront, CloudFront sets the limit.")
      }
    } else regional++
    if (hasFixedBodyLimit(c.protects) && c.body.inspectionLimit !== BODY_LIMITS_KB[0]) {
      say("warning", m, "waf-body-limit-fixed", `AWS WAF inspects at most the first 8 KB of a body for ${c.protects === "alb" ? "an Application Load Balancer" : "an AppSync API"}; the ${c.body.inspectionLimit} KB setting is ignored.`)
    }
    if (c.failOpen && c.protects !== "alb") {
      say("warning", m, "waf-fail-open-alb", "fail-open is an Application Load Balancer attribute; it is ignored for anything else.")
    }
    const wantsMatches = c.rules.match > 0 || c.traffic.attackSources.trim().length > 0
    if (wantsMatches && !hasContentRules(c)) {
      say("warning", m, "waf-no-rules", "rules are set to match some traffic, but the web ACL has no rule groups or rules of your own, so nothing matches. Turn on a managed rule group or give your own rules some capacity.")
    }
  }
  const regionalQuota = account.wafWebAcls
  if (regionalQuota !== undefined && regional > regionalQuota) {
    out.push({ level: "error", code: "waf-web-acls-exceeded", message: `${fmt(regional)} regional web ACLs in ${region}, and the account may have ${fmt(regionalQuota)}. Share one web ACL between resources, or raise the quota.` })
  }
  const globalQuota = account.wafCloudFrontWebAcls
  if (globalQuota !== undefined && global > globalQuota) {
    out.push({ level: "error", code: "waf-cloudfront-web-acls-exceeded", message: `${fmt(global)} CloudFront web ACLs, and the account may have ${fmt(globalQuota)}. Share one web ACL between distributions, or raise the quota.` })
  }
  return out
}
