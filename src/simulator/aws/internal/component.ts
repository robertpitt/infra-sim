import type { Schema, SubscriptionRef } from "effect"
import * as Component from "../../Component.ts"
import type { Account } from "./account.ts"

/** An AWS component's node: the generic one, with the account quotas typed. */
export type Node<C extends Schema.Top, P extends Component.PortDefs> =
  & Omit<Component.Node<C["Type"], P>, "account">
  & { readonly account: SubscriptionRef.SubscriptionRef<Account> }

/** Define an AWS component. Same as `Component.make`, with `provider` fixed and the node's account quotas typed. */
export const component = <
  const C extends Schema.Top,
  const P extends Component.PortDefs = { readonly out: Component.PortDef<undefined> },
  const S extends Schema.Top = Schema.Struct<{}>
>(
  input: Omit<Component.Input<C, P, S>, "provider" | "make"> & { readonly make: (node: Node<C, P>) => ReturnType<Component.ComponentDef<C, P, S>["make"]> }
): Component.ComponentDef<C, P, S> =>
  Component.make<C, P, S>({ ...input, provider: "aws", make: (node) => input.make(node as unknown as Node<C, P>) } as Component.Input<C, P, S>)
