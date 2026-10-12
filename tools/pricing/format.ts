/**
 * JSON laid out for diffs: one region's price per line, so a price change in the file is a one-line change in review.
 * Objects are spread over lines; arrays of numbers (and of tiers) stay on one.
 */
export const format = (value: unknown): string => `${write(value, "")}\n`

const flat = (v: unknown): boolean => typeof v === "number" || (Array.isArray(v) && v.every((x) => typeof x === "number"))

const write = (value: unknown, indent: string): string => {
  if (Array.isArray(value)) {
    if (value.every(flat)) return JSON.stringify(value).replace(/,/g, ", ")
    const inner = indent + "  "
    return `[\n${value.map((v) => inner + write(v, inner)).join(",\n")}\n${indent}]`
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
    if (entries.length === 0) return "{}"
    const inner = indent + "  "
    return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${write(v, inner)}`).join(",\n")}\n${indent}}`
  }
  return JSON.stringify(value)
}
