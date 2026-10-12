import { Duration, Effect, Schema, Stream, SubscriptionRef } from "effect"
import * as Connector from "../Connector.ts"
import { type Dashboard, gauge, rate, ratio } from "../Dashboard.ts"
import * as Edge from "../Edge.ts"
import type { CallFailure, ItemFailures } from "../Message.ts"
import { batchOf, type Lease, type LeasedRecord } from "../Protocol.ts"
import * as Setting from "../Setting.ts"
import type { TimerHandle } from "../VirtualTime.ts"

export const Config = Schema.Struct({
  workers: Setting.int({
    default: 1,
    min: 1,
    max: 10_000,
    unit: "workers",
    label: "Workers",
    help: "How many take a batch and call with it at the same time. Each waits for its call before taking more."
  }),
  batchSize: Setting.int({ default: 1, min: 1, max: 10_000, unit: "records", label: "Batch size", help: "Records taken for one call, at most." }),
  timeout: Setting.duration({
    default: "30 seconds",
    min: "1 millis",
    max: "15 minutes",
    label: "Call timeout",
    help: "How long a worker waits for its call. A batch that isn't acknowledged in time comes back to the source when its lease runs out."
  }),
  backoff: Setting.duration({
    default: "1 second",
    min: 0,
    max: "10 minutes",
    label: "Pause after a failure",
    help: "How long a worker waits after a failed call before it takes again."
  })
})

/**
 * The pool's charts, after transport's: how many workers are busy against how many there are, the batches they send and
 * the records in them, and what failed. A worker pool polling a queue is the self-managed consumer AWS leaves to you, so
 * nothing here is a CloudWatch metric: it is what you would publish yourself.
 */
const dashboard: Dashboard = {
  figures: [
    { label: "Busy workers", metric: gauge("busy"), unit: "count" },
    { label: "Batches", metric: rate("batches"), unit: "perSecond" },
    { label: "Avg batch", metric: ratio(rate("records"), rate("batches")), unit: "count" }
  ],
  panels: [
    {
      id: "workers",
      title: "Workers",
      unit: "count",
      help: "Workers waiting on a call, against the pool. All of them busy while the source has a backlog means the pool is the bottleneck.",
      lines: [
        { label: "busy", metric: gauge("busy"), tone: "accent" },
        { label: "workers", metric: gauge("workers"), tone: "muted", dashed: true }
      ]
    },
    {
      id: "batches",
      title: "Batches",
      unit: "perSecond",
      help: "Batches sent, and those whose call failed (left to the source, to come back when their lease runs out).",
      lines: [
        { label: "sent", metric: rate("batches"), tone: "primary" },
        { label: "failed", metric: rate("batchesFailed"), tone: "bad" }
      ]
    },
    {
      id: "records",
      title: "Records",
      unit: "perSecond",
      help: "Records sent in batches, and records a successful call reported failed (left to the source on their own).",
      lines: [
        { label: "sent", metric: rate("records"), tone: "primary" },
        { label: "reported failed", metric: rate("recordsFailed"), tone: "warn" }
      ]
    },
    {
      id: "batch-size",
      title: "Batch size",
      unit: "count",
      lines: [
        { label: "average", metric: ratio(rate("records"), rate("batches")), tone: "primary" },
        { label: "batch size", metric: gauge("batchSize"), tone: "muted", dashed: true }
      ]
    }
  ]
}

interface Worker {
  readonly index: number
  alive: boolean
  held: Array<Lease>
  /** The batch's records as sent, so a reply naming failed records by position can be matched back to them. */
  readonly order: Array<LeasedRecord>
  timer: TimerHandle | undefined
  readonly done: Edge.Done
}

/**
 * A fixed pool of workers taking from a pull source: the generic consumer of a queue.
 *
 * Each worker takes a batch, calls the target with it and waits. On success it acknowledges the batch, except any records
 * the reply names as failed (`ItemFailures`); on failure it leaves the batch to the source (whose lease runs out and
 * hands it out again) and pauses before taking more. Workers
 * are started as work arrives (the source says when), not by polling on a timer. Editing the number of workers applies
 * at once: new ones start, and ones above the new number stop after their current batch.
 */
export const Poller = Connector.make({
  type: "core.poller",
  title: "Poller",
  description: "A fixed pool of workers that take batches from a source, call the target with each, and acknowledge it when the call succeeds.",
  icon: "reload",
  from: { protocol: "pull" },
  to: { protocol: "invoke" },
  dashboard,
  config: Config,
  state: Schema.Struct({
    workers: Schema.Number,
    busy: Schema.Number,
    /** Batches sent. */
    batches: Schema.Number,
    /** Batches whose call failed (left to the source whole). */
    failed: Schema.Number,
    /** Records successful calls reported failed (left to the source on their own). */
    recordsFailed: Schema.Number
  }),
  make: (ctx) =>
    Effect.gen(function*() {
      const { fast, source, sink } = ctx
      const workers: Array<Worker> = []
      const idle: Array<Worker> = []
      let busy = 0
      let batches = 0
      let failed = 0
      let recordsFailed = 0
      let pumping = false
      // The same as rates, on the edge's meter beside transport's own counts.
      const batchesC = ctx.meter.counter("batches")
      const recordsC = ctx.meter.counter("records")
      const batchesFailedC = ctx.meter.counter("batchesFailed")
      const recordsFailedC = ctx.meter.counter("recordsFailed")

      /** Bring the pool to the size the settings ask for. */
      const ensure = (): void => {
        const target = fast.settings().workers
        for (let i = 0; i < target; i++) {
          let w = workers[i]
          if (w === undefined) {
            w = { index: i, alive: false, held: [], order: [], timer: undefined, done: (failure, items) => outcome(w!, failure, items) }
            workers[i] = w
          }
          if (!w.alive) {
            w.alive = true
            idle.push(w)
          }
        }
      }

      /** Give receivable work to idle workers until there is no one to take it or nothing to take. */
      const pump = (): void => {
        if (pumping) return
        pumping = true
        try {
          ensure()
          const c = fast.settings()
          const size = Math.min(c.batchSize, source.traits.maxTake ?? Infinity)
          while (source.available()) {
            const w = idle.pop()
            if (w === undefined) break
            if (w.index >= c.workers) {
              w.alive = false
              continue
            }
            let taken = 0
            while (taken < c.batchSize) {
              const lease = source.take(Math.min(size, c.batchSize - taken), Infinity)
              if (lease === undefined) break
              w.held.push(lease)
              taken += lease.count
              if (source.traits.ordered) break
            }
            if (taken === 0) {
              idle.push(w)
              break
            }
            send(w)
          }
        } finally {
          pumping = false
        }
      }

      const send = (w: Worker): void => {
        w.order.length = 0
        const batch = batchOf(w.held, Infinity, w.order)
        if (batch === undefined) return release(w)
        busy++
        batches++
        batchesC.n++
        recordsC.n += batch.count
        sink.call(batch, Edge.within(Duration.toMillis(fast.settings().timeout)), w.done)
      }

      const outcome = (w: Worker, failure: CallFailure | undefined, items: ItemFailures | undefined): void => {
        busy--
        if (failure === undefined) {
          // Records the reply names as failed stay with the source, to come back when their lease runs out.
          const keep = items === undefined ? undefined : new Set(items.failed.flatMap((i) => (w.order[i] === undefined ? [] : [w.order[i]!])))
          if (keep !== undefined) {
            recordsFailed += keep.size
            recordsFailedC.n += keep.size
          }
          for (const lease of w.held) lease.ack(keep)
          release(w)
          return pump()
        }
        failed++
        batchesFailedC.n++
        // Leave the batch to the source: its lease runs out and it is handed out again.
        w.held = []
        w.timer = fast.after(Duration.toMillis(fast.settings().backoff), resume, w)
      }

      const resume = (w: Worker): void => {
        w.timer = undefined
        idle.push(w)
        pump()
      }

      const release = (w: Worker): void => {
        w.held = []
        idle.push(w)
      }

      ctx.meter.gaugeUnsafe("workers", () => fast.settings().workers)
      ctx.meter.gaugeUnsafe("busy", () => busy)
      ctx.meter.gaugeUnsafe("batchSize", () => fast.settings().batchSize)
      source.ready(pump)
      fast.after(0, pump, undefined)
      // More workers apply at once, not when the next message happens to arrive.
      yield* ctx.spawn(SubscriptionRef.changes(ctx.config).pipe(Stream.runForEach(() => Effect.sync(pump))))

      return {
        probe: Effect.sync(() => ({ workers: fast.settings().workers, busy, batches, failed, recordsFailed }))
      }
    })
})
