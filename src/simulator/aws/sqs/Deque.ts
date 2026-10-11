/**
 * A double-ended queue over one array with a moving head: taking from the front is O(1) (no `Array.shift`, which is
 * O(n) and made a queue of hundreds of thousands of messages quadratic), and putting items back on the front is
 * amortised O(1).
 *
 * Queues here hold entries that may have been removed from elsewhere (expired, deleted) without being found and cut out
 * of this one: finding them would be a scan. Those are left as tombstones for the reader to skip, and `retain` rebuilds
 * the array when the owner decides there are enough of them to be worth it.
 */
export class Deque<T> {
  private items: Array<T | undefined> = []
  private head = 0

  get length(): number {
    return this.items.length - this.head
  }

  push(item: T): void {
    this.items.push(item)
  }

  shift(): T | undefined {
    if (this.head >= this.items.length) return undefined
    const item = this.items[this.head]
    this.items[this.head++] = undefined
    if (this.head === this.items.length) {
      this.items.length = 0
      this.head = 0
    } else if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head)
      this.head = 0
    }
    return item
  }

  /** Put an item back at the front, as the next one `shift` returns. */
  unshift(item: T): void {
    if (this.head === 0) {
      // No room: reopen a gap in front proportional to the size, so a run of these doesn't each copy the array.
      const slack = Math.max(16, this.items.length)
      const grown = new Array<T | undefined>(slack + this.items.length)
      for (let i = 0; i < this.items.length; i++) grown[slack + i] = this.items[i]
      this.items = grown
      this.head = slack
    }
    this.items[--this.head] = item
  }

  /** The item `shift` would return, without taking it. */
  peek(): T | undefined {
    return this.items[this.head]
  }

  clear(): void {
    this.items = []
    this.head = 0
  }

  /** Keep only the items `keep` accepts, in order. */
  retain(keep: (item: T) => boolean): void {
    const kept: Array<T | undefined> = []
    for (let i = this.head; i < this.items.length; i++) {
      const item = this.items[i] as T
      if (keep(item)) kept.push(item)
    }
    this.items = kept
    this.head = 0
  }
}
