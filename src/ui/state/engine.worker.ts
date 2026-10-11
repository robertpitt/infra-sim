import { Engine, Registry } from "#simulator"
import { registry } from "#simulator/components"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import type { Command, Event } from "./types.ts"

/**
 * The simulation, off the main thread.
 *
 * The engine is pure Effect speaking plain-data commands and events, so it runs here unchanged: the page posts
 * commands in and receives batches of events out. A busy simulation (a fast one, a big design) can then use a whole core
 * without taking a frame away from the UI, which only ever receives finished frames and decides for itself how often
 * to draw them.
 */

interface Port {
  postMessage(data: unknown): void
  onmessage: ((event: { readonly data: unknown }) => void) | null
}
const port = self as unknown as Port

/** Events are sent in batches, at most this often, so the page handles a few messages a second however fast the run. */
const FLUSH_MS = 50

const runtime = ManagedRuntime.make(Engine.Engine.layer.pipe(Layer.provide(Layer.succeed(Registry.Registry, registry))))

let pending: Array<Event> = []
let timer: ReturnType<typeof setTimeout> | undefined

/** Merge neighbours that say the same kind of thing: consecutive frames become one list, the latest status wins. */
const coalesce = (events: ReadonlyArray<Event>): ReadonlyArray<Event> => {
  const out: Array<Event> = []
  for (const event of events) {
    const last = out[out.length - 1]
    if (event._tag === "frames" && last?._tag === "frames") out[out.length - 1] = { _tag: "frames", frames: [...last.frames, ...event.frames] }
    else if (event._tag === "status" && last?._tag === "status") out[out.length - 1] = event
    else out.push(event)
  }
  return out
}

const flush = () => {
  timer = undefined
  if (pending.length === 0) return
  const batch = coalesce(pending)
  pending = []
  port.postMessage(batch)
}

// Commands that arrive before the engine has finished building wait here, in order.
const waiting: Array<Command> = []
let engine: Engine.Engine["Service"] | undefined

void runtime
  .runPromise(
    Effect.gen(function*() {
      const e = yield* Engine.Engine
      // Subscribe before anything can be sent, so no event is missed.
      yield* Effect.forkDetach(
        Stream.runForEach(e.events, (event) =>
          Effect.sync(() => {
            pending.push(event)
            // Anything that isn't a frame (a state change, a rejection) shouldn't wait for the next batch.
            if (event._tag !== "frames" && event._tag !== "status") {
              clearTimeout(timer)
              flush()
            } else if (timer === undefined) timer = setTimeout(flush, FLUSH_MS)
          }))
      )
      yield* Effect.yieldNow
      return e
    })
  )
  .then((e) => {
    engine = e
    for (const command of waiting.splice(0)) runtime.runFork(e.send(command))
  })

port.onmessage = (message) => {
  const command = message.data as Command
  if (engine === undefined) waiting.push(command)
  else runtime.runFork(engine.send(command))
}
