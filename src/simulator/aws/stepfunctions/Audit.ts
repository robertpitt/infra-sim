import { Duration } from "effect"
import type { Diagnostic } from "../../Diagnostic.ts"
import type { Audit } from "../internal/service.ts"
import type { Settings } from "./internal/config.ts"
import { EXPRESS_MAX_DURATION_MS } from "./internal/limits.ts"

/**
 * Static checks of a region's state machines: settings that can't do what they say for the workflow type chosen. Pure
 * and cheap: it reads decoded settings and nothing else. Audits see nodes, not edges, so nothing here can look at the
 * states themselves (a Distributed Map in an Express workflow, say); see README.md.
 */
export const audit: Audit = (_region, members) => {
  const out: Array<Diagnostic> = []
  const machines = members.filter((m) => m.type === "aws.stepfunctions")
  for (const m of machines) {
    const c = m.config as Settings
    const timeout = Duration.toMillis(c.timeout)
    if (c.workflowType === "express" && timeout > EXPRESS_MAX_DURATION_MS) {
      out.push({
        level: "warning",
        code: "stepfunctions-express-timeout",
        node: m.id,
        message: `${m.name} is an Express workflow with a ${Duration.format(c.timeout)} timeout, but Express executions stop at five minutes: the timeout never applies.`
      })
    }
    if (c.workflowType === "standard" && c.duplicateRate > 0) {
      out.push({
        level: "info",
        code: "stepfunctions-standard-duplicates",
        node: m.id,
        message: `${m.name} is a Standard workflow, which runs each execution exactly once: its duplicate rate applies only to asynchronous Express executions and is ignored.`
      })
    }
  }
  return out
}
