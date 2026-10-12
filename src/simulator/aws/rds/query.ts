import * as Distribution from "../../Distribution.ts"
import type * as Flow from "../../Flow.ts"
import { type CallFailure, Failed, type Message, Unavailable } from "../../Message.ts"
import type { TimerHandle } from "../../VirtualTime.ts"
import { OPENED, type Pool } from "./connections.ts"
import type { Database, Role } from "./database.ts"
import { NO_EFFECT, type ZoneEffect } from "./zones.ts"

/** Why a query that was running when the primary failed comes back failed: its connection went with the primary. */
export const CONNECTION_LOST = "connection lost: the primary failed while the query ran"

/**
 * One query on one connection, from the moment its connection is granted to its answer:
 *
 * 1. a new connection is opened first (the handshake: TCP, TLS, authentication); a reused one is ready;
 * 2. it waits for a vCPU, and runs its CPU work there (a new connection adds the server's share of opening it);
 * 3. it spends its time off the CPU: storage (queued behind other I/O once the volume is at its IOPS), locks, and on a
 *    Multi-AZ instance the standby's acknowledgement of a write;
 * 4. it gives the connection back to its client's pool, or closes it, once the client is done with it (`holdMs` later).
 *
 * The connection is held throughout, including while the query waits for a vCPU: that is how a slow database runs out of
 * connections. A query whose primary failed while it ran fails when it finishes (its connection is gone). A Slow fault on
 * the zone of its instance adds to its time off the CPU, and an Errors fault fails a share of queries once they have run,
 * as the engine applies them to any node (`zone`). Returns the function that abandons it; whatever it holds is given
 * back exactly once, however it ends.
 */
export const runQuery = (db: Database, role: Role, pool: Pool, got: number, message: Message, done: Flow.Done, zone: ZoneEffect = NO_EFFECT): Flow.Cancel => {
  const { fast, stats } = db
  const c = fast.settings()
  const random = fast.random
  const isRead = message.operation === "read"
  const records = message.count > 1 ? message.count : 1
  const epoch = role.server.epoch
  const arrived = fast.now()
  const opened = got === OPENED

  let finished = false
  let timer: TimerHandle | undefined
  let onCpu = false
  let giveUp: (() => void) | undefined
  let queuedAt = 0

  const release = (): void => pool.release(fast.now(), epoch)

  const finish = (failure: CallFailure | undefined): void => {
    finished = true
    timer = undefined
    const took = fast.now() - arrived
    stats.queryTime.add(took)
    if (failure === undefined) (isRead ? stats.selectLatency : stats.dmlLatency).add(took)
    // The caller keeps its connection checked out for the rest of its work (see `ClientPolicy.holdMs`).
    const hold = failure === undefined ? pool.policy().holdMs : 0
    if (hold > 0) fast.after(hold, release, undefined)
    else release()
    done(failure)
  }

  const answered = (): void => {
    if (finished) return
    if (epoch !== role.server.epoch) {
      stats.count.lost.add(1)
      return finish(Unavailable({ node: db.id, reason: CONNECTION_LOST }))
    }
    if (!isRead && db.reader.instances() > 0) stats.replicaLag.add(Distribution.latencyMs(c.replicaLag, random))
    if (zone.errorRate > 0 && random.nextDoubleUnsafe() < zone.errorRate) return finish(Failed({ node: db.id, reason: "injected error" }))
    finish(undefined)
  }

  const offCpu = (): void => {
    if (finished) return
    onCpu = false
    const now = fast.now()
    role.cpuChanging(now)
    role.cpu.release()
    const ios = (isRead ? c.query.readIos : c.query.writeIos) * records
    // The writer's volume is the one CloudWatch's ReadIOPS and WriteIOPS describe beside its CPU and connections.
    if (role === db.writer) (isRead ? stats.readIops : stats.writeIops).n += ios
    const io = role.ioWait(now, ios)
    if (io > 0) stats.ioWait.add(io)
    let wait = Distribution.latencyMs(isRead ? c.query.readWait : c.query.writeWait, random) + io + zone.extraMs
    // A Multi-AZ instance (or cluster) commits a write only once a standby has it; Aurora's quorum write is in its own figure.
    if (!isRead && role === db.writer && c.multiAz !== "none" && !db.derived().aurora) wait += Distribution.latencyMs(c.standbyCommit, random)
    timer = fast.after(wait, answered, undefined)
  }

  const run = (): void => {
    onCpu = true
    giveUp = undefined
    stats.cpuWait.add(fast.now() - queuedAt)
    const work = Distribution.latencyMs(isRead ? c.query.readCpu : c.query.writeCpu, random) * records
    timer = fast.after(work + (opened ? Distribution.latencyMs(c.connection.cpu, random) : 0), offCpu, undefined)
  }

  const queue = (): void => {
    timer = undefined
    if (finished) return
    queuedAt = fast.now()
    role.cpuChanging(queuedAt)
    const place = role.cpu.acquire(run)
    if (!onCpu) giveUp = place
  }

  if (opened) {
    stats.count.opened.add(1)
    const handshake = Distribution.latencyMs(c.connection.handshake, random)
    stats.connectTime.add(handshake)
    timer = fast.after(handshake, queue, undefined)
  } else queue()

  return () => {
    if (finished) return
    finished = true
    timer?.cancel()
    if (onCpu) {
      role.cpuChanging(fast.now())
      role.cpu.release()
    } else giveUp?.()
    pool.release(fast.now(), epoch)
  }
}
