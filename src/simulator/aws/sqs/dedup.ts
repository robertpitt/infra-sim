import { DEDUP_WINDOW_MS } from "./config.ts"
import { Deque } from "./Deque.ts"

/**
 * FIFO deduplication: "if Amazon SQS has already accepted a message with a specific deduplication ID, any subsequent
 * messages with the same ID will be acknowledged but not delivered", for five minutes after the first was accepted, and
 * SQS keeps tracking the id after the message has been received and deleted.
 *
 * The id here is the sender's message id (a producer that retries a send re-sends the same message). Ids are remembered
 * in arrival order, so expiry is a pop from the front: memory is bounded by five minutes of traffic.
 */
export class DedupWindow {
  private readonly seen = new Map<number, number>()
  private readonly order = new Deque<number>()

  /** Whether `id` was accepted in the last five minutes. If not, it is remembered from `now`. */
  isDuplicate(id: number, now: number): boolean {
    const cutoff = now - DEDUP_WINDOW_MS
    for (let oldest = this.order.peek(); oldest !== undefined; oldest = this.order.peek()) {
      if (this.seen.get(oldest)! > cutoff) break
      this.order.shift()
      this.seen.delete(oldest)
    }
    if (this.seen.has(id)) return true
    this.order.push(id)
    this.seen.set(id, now)
    return false
  }
}
