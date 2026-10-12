import type { Diagnostic } from "../../Diagnostic.ts"
import type { Account } from "../account.ts"
import type { Audit } from "../service.ts"
import type { AlbSettings } from "./albConfig.ts"
import { reservedLcu } from "./capacity.ts"
import { MIN_RESERVED_LCU } from "./config.ts"

/**
 * What the load balancers in a Region ask of the account: more of them than its quotas allow, and LCU reservations
 * past the Region's reserved-capacity quota (0 until AWS raises it) or under the 100-LCU minimum.
 */
export const audit: Audit = (region, members, quotas) => {
  const account = quotas as Account
  const out: Array<Diagnostic> = []
  const albs = members.filter((m) => m.type === "aws.alb")
  const nlbs = members.filter((m) => m.type === "aws.nlb")
  if (albs.length > account.elbApplicationLoadBalancers) {
    out.push({ level: "warning", code: "elb-alb-quota", message: `${albs.length} Application Load Balancers in ${region}, past the account's ${account.elbApplicationLoadBalancers}: AWS refuses to create more until the quota is raised.` })
  }
  if (nlbs.length > account.elbNetworkLoadBalancers) {
    out.push({ level: "warning", code: "elb-nlb-quota", message: `${nlbs.length} Network Load Balancers in ${region}, past the account's ${account.elbNetworkLoadBalancers}: AWS refuses to create more until the quota is raised.` })
  }
  let reserved = 0
  for (const m of albs) {
    const asked = (m.config as AlbSettings).capacity.reserved
    if (asked > 0 && asked < MIN_RESERVED_LCU) {
      out.push({ level: "warning", code: "elb-reservation-minimum", node: m.id, message: `${m.name}: an LCU reservation is at least ${MIN_RESERVED_LCU} LCUs; ${asked} is treated as ${MIN_RESERVED_LCU}.` })
    }
    reserved += reservedLcu(asked)
  }
  if (reserved > account.elbReservedAlbLcus) {
    out.push({
      level: "warning",
      code: "elb-reservation-quota",
      message: `The Application Load Balancers in ${region} reserve ${reserved.toLocaleString("en-US")} LCUs, past the Region's reserved-LCU quota of ${account.elbReservedAlbLcus.toLocaleString("en-US")} (0 unless AWS has raised it). The simulator applies the reservations; AWS would refuse them until the quota is raised.`
    })
  }
  return out
}
