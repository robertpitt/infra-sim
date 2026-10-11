import type { ChoiceField, FieldSpec, NumberField } from "../state/types.ts"
import { useEffect, useState } from "react"
import { Icon } from "./Icon.tsx"

type Path = ReadonlyArray<string>

interface FormProps {
  readonly fields: ReadonlyArray<FieldSpec>
  /** Overrides currently stored on the design; anything absent shows the field's default. */
  readonly values: Readonly<Record<string, unknown>>
  /** Called with `undefined` to drop an override and fall back to the default. */
  readonly onChange: (path: Path, value: unknown) => void
  readonly path?: Path
}

/** Renders a settings form straight from a component's `FieldSpec` tree. No per-component UI code. */
export function SettingsForm({ fields, values, onChange, path = [] }: FormProps) {
  return (
    <div className="form">
      {fields.map((spec) => (
        <Field key={spec.key} spec={spec} value={values[spec.key]} path={[...path, spec.key]} onChange={onChange} />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------
// Values on a slider
// ---------------------------------------------------------------------------------------------------------

const STEPS = 1000

/** Ranges spanning three orders of magnitude or more get a logarithmic slider: 1 to 100,000 workers can't be linear. */
const isLog = (spec: NumberField): boolean => spec.display !== "percent" && (spec.max ?? 0) - (spec.min ?? 0) >= 1000

const toStep = (spec: NumberField, value: number): number => {
  const min = spec.min ?? 0
  const max = spec.max ?? 1
  const v = Math.min(max, Math.max(min, value))
  const t = isLog(spec) ? Math.log1p(v - min) / Math.log1p(max - min) : (v - min) / (max - min || 1)
  return Math.round(t * STEPS)
}

const fromStep = (spec: NumberField, position: number): number => {
  const min = spec.min ?? 0
  const max = spec.max ?? 1
  const t = position / STEPS
  const raw = isLog(spec) ? min + Math.expm1(t * Math.log1p(max - min)) : min + t * (max - min)
  // Round to a number someone would type: three significant figures, and whole numbers for whole-number settings.
  let v = raw
  if (spec.step !== undefined && spec.step > 0 && !isLog(spec)) v = Math.round(raw / spec.step) * spec.step
  else if (Math.abs(raw) >= 100) v = Number(raw.toPrecision(3))
  else if (spec.kind === "int") v = Math.round(raw)
  else v = Number(raw.toPrecision(3))
  if (spec.kind === "int") v = Math.round(v)
  return Math.min(max, Math.max(min, v))
}

// ---------------------------------------------------------------------------------------------------------
// Durations are stored in milliseconds and typed with a unit: "250", "1.5s", "10m", "6h".
// ---------------------------------------------------------------------------------------------------------

const UNITS: ReadonlyArray<readonly [string, number]> = [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000], ["s", 1_000], ["ms", 1]]

const fmtDuration = (ms: number): string => {
  if (ms === 0) return "0 ms"
  for (const [unit, size] of UNITS) {
    if (Math.abs(ms) >= size) return `${Number((ms / size).toPrecision(4))} ${unit}`
  }
  return `${ms} ms`
}

const parseDuration = (text: string): number | undefined => {
  const m = /^\s*([0-9]*\.?[0-9]+)\s*(ms|s|m|h|d)?\s*$/i.exec(text)
  if (m === null) return undefined
  const unit = UNITS.find(([u]) => u === (m[2] ?? "ms").toLowerCase())
  return unit === undefined ? undefined : Number(m[1]) * unit[1]
}

// ---------------------------------------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------------------------------------

const Hint = ({ text }: { text: string | undefined }) =>
  text === undefined ? null : (
    <span className="hint" title={text} aria-label={text} tabIndex={0}>
      <Icon name="info" size={11} />
    </span>
  )

const LimitPill = ({ spec }: { spec: NumberField }) => {
  const limit = spec.limit
  if (limit === undefined) return null
  const hard = limit.kind === "hard"
  const text = hard
    ? `The service enforces this and it can't be raised, so the range is the limit.${limit.note ? ` ${limit.note}` : ""}`
    : `The provider's default quota. It can be raised on request, so it is editable here.${limit.note ? ` ${limit.note}` : ""}`
  const label = hard ? "hard" : "quota"
  return limit.source === undefined ? (
    <span className="pill" data-kind={limit.kind} title={text}>{label}</span>
  ) : (
    <a className="pill" data-kind={limit.kind} href={limit.source} target="_blank" rel="noreferrer" title={`${text} Open the documentation.`}>
      {label}
    </a>
  )
}

const Field = ({ spec, value, path, onChange }: { spec: FieldSpec; value: unknown; path: Path; onChange: FormProps["onChange"] }) => {
  if (spec.kind === "group") return <Group spec={spec} value={value} path={path} onChange={onChange} />
  const modified = value !== undefined && value !== spec.default
  const reset = modified && (
    <button className="reset" title={`Reset to default (${String(spec.default)})`} onClick={() => onChange(path, undefined)}>
      <Icon name="reset" size={11} />
    </button>
  )
  const label = (
    <label className="field-label" title={spec.help}>
      {spec.label}
      {(spec.kind === "int" || spec.kind === "number") && spec.unit !== undefined && <span className="unit">{spec.unit}</span>}
    </label>
  )
  const lead = (
    <span className="field-lead">
      {label}
      <Hint text={spec.help} />
      {(spec.kind === "int" || spec.kind === "number" || spec.kind === "duration") && <LimitPill spec={spec} />}
      {reset}
    </span>
  )

  switch (spec.kind) {
    case "int":
    case "number":
    case "duration":
      return <NumberRow spec={spec} value={typeof value === "number" ? value : spec.default} lead={lead} modified={modified} onCommit={(n) => onChange(path, n)} />
    case "boolean":
      return (
        <div className="field row" data-modified={modified || undefined}>
          {lead}
          <Toggle checked={typeof value === "boolean" ? value : spec.default} onChange={(b) => onChange(path, b)} />
        </div>
      )
    case "choice": {
      const current = typeof value === "string" ? value : spec.default
      const inline = spec.options.length > 3 || spec.options.reduce((n, o) => n + o.label.length, 0) > 18
      return (
        <div className={inline ? "field stack" : "field row"} data-modified={modified || undefined}>
          {lead}
          <Choice spec={spec} value={current} onChange={(v) => onChange(path, v)} />
        </div>
      )
    }
    case "text":
      return (
        <div className="field stack" data-modified={modified || undefined}>
          {lead}
          <TextBox value={typeof value === "string" ? value : spec.default} placeholder={spec.placeholder} label={spec.label} onCommit={(v) => onChange(path, v)} />
        </div>
      )
  }
}

/** A line of text, committed when it loses focus or Enter is pressed, so a half-typed name isn't applied letter by letter. */
const TextBox = ({ value, placeholder, label, onCommit }: { value: string; placeholder: string | undefined; label: string; onCommit: (v: string) => void }) => {
  const [draft, setDraft] = useState(value)
  const [editing, setEditing] = useState(false)
  const shown = editing ? draft : value
  const commit = () => {
    setEditing(false)
    const v = draft.trim()
    if (v !== value) onCommit(v)
  }
  return (
    <input
      className="text-box"
      type="text"
      value={shown}
      placeholder={placeholder}
      aria-label={label}
      spellCheck={false}
      onFocus={() => {
        setDraft(value)
        setEditing(true)
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur()
        if (e.key === "Escape") {
          setDraft(value)
          setEditing(false)
          ;(e.target as HTMLInputElement).blur()
        }
      }}
    />
  )
}

/** A nested set of settings. One that opens with an on/off switch hides the rest until it's switched on. */
const Group = ({ spec, value, path, onChange }: { spec: Extract<FieldSpec, { kind: "group" }>; value: unknown; path: Path; onChange: FormProps["onChange"] }) => {
  const nested = (value ?? {}) as Record<string, unknown>
  const [open, setOpen] = useState(true)
  const gate = spec.fields[0]?.kind === "boolean" && spec.fields[0].key === "enabled" ? spec.fields[0] : undefined
  const enabled = gate === undefined ? true : typeof nested.enabled === "boolean" ? nested.enabled : gate.default
  const rest = gate === undefined ? spec.fields : spec.fields.slice(1)
  return (
    <fieldset className="group" data-open={(open && enabled) || undefined}>
      <div className="group-top">
        <button className="group-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          <Icon name="chevronDown" size={12} />
          <span>{spec.label}</span>
        </button>
        <Hint text={spec.help ?? gate?.help} />
        {gate !== undefined && <Toggle checked={enabled} onChange={(b) => onChange([...path, "enabled"], b)} />}
      </div>
      {open && enabled && rest.length > 0 && <SettingsForm fields={rest} values={nested} onChange={onChange} path={path} />}
    </fieldset>
  )
}

const NumberRow = ({
  spec,
  value,
  lead,
  modified,
  onCommit
}: {
  spec: NumberField
  value: number
  lead: React.ReactNode
  modified: boolean
  onCommit: (n: number) => void
}) => {
  const duration = spec.kind === "duration"
  const scale = spec.display === "percent" ? 100 : 1
  const shown = (n: number) => (duration ? fmtDuration(n) : String(Number((n * scale).toPrecision(6))))
  const [text, setText] = useState(shown(value))
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!focused) setText(shown(value))
  }, [value, focused])

  const parse = (t: string): number | undefined => {
    if (duration) return parseDuration(t)
    if (t.trim() === "" || Number.isNaN(Number(t))) return undefined
    return Number(t) / scale
  }
  const parsed = parse(text)
  const problem = (() => {
    if (parsed === undefined) return duration ? "Try 250 ms, 1.5 s, 10 m" : "Enter a number"
    if (spec.kind === "int" && !Number.isInteger(parsed)) return "Whole numbers only"
    if (spec.min !== undefined && parsed < spec.min) return `At least ${shown(spec.min)}`
    if (spec.max !== undefined && parsed > spec.max) return `At most ${shown(spec.max)}`
    return undefined
  })()

  const bounded = spec.min !== undefined && spec.max !== undefined && spec.max > spec.min
  const commit = () => {
    if (parsed !== undefined && problem === undefined) onCommit(parsed)
  }

  return (
    <div className="field num" data-modified={modified || undefined}>
      <div className="row">
        {lead}
        <div className="number-box" data-invalid={problem !== undefined || undefined} title={problem}>
          <input
            type="text"
            inputMode={duration ? "text" : "decimal"}
            value={text}
            spellCheck={false}
            aria-label={spec.label}
            onFocus={(e) => {
              setFocused(true)
              e.currentTarget.select()
            }}
            onBlur={() => {
              commit()
              setFocused(false)
              setText(shown(value))
            }}
            onChange={(e) => {
              setText(e.target.value)
              // Whole numbers commit as you type so the simulation follows; durations wait for Enter or blur.
              if (!duration) {
                const n = parse(e.target.value)
                if (n !== undefined && !(spec.kind === "int" && !Number.isInteger(n)) && !(spec.min !== undefined && n < spec.min) && !(spec.max !== undefined && n > spec.max)) onCommit(n)
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") return e.currentTarget.blur()
              if (e.key === "Escape") {
                setText(shown(value))
                return e.currentTarget.blur()
              }
              if (duration || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return
              e.preventDefault()
              const step = (spec.step ?? (spec.kind === "number" ? 0.1 : 1)) * scale
              const next = Number((Number(text || 0) + (e.key === "ArrowUp" ? step : -step)).toPrecision(8))
              const n = next / scale
              if ((spec.min !== undefined && n < spec.min) || (spec.max !== undefined && n > spec.max)) return
              setText(String(next))
              onCommit(n)
            }}
          />
          {spec.display === "percent" && <span className="suffix">%</span>}
        </div>
      </div>
      {bounded && (
        <input
          className="slider"
          type="range"
          min={0}
          max={STEPS}
          step={1}
          value={toStep(spec, value)}
          aria-label={`${spec.label} slider`}
          title={`${shown(spec.min!)} – ${shown(spec.max!)}${spec.limit ? ` (${spec.limit.kind === "hard" ? "hard limit" : "default quota"})` : ""}`}
          onChange={(e) => {
            const n = fromStep(spec, Number(e.target.value))
            setText(shown(n))
            onCommit(n)
          }}
        />
      )}
      {problem !== undefined && focused && <span className="problem">{problem}</span>}
    </div>
  )
}

const Toggle = ({ checked, onChange }: { checked: boolean; onChange: (b: boolean) => void }) => (
  <button className="toggle" role="switch" aria-checked={checked} data-on={checked || undefined} onClick={() => onChange(!checked)}>
    <span />
  </button>
)

const Choice = ({ spec, value, onChange }: { spec: ChoiceField; value: string; onChange: (v: string) => void }) =>
  spec.options.length <= 3 ? (
    <div className="segmented">
      {spec.options.map((o) => (
        <button key={o.value} data-on={o.value === value || undefined} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  ) : (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={spec.label}>
      {spec.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
