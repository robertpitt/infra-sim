import { referencesIn } from "../../Intrinsics.ts"
import { type Bag, type Draft, type Resource, type Run, type TemplateContext } from "./model.ts"
import { SAM_SENDING_POLICIES, sendsMail, sesNode } from "./ses.ts"

/**
 * The wiring a template implies. Functions reach the queues, topics, tables, buckets and mail they use through
 * environment variables and permissions, not through anything that looks like an edge. Both name the resource, so
 * naming it is taken as using it.
 */

const READ_ONLY = /^(?:[a-z0-9]+:)?(?:Get|List|Describe|Query|Scan|BatchGet|Head|Read)/i

export const inferred = (run: Run, ctx: TemplateContext): void => {
  const warnedRoles = new Set<string>()
  const usable = new Set(["aws.sqs", "aws.sns", "aws.dynamodb", "aws.s3", "aws.lambda", "aws.ses"])
  // Whether each function that sends mail does so only in bulk, per SES node, so the node's `call` can follow.
  const senders = new Map<Draft, Array<boolean>>()

  const inferFor = (r: Resource, from: Draft): void => {
    const used = new Map<Draft, { readOnly: boolean; why: string }>()
    const note = (to: Draft, readOnly: boolean, why: string): void => {
      if (to === from || !usable.has(to.type)) return
      const seen = used.get(to)
      used.set(to, { readOnly: (seen?.readOnly ?? true) && readOnly, why: seen?.why ?? why })
    }
    // Whether this function is allowed to send mail, and whether every way it may is the bulk API.
    let sends = false
    let bulkOnly = true
    const mail = (sendsHere: boolean, bulk: boolean): void => {
      if (!sendsHere) return
      sends = true
      bulkOnly = bulkOnly && bulk
    }

    for (const to of run.targets(r.props.Environment?.Variables)) note(to, false, "an environment variable")
    // SAM policy templates: `{ DynamoDBReadPolicy: { TableName: !Ref Table } }`.
    for (const policy of Array.isArray(r.props.Policies) ? r.props.Policies : []) {
      if (typeof policy !== "object" || policy === null) continue
      for (const [name, args] of Object.entries(policy as Bag)) {
        if (name === "Statement" || name === "Version") continue
        const sam = SAM_SENDING_POLICIES[name]
        if (sam !== undefined) mail(true, sam.bulk)
        for (const to of run.targets(args)) note(to, /Read|Poller|Describe/.test(name) && !/Write|Crud|Put|Send/.test(name), `the ${name} policy`)
      }
    }
    // Policy documents, inline or on the function's role.
    const documents: Array<Bag> = []
    const collect = (policies: unknown) => {
      for (const p of Array.isArray(policies) ? policies : []) {
        if (p?.Statement !== undefined) documents.push(p)
        else if (p?.PolicyDocument !== undefined) documents.push(p.PolicyDocument)
      }
    }
    collect(r.props.Policies)
    // A role shared by several functions says what any of them may do, not what each does: don't guess from it.
    const roleId = referencesIn(r.props.Role)[0]
    const role = roleId === undefined ? undefined : ctx.resources.get(roleId)
    if (role?.type === "AWS::IAM::Role") {
      const sharedBy = [...ctx.resources.values()].filter((o) => run.drafts.get(o.id)?.type === "aws.lambda" && referencesIn(o.props.Role).includes(role.id)).length
      if (sharedBy > 1) {
        if (!warnedRoles.has(role.id)) run.warn(`${role.id} is shared by ${sharedBy} functions, so what it permits isn't taken to mean any one of them uses it. Environment variables and each function's own policies are.`)
        warnedRoles.add(role.id)
      } else collect(role.props.Policies)
    }
    for (const doc of documents) {
      for (const statement of Array.isArray(doc?.Statement) ? doc.Statement : doc?.Statement === undefined ? [] : [doc.Statement]) {
        if (statement.Effect === "Deny") continue
        const actions: ReadonlyArray<string> = (Array.isArray(statement.Action) ? statement.Action : [statement.Action]).filter((a: unknown): a is string => typeof a === "string")
        const readOnly = actions.length > 0 && actions.every((a) => READ_ONLY.test(a))
        const send = sendsMail(actions)
        mail(send.sends, send.bulk)
        for (const to of run.targets(statement.Resource)) note(to, readOnly, "its permissions")
      }
    }

    if (sends) {
      // Naming a configuration set (an environment variable, a resource in a policy) says which; permission alone says only that it sends mail.
      const named = [...used.keys()].find((d) => d.type === "aws.ses")
      const ses = named ?? sesNode(run, from)
      if (ses !== undefined) {
        if (named === undefined) note(ses, false, "its ses:SendEmail permission")
        senders.set(ses, [...(senders.get(ses) ?? []), bulkOnly])
      }
    }

    for (const [to, { readOnly, why }] of used) {
      // A function that is triggered by a resource, and also has access to it, is the ordinary case (read the object
      // that was uploaded, delete the message that was received). Drawing that back would be a loop that isn't there.
      if (run.wires.some((w) => w.from === to && w.to === from)) continue
      run.wire(from, "out", to, {
        declared: false,
        settings: to.type === "aws.dynamodb" || to.type === "aws.s3" ? { request: { operation: readOnly ? "read" : "write" } } : {},
        origin: { source: "inferred", ref: why }
      })
    }
  }
  for (const r of ctx.resources.values()) {
    const from = run.drafts.get(r.id)
    if (from?.type === "aws.lambda") run.guard(`What ${from.name} uses`, () => inferFor(r, from))
  }

  // SendBulkEmail sends one message per recipient. The node has one `call` for everything that goes through it.
  for (const [ses, bulk] of senders) {
    if (bulk.every(Boolean)) run.set(ses, ["call"], "bulk", "ses:SendBulkEmail")
    else if (bulk.some(Boolean)) run.warn(`${ses.name} is sent through both with the bulk API and without it, but the component has one call type; it keeps send.`)
  }
}
