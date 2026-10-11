import { scenarios } from "#examples"
import { Check } from "#simulator"
import { fmtTime, fmtUnit } from "../lib/format.ts"
import { useStore } from "../lib/store.ts"
import { run } from "../state/run.ts"
import { openScenarioDialog, playExample, restartScenario, stopScenario } from "../state/scenario.ts"
import type { CheckProgress, ScenarioProgress } from "../state/types.ts"
import { Icon } from "./Icon.tsx"

/**
 * Scenarios: a timeline of what goes wrong (and what changes) played against a design, with checks on what must hold.
 * With none playing this is a list to pick from; with one playing it shows where the run is, what has happened and
 * what is coming, and how each check is doing, live, until the run stops at the end with a verdict.
 */
export function ScenarioPanel() {
  const progress = useStore(run, (s) => s.scenario)
  return progress === undefined ? <Picker /> : <Playing progress={progress} />
}

function Picker() {
  return (
    <div className="scenario-picker">
      <div className="scenario-intro">
        <p className="muted small">
          A scenario plays a timeline of faults and changes against a design and checks what must hold, like <code>api.errorRatio &lt; 1%</code>. The same
          files run in CI with <code>infra-sim run</code>.
        </p>
        <button className="btn small" onClick={() => void openScenarioDialog()}>
          <Icon name="upload" size={13} /> Open scenario…
        </button>
      </div>
      <div className="scenario-cards">
        {scenarios.map((s) => {
          const spec = s.scenario()
          const duration = Check.parseDuration(spec.duration)
          return (
            <div className="scenario-card" key={s.id}>
              <div className="scenario-card-head">
                <b>{s.title}</b>
                <button className="btn small primary" onClick={() => playExample(s)}>
                  <Icon name="play" size={12} /> Run
                </button>
              </div>
              <p>{s.blurb}</p>
              <span className="muted small">
                {s.design?.title ?? "Current design"} · {duration === undefined ? "?" : fmtTime(duration)} · {spec.timeline?.length ?? 0} events · {spec.assert?.length ?? 0} checks
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const STATE_LABEL: Record<CheckProgress["state"], string> = {
  waiting: "Waiting for its window",
  holding: "Holding so far",
  breaking: "Breaking so far",
  passed: "Passed",
  failed: "Failed"
}

function Playing({ progress }: { progress: ScenarioProgress }) {
  const { duration, warmup, timeline, checks } = progress
  const t = Math.min(progress.t, duration)
  const pct = (ms: number) => `${(Math.min(Math.max(ms, 0), duration) / duration) * 100}%`
  const verdict = !progress.finished ? "running" : progress.passed ? "passed" : "failed"
  const failing = checks.filter((c) => c.state === "breaking" || c.state === "failed").length

  return (
    <div className="scenario">
      <div className="scenario-head">
        <Icon name="flag" size={14} />
        <b className="scenario-name">{progress.name ?? "Scenario"}</b>
        <span className="verdict" data-verdict={verdict}>
          {verdict === "running" ? (failing > 0 ? `${failing} check${failing > 1 ? "s" : ""} breaking` : "Running") : verdict === "passed" ? "Passed" : "Failed"}
        </span>
        <span className="scenario-clock">
          {fmtTime(t)} / {fmtTime(duration)}
        </span>
        <span className="spacer" />
        <button className="btn small" onClick={restartScenario} title="Play it again from the start">
          <Icon name="reset" size={13} /> Restart
        </button>
        <button className="btn small ghost" onClick={stopScenario} title="Stop the scenario and go back to the design as it is">
          <Icon name="x" size={13} /> Stop
        </button>
      </div>

      <div className="track" aria-label="Scenario progress">
        <div className="track-bar">
          {warmup > 0 && <span className="track-warmup" style={{ width: pct(warmup) }} title={`Warm-up: not measured (${fmtTime(warmup)})`} />}
          <span className="track-done" style={{ width: pct(t) }} />
          {timeline.map((e, i) => (
            <span key={i} className="track-event" data-kind={e.kind} data-done={e.done || undefined} style={{ left: pct(e.at) }} title={`${fmtTime(e.at)} ${e.what}`} />
          ))}
          <span className="track-head" style={{ left: pct(t) }} />
        </div>
        {checks.map((c, i) => (
          <div key={i} className="track-window" data-state={c.state} style={{ left: pct(c.window.from), width: `calc(${pct(c.window.to)} - ${pct(c.window.from)})` }} title={`${c.name ?? c.check}: ${fmtTime(c.window.from)}–${fmtTime(c.window.to)}`} />
        ))}
      </div>

      <div className="scenario-cols">
        <ol className="scenario-timeline">
          {timeline.length === 0 && <li className="muted small">No events: it runs the design as it is.</li>}
          {timeline.map((e, i) => (
            <li key={i} data-done={e.done || undefined} data-kind={e.kind}>
              <span className="when">{fmtTime(e.at)}</span>
              <Icon name={e.kind === "inject" ? "bolt" : e.kind === "clear" ? "check" : e.kind === "note" ? "info" : "reload"} size={12} />
              <span className="what">{e.what}</span>
            </li>
          ))}
        </ol>
        <ul className="scenario-checks">
          {checks.length === 0 && <li className="muted small">No checks: nothing to pass or fail.</li>}
          {checks.map((c, i) => (
            <li key={i} data-state={c.state} title={STATE_LABEL[c.state]}>
              <span className="check-mark">
                <Icon name={c.state === "passed" || c.state === "holding" ? "check" : c.state === "waiting" ? "dot" : "x"} size={12} />
              </span>
              <span className="check-text">
                <b>{c.name ?? c.check}</b>
                {c.name !== undefined && <code>{c.check}</code>}
              </span>
              <span className="check-window">
                {fmtTime(c.window.from)}–{fmtTime(c.window.to)}
              </span>
              <span className="check-value">
                {c.actual === undefined ? "—" : fmtUnit(c.unit, c.actual)}
                <i>
                  {" "}
                  {c.expected.op} {fmtUnit(c.unit, c.expected.value)}
                </i>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
