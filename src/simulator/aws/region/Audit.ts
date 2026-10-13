import type { Diagnostic } from "../../Diagnostic.ts"
import type { Audit } from "../internal/service.ts"
import { infoOf } from "./Catalog.ts"

/**
 * Notes about the Region itself rather than a quota: that an opt-in Region has to be enabled in the account first, and
 * that two boxes for one Region are redundant (they share one set of account quotas). Run by the VPC audit, because
 * `../provider.ts` lists audits per service and Region and VPC share one folder pair.
 */
export const audit: Audit = (regionId, members) => {
  const out: Array<Diagnostic> = []
  const info = infoOf(regionId)
  if (info?.optIn === true && members.length > 0) {
    out.push({
      level: "info",
      code: "region-opt-in",
      message: `${info.name} (${regionId}) is disabled by default: the account has to enable it before anything can run there.`
    })
  }
  const boxes = members.filter((m) => m.type === "aws.region")
  if (boxes.length > 1) {
    out.push({
      level: "warning",
      code: "region-duplicate-box",
      node: boxes[1]!.id,
      message: `${boxes.length} Region boxes for ${regionId}: they are one account's quotas, so one box is enough.`
    })
  }
  return out
}
