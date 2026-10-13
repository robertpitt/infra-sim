import type { Link } from "../../../Edge.ts"
import * as Flow from "../../../Flow.ts"
import { Throttled } from "../../../Message.ts"
import type { Counter } from "../../../Telemetry.ts"

/**
 * A NAT gateway's source ports, for `NatGateway`: the connections it holds open to each destination (each wired edge),
 * and the gate that takes one for a call or refuses it with ErrorPortAllocation when that destination's ports are used
 * up. Plain bookkeeping on the call path: one map entry per destination with connections open.
 */
export class Ports {
  /** Connections open per destination (per wired edge). Entries are removed at zero, so it stays as small as the traffic is wide. */
  private readonly open = new Map<string, number>()
  /** Connections open right now, summed over destinations. */
  connections = 0
  /** New connections refused because the address had no free ports to that destination. */
  portAllocationErrors = 0

  constructor(
    private readonly node: string,
    /** The most simultaneous connections one destination can have right now. */
    private readonly limit: () => number,
    /** ErrorPortAllocation, ConnectionAttemptCount and ConnectionEstablishedCount. */
    private readonly counters: { readonly portErrors: Counter; readonly attempts: Counter; readonly established: Counter }
  ) {}

  /** Connections open to the busiest destination: the one that runs out of ports first. */
  busiest(): number {
    let most = 0
    for (const n of this.open.values()) if (n > most) most = n
    return most
  }

  /** Take a connection for the call on `link`, or refuse it when the destination's ports are used up. */
  readonly gate = (link: Link): Link => ({
    ...link,
    send: (message, done) => {
      const { open, counters } = this
      counters.attempts.n++
      const held = open.get(link.id) ?? 0
      if (held >= this.limit()) {
        counters.portErrors.n++
        this.portAllocationErrors++
        done?.(Throttled({ node: this.node, reason: "ErrorPortAllocation: no free port to this destination" }))
        return Flow.noCancel
      }
      open.set(link.id, held + 1)
      this.connections++
      counters.established.n++
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        this.connections--
        const now = (open.get(link.id) ?? 1) - 1
        if (now <= 0) open.delete(link.id)
        else open.set(link.id, now)
      }
      const cancel = link.send(message, (failure) => {
        release()
        done?.(failure)
      })
      return () => {
        release()
        cancel()
      }
    }
  })
}
