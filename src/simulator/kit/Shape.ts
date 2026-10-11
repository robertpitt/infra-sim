import type { Source } from "../Distribution.ts"
import type { Message } from "../Message.ts"

/** Records a call stands for. A message that counts nothing is still one: it must not be free or negative. */
export const records = (message: Message): number => (message.count >= 1 ? message.count : 1)

/** Bytes a call carries, never negative. */
export const bodyBytes = (message: Message): number => (message.bytes > 0 ? message.bytes : 0)

/**
 * Whether something that happens to a `share` of calls (a filter that matches, a request that is kept) happens to this
 * one. A share of 1 or more draws nothing, so a setting left at its default consumes no randomness.
 */
export const passes = (random: Source, share: number): boolean => share >= 1 || random.nextDoubleUnsafe() < share

/** Whether a rare event with probability `p` (a duplicate delivery) happens. A `p` of 0 or less draws nothing. */
export const chance = (random: Source, p: number): boolean => p > 0 && random.nextDoubleUnsafe() < p

/**
 * Pick between outcomes by share: `a` with chance `shareA`, `b` with chance `shareB`, otherwise `rest`. Draws nothing
 * when both shares are zero, so a node with no mix consumes no randomness. No allocation: it is on the call path.
 */
export const mix = <T>(random: Source, rest: T, a: T, shareA: number, b: T, shareB: number): T => {
  if (shareA <= 0 && shareB <= 0) return rest
  const u = random.nextDoubleUnsafe()
  return u < shareA ? a : u < shareA + shareB ? b : rest
}
