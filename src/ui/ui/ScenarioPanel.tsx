import { Check, Scenario } from "#simulator"
import { fmtTime, fmtUnit } from "../lib/format.ts"
import { useStore } from "../lib/store.ts"
import { doc } from "../state/document.ts"
import { run } from "../state/run.ts"
import { deleteScenario, importScenarioDialog, playScenario, restartScenario, stopScenario } from "../state/scenario.ts"
import type { CheckProgress, ScenarioProgress } from "../state/types.ts"
import { Icon } from "./Icon.tsx"

/**
 * Scenarios: a timeline of what goes wrong (and what changes) played against the design, with checks on what must hold.
 * They are part of the design (its `scenarios` section), so this lists the ones the open design carries; with one
 * playing it shows where the run is, what has happened and what is coming, and how each check is doing, live, until the
 * run stops at the end with a verdict.
 */
export function ScenarioPanel() {
  const progress = useStore(run, (s) => s.scenario)
  return progress === undefined ? <Picker /> : <Playing progress={progress} />
}

function Picker() {
  const design = useStore(doc, (s) => s.design)
  // A scenario names nodes and edges: after an edit, one may no longer fit, and says why.
  const entries = Scenario.ofDesign(design).map(([id, spec]) => ({ id, spec, problems: Scenario.check(design, spec) }))
  return (
    <div className="scenario-picker">
      <div className="scenario-intro">
        <p className="muted small">
          Scenarios are saved with the design, under <code>scenarios</code>: a timeline of faults and changes, and checks like <code>api.errorRatio &lt; 1%</code>.
          The same ones run in CI with <code>infra-sim run design.yaml --scenario &lt;id&gt;</code>.
        </p>
        <button className="btn small" onClick={() => void importScenarioDialog()}>
          <Icon name="upload" size={13} /> Add from file…
        </button>
      </div>
      {entries.length === 0 ? (
        <p className="scenario-none muted small">
          This design has no scenarios yet. Add one from a scenario file, or write one into the design's YAML under <code>scenarios:</code>. The Order pipeline and
          Multi-region examples carry some to start from.
        </p>
      ) : (
        <div className="scenario-cards">
          {entries.map(({ id, spec, problems }) => {
            const duration = Check.parseDuration(spec.duration)
            return (
              <div className="scenario-card" key={id} data-broken={problems.length > 0 || undefined}>
                <div className="scenario-card-head">
                  <b title={id}>{spec.name ?? id}</b>
                  <span className="spacer" />
                  <button className="icon-btn" title="Remove from the design" onClick={() => deleteScenario(id)}>
                    <Icon name="trash" size={13} />
                  </button>
                  <button className="btn small primary" disabled={problems.length > 0} onClick={() => playScenario(id)}>
                    <Icon name="play" size={12} /> Run
                  </button>
                </div>
                {spec.description !== undefined && <p>{spec.description.split(/\n\s*\n/)[0]}</p>}
                {problems.length > 0 ? (
                  <p className="scenario-problem">
                    <Icon name="warn" size={12} /> {problems[0]}
                    {problems.length > 1 ? ` (and ${problems.length - 1} more)` : ""}
                  </p>
                ) : (
                  <span className="muted small">
                    {duration === undefined ? "?" : fmtTime(duration)} · {spec.timeline?.length ?? 0} events · {spec.assert?.length ?? 0} checks
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
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
