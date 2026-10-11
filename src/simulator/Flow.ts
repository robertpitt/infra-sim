import { Effect } from "effect"
import type { Fast } from "./Component.ts"
import type { Source } from "./Distribution.ts"
import { type Link, pickUnsafe } from "./Edge.ts"
import type { Call, CallFailure, Message } from "./Message.ts"

/**
 * Small, fast building blocks for component handlers.
 *
 * A handler is an `Effect`, but most of what it does isn't effectful: it reads a setting, checks a limit, draws a
 * number, and decides. Only waiting needs an effect. So a hot handler is written as a plain function that decides
 * everything up front with `node.fast` and returns one of these: nothing at all for an instant answer, or a single
 * timer-backed callback for a wait. That is one operation where a generator with a dozen `yield*`s would be a dozen,
 * and it is why the busy components are several times cheaper than their `Effect.gen` form.
 */

type Timers = Pick<Fast<unknown>, "after">

/** Wait `ms` of virtual time, then succeed. Interrupting cancels the timer. */
export const wait = (fast: Timers, ms: number): Call =>
  ms <= 0
    ? Effect.void
    : Effect.callback<void>((resume) => {
      const timer = fast.after(ms, resumeVoid, resume)
      return Effect.sync(timer.cancel)
    })

const resumeVoid = (resume: (effect: Effect.Effect<void>) => void): void => resume(Effect.void)

/**
 * Wait `ms`, then settle: `finish` runs at that moment and returns the failure to report, or `undefined` for success.
 * `onCancel` runs if the caller is interrupted first, to undo whatever the handler counted on the way in.
 */
export const delayed = (fast: Timers, ms: number, finish: () => CallFailure | undefined, onCancel?: () => void): Call =>
  Effect.callback<void, CallFailure>((resume) => {
    const timer = fast.after(ms, () => {
      const failure = finish()
      resume(failure === undefined ? Effect.void : Effect.fail(failure))
    }, undefined)
    return Effect.sync(() => {
      timer.cancel()
      onCancel?.()
    })
  })

// ---------------------------------------------------------------------------------------------------------
// Calling several things: callbacks all the way, so a fan-out costs one `send` per target and nothing else.
// ---------------------------------------------------------------------------------------------------------

/** Hears how a piece of work ended: `undefined` for success. Called once. */
export type Done = (failure: CallFailure | undefined) => void
/** Abandons work in flight. Safe to call after it has finished. */
export type Cancel = () => void
export const noCancel: Cancel = () => {}

const withInvocation = (message: Message): Message => (message.invocation === "sync" ? message : { ...message, invocation: "sync" })

/** Call each link in turn; the first failure ends it. */
export const sequence = (links: ReadonlyArray<Link>, message: Message, done: Done): Cancel => {
  const m = withInvocation(message)
  let i = 0
  let open = true
  let current: Cancel = noCancel
  const next = (failure?: CallFailure): void => {
    if (!open) return
    if (failure !== undefined || i >= links.length) {
      open = false
      return done(failure)
    }
    current = links[i++]!.send(m, next)
  }
  next()
  return () => {
    if (open) {
      open = false
      current()
    }
  }
}

/** Call every link at once; the first failure ends it and abandons the rest. */
export const parallel = (links: ReadonlyArray<Link>, message: Message, done: Done): Cancel => {
  if (links.length === 0) {
    done(undefined)
    return noCancel
  }
  const m = withInvocation(message)
  const cancels: Array<Cancel> = []
  let remaining = links.length
  let open = true
  const finish = (failure: CallFailure | undefined): void => {
    if (!open) return
    if (failure !== undefined) {
      open = false
      for (const cancel of cancels) cancel()
      return done(failure)
    }
    if (--remaining === 0) {
      open = false
      done(undefined)
    }
  }
  for (const link of links) cancels.push(link.send(m, finish))
  return () => {
    if (open) {
      open = false
      for (const cancel of cancels) cancel()
    }
  }
}

/** Call one link, chosen by weight. Nothing to call is success. */
export const weighted = (links: ReadonlyArray<Link>, random: Source, message: Message, done: Done): Cancel => {
  const link = pickUnsafe(links, random)
  if (link === undefined) {
    done(undefined)
    return noCancel
  }
  return link.send(withInvocation(message), done)
}

/** How a component calls what is wired to its output port. */
export type FanOut = "none" | "sequential" | "parallel" | "weighted"

export const fanOut = (mode: FanOut, links: ReadonlyArray<Link>, random: Source, message: Message, done: Done): Cancel => {
  switch (mode) {
    case "none":
      done(undefined)
      return noCancel
    case "sequential":
      return sequence(links, message, done)
    case "parallel":
      return parallel(links, message, done)
    case "weighted":
      return weighted(links, random, message, done)
  }
}

/** Run `count` tasks, at most `concurrency` at a time; the first failure ends it and abandons what is running. */
export const forEach = (count: number, concurrency: number, task: (index: number, done: Done) => Cancel, done: Done): Cancel => {
  const cancels: Array<Cancel> = []
  let started = 0
  let running = 0
  let finished = 0
  let open = true
  const launch = (): void => {
    while (open && started < count && running < concurrency) {
      const index = started++
      running++
      cancels.push(
        task(index, (failure) => {
          if (!open) return
          running--
          if (failure !== undefined) {
            open = false
            for (const cancel of cancels) cancel()
            return done(failure)
          }
          if (++finished === count) {
            open = false
            return done(undefined)
          }
          launch()
        })
      )
    }
  }
  if (count === 0) {
    done(undefined)
    return noCancel
  }
  launch()
  return () => {
    if (open) {
      open = false
      for (const cancel of cancels) cancel()
    }
  }
}

/**
 * Serial lanes: work added under the same key runs one at a time, in the order it was added; different keys run side by
 * side. This is what ordering by message group means. `task` starts the work and calls the function it is given when done.
 */
export class Lanes {
  private readonly waiting = new Map<string, Array<(release: () => void) => void>>()

  run(key: string, task: (release: () => void) => void): void {
    const queue = this.waiting.get(key)
    if (queue !== undefined) {
      queue.push(task)
      return
    }
    this.waiting.set(key, [])
    this.start(key, task)
  }

  private start(key: string, task: (release: () => void) => void): void {
    task(() => {
      const next = this.waiting.get(key)?.shift()
      if (next !== undefined) this.start(key, next)
      else this.waiting.delete(key)
    })
  }
}
