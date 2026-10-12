import type { Fast } from "../../Component.ts"
import { Cpu } from "./cpu.ts"

/**
 * One data node: its write and search thread pools in front of its processors, and the bytes of indexing it holds.
 *
 * A pool runs at most `threads` tasks; the rest wait in its queue, first come first served, and a task that finds the
 * queue full is rejected (429, `rejected_execution_exception`). A replica's write is forced into the queue whatever its
 * length, as OpenSearch never rejects a replica for lack of thread-pool room (TransportReplicationAction: "we must never
 * reject on because of thread pool capacity on replicas"), though it still counts in the queue that others see.
 * A running task is a job on the node's processors, which every running thread of both pools shares (`Cpu`).
 */

export type PoolKind = "write" | "search"

/** A shard-level piece of work on a node: indexing on a primary or replica, or one shard's part of a search. */
export class Task {
  state: "new" | "queued" | "running" | "done" = "new"
  /** When a thread took it up: its time running, not queued, is what SearchLatency and IndexingLatency measure. */
  startedAt = 0
  constructor(
    readonly pool: PoolKind,
    /** CPU-milliseconds it needs. */
    readonly demand: number,
    /** Called when it has run. */
    readonly onDone: () => void,
    /** Called instead if its node fails first: the work is gone. */
    readonly onLost: () => void
  ) {}
}

class Pool {
  running = 0
  /** Tasks ever refused for a full queue. */
  rejected = 0
  private readonly line: Array<Task> = []
  private head = 0

  constructor(readonly threads: () => number, readonly queueSize: number) {}

  get queued(): number {
    return this.line.length - this.head
  }

  /** The next waiting task, if a thread is free for it. */
  next(): Task | undefined {
    if (this.running >= this.threads() || this.head >= this.line.length) return undefined
    const task = this.line[this.head++]!
    // Reclaim the consumed front of the line once it is worth it.
    if (this.head > 1_024 && this.head * 2 > this.line.length) {
      this.line.splice(0, this.head)
      this.head = 0
    }
    return task
  }

  enqueue(task: Task): void {
    this.line.push(task)
  }

  /** Everything waiting, in order; the line is emptied. */
  drain(): Array<Task> {
    const waiting = this.line.slice(this.head)
    this.line.length = 0
    this.head = 0
    return waiting
  }
}

export class DataNode {
  up = true
  readonly cpu: Cpu
  readonly write: Pool
  readonly search: Pool
  /** Bytes of indexing held as coordinating node or for primaries here, against the indexing pressure limit. */
  indexingBytes = 0
  /** Bytes of replica writes held here, against 1.5 times that limit. */
  replicaBytes = 0
  /** Requests this node is coordinating: they fail with it. */
  readonly coordinating = new Set<{ readonly lost: () => void }>()
  private readonly running = new Set<Task>()

  constructor(
    readonly index: number,
    private readonly fast: Pick<Fast<unknown>, "after" | "now">,
    vcpu: number,
    writeThreads: () => number,
    searchThreads: () => number,
    writeQueue: number,
    searchQueue: number
  ) {
    this.cpu = new Cpu(fast, vcpu)
    this.write = new Pool(writeThreads, writeQueue)
    this.search = new Pool(searchThreads, searchQueue)
  }

  /**
   * Hand a task to its pool: it starts at once if a thread is free, otherwise waits in the queue. `false` if the queue
   * is full and the task isn't forced: it was rejected and nothing was taken.
   */
  submit(task: Task, forced = false): boolean {
    const pool = this.pool(task.pool)
    if (pool.running < pool.threads() && pool.queued === 0) {
      this.start(task, pool)
      return true
    }
    if (!forced && pool.queued >= pool.queueSize) {
      pool.rejected++
      return false
    }
    task.state = "queued"
    pool.enqueue(task)
    return true
  }

  /** More threads may have appeared (a larger instance type): start waiting work. */
  kick(): void {
    this.drainInto(this.write)
    this.drainInto(this.search)
  }

  /** The node failed: every task on it, running or waiting, is lost, and so are the requests it was coordinating. */
  fail(): void {
    this.up = false
    this.cpu.clear()
    const lost = [...this.running, ...this.write.drain(), ...this.search.drain()]
    this.running.clear()
    this.write.running = 0
    this.search.running = 0
    const requests = [...this.coordinating]
    this.coordinating.clear()
    for (const task of lost) task.state = "done"
    for (const task of lost) task.onLost()
    for (const request of requests) request.lost()
  }

  private pool(kind: PoolKind): Pool {
    return kind === "write" ? this.write : this.search
  }

  private start(task: Task, pool: Pool): void {
    task.state = "running"
    task.startedAt = this.fast.now()
    pool.running++
    this.running.add(task)
    this.cpu.run(task.demand, () => this.finish(task, pool))
  }

  private finish(task: Task, pool: Pool): void {
    if (task.state !== "running") return
    task.state = "done"
    this.running.delete(task)
    pool.running--
    this.drainInto(pool)
    task.onDone()
  }

  private drainInto(pool: Pool): void {
    for (let task = pool.next(); task !== undefined; task = pool.next()) this.start(task, pool)
  }
}
