import type { Fast } from "../../Component.ts"
import type { TimerHandle } from "../../VirtualTime.ts"

/**
 * A data node's processors, shared by every thread that is running on them.
 *
 * OpenSearch sizes its write and search pools separately (one write thread per vCPU, 1.5 search threads per vCPU plus
 * one), so a busy node has more runnable threads than vCPUs and the operating system shares the processors between
 * them. That sharing is how indexing and search compete on a node: a bulk load that keeps every write thread busy
 * takes its share of the CPU from the searches running beside it, so they take longer, their queue grows, and past
 * it they are rejected. Separate pools without shared processors would never interfere.
 *
 * Modelled as processor sharing: with `n` jobs running on `c` cores each progresses at `min(1, c / n)` CPU-milliseconds
 * per millisecond. Rather than re-arming every job's timer whenever `n` changes, the node keeps one clock of work done
 * per job (`work`), which advances at that rate, and one timer for the job that will finish first: each change is a
 * heap operation and one timer.
 */
export class Cpu {
  private running = 0
  /** CPU-milliseconds every running job has received so far: a job finishes when this reaches its `finish`. */
  private work = 0
  private at: number
  private readonly heap: Array<Job> = []
  private timer: TimerHandle | undefined
  /** Core-milliseconds spent, for utilisation. */
  private busy = 0
  private sampledAt: number
  private sampledBusy = 0

  constructor(
    private readonly fast: Pick<Fast<unknown>, "after" | "now">,
    private cores: number
  ) {
    this.at = fast.now()
    this.sampledAt = this.at
  }

  /** Jobs running now. */
  get jobs(): number {
    return this.running
  }

  /** Change the number of cores (the instance type changed): the time so far is charged at the old rate. */
  setCores(cores: number): void {
    if (cores === this.cores) return
    this.sync()
    this.cores = Math.max(1, cores)
    this.rearm()
  }

  /** Run a job needing `demand` CPU-milliseconds; `done` is called when it has had them. */
  run(demand: number, done: () => void): void {
    this.sync()
    push(this.heap, { finish: this.work + Math.max(0, demand), done })
    this.running++
    this.rearm()
  }

  /** Drop every job without calling it back: the node failed. */
  clear(): void {
    this.sync()
    this.heap.length = 0
    this.running = 0
    this.rearm()
  }

  /** Share of the cores busy since the previous sample (0 to 1). */
  sample(): number {
    this.sync()
    const elapsed = this.at - this.sampledAt
    const used = this.busy - this.sampledBusy
    this.sampledAt = this.at
    this.sampledBusy = this.busy
    return elapsed > 0 ? Math.min(1, used / (elapsed * this.cores)) : this.running > 0 ? 1 : 0
  }

  private rate(): number {
    return this.running <= this.cores ? 1 : this.cores / this.running
  }

  /** Bring the work clock and the busy time up to now. */
  private sync(): void {
    const now = this.fast.now()
    const elapsed = now - this.at
    if (elapsed <= 0) return
    if (this.running > 0) {
      this.work += elapsed * this.rate()
      this.busy += elapsed * Math.min(this.running, this.cores)
    }
    this.at = now
  }

  private rearm(): void {
    this.timer?.cancel()
    this.timer = undefined
    const next = this.heap[0]
    if (next === undefined) return
    this.timer = this.fast.after(Math.max(0, (next.finish - this.work) / this.rate()), fire, this)
  }

  /** @internal The first job's time has come: finish it and any others done by now, then call them back. */
  complete(): void {
    this.timer = undefined
    this.sync()
    const finished: Array<Job> = []
    // A job is done when the clock has reached its finish, allowing for floating-point drift.
    const reached = this.work + 1e-6 * Math.max(1, this.work)
    while (this.heap.length > 0 && this.heap[0]!.finish <= reached) {
      const job = pop(this.heap)!
      this.running--
      finished.push(job)
    }
    this.rearm()
    for (const job of finished) job.done()
  }
}

/** A job on the processors. */
interface Job {
  readonly finish: number
  readonly done: () => void
}

const fire = (cpu: Cpu): void => cpu.complete()

// A binary min-heap on `finish`. Ties keep no particular order, which is fine: tied jobs finish at the same instant
// and are called back in the order they come off the heap, which is deterministic.

const push = (heap: Array<Job>, job: Job): void => {
  heap.push(job)
  let i = heap.length - 1
  while (i > 0) {
    const parent = (i - 1) >> 1
    if (heap[parent]!.finish <= job.finish) break
    heap[i] = heap[parent]!
    i = parent
  }
  heap[i] = job
}

const pop = (heap: Array<Job>): Job | undefined => {
  const top = heap[0]
  const last = heap.pop()
  if (top === undefined || last === undefined || heap.length === 0) return top
  let i = 0
  const n = heap.length
  for (;;) {
    const left = 2 * i + 1
    if (left >= n) break
    const right = left + 1
    const child = right < n && heap[right]!.finish < heap[left]!.finish ? right : left
    if (heap[child]!.finish >= last.finish) break
    heap[i] = heap[child]!
    i = child
  }
  heap[i] = last
  return top
}
