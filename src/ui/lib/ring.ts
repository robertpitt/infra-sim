/** Fixed-capacity ring buffer; the oldest items fall off as new ones arrive. */
export class Ring<T> {
  readonly #items: Array<T | undefined>
  #start = 0
  #size = 0

  constructor(readonly capacity: number) {
    this.#items = new Array<T | undefined>(capacity)
  }

  get length(): number {
    return this.#size
  }

  push(item: T): void {
    if (this.#size < this.capacity) {
      this.#items[(this.#start + this.#size++) % this.capacity] = item
    } else {
      this.#items[this.#start] = item
      this.#start = (this.#start + 1) % this.capacity
    }
  }

  at(index: number): T {
    return this.#items[(this.#start + index) % this.capacity] as T
  }

  last(): T | undefined {
    return this.#size === 0 ? undefined : this.at(this.#size - 1)
  }

  clear(): void {
    this.#items.fill(undefined)
    this.#start = 0
    this.#size = 0
  }

  /** The newest `n` items, oldest first. */
  tail(n: number): Array<T> {
    const out: Array<T> = []
    for (let i = Math.max(0, this.#size - n); i < this.#size; i++) out.push(this.at(i))
    return out
  }

  /** Items for which `keep` holds, scanning from the newest and stopping at the first that fails. */
  since(keep: (item: T) => boolean): Array<T> {
    const out: Array<T> = []
    for (let i = this.#size - 1; i >= 0; i--) {
      const item = this.at(i)
      if (!keep(item)) break
      out.push(item)
    }
    return out.reverse()
  }
}
