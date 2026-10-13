/**
 * Memoising a derived value against the identity of the object it is derived from. Settings objects are immutable and
 * replaced when someone edits them, so a value worked out from one (a call policy, a sampling shape) stays right for as
 * long as that object lives. Used on hot paths: a hit is one `WeakMap` lookup and allocates nothing.
 */

/**
 * `f`, worked out once per `key` object and then returned from a `WeakMap`. An optional second argument is passed
 * through on the first call for a key only: later calls with the same key return that first result whatever they pass.
 */
export const memoByIdentity = <K extends object, V, A = void>(f: (key: K, arg: A) => V): ((key: K, arg: A) => V) => {
  const memo = new WeakMap<K, V>()
  return (key, arg) => {
    let value = memo.get(key)
    if (value === undefined) {
      value = f(key, arg)
      memo.set(key, value)
    }
    return value
  }
}
