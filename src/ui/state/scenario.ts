import { designOf, parseScenario } from "#examples"
import { Scenario } from "#simulator"
import { createStore } from "../lib/store.ts"
import { addScenario, doc, removeScenario } from "./document.ts"
import { client } from "./engine.ts"
import { pickFile, say } from "./files.ts"
import { run } from "./run.ts"
import { setDockTab } from "./ui.ts"

/**
 * Playing scenarios. A design carries the scenarios written for it (its `scenarios` section), so the scenario tab lists
 * the ones in the design that is open. The engine does the playing (events at their times, checks measured, a pause at
 * the end); the UI hands one over and shows how it goes.
 */

/** The id of the design's scenario that is playing, if one is. */
export const playing = createStore<string | undefined>(undefined)

// The engine stopped playing it (stopped, or dropped because the design no longer has what it names).
let armed = false
run.subscribe(() => {
  const now = run.get().scenario !== undefined
  if (armed && !now) playing.set(undefined)
  armed = now
})

/** Play one of the design's scenarios from t = 0. */
export const playScenario = (id: string): void => {
  const scenario = doc.get().design.scenarios?.[id]
  if (scenario === undefined) return
  client.send({ _tag: "scenario", scenario: { version: 1, ...scenario } })
  client.send({ _tag: "play" })
  playing.set(id)
  setDockTab("scenario")
}

/** Play the current scenario again from the start. */
export const restartScenario = (): void => {
  client.send({ _tag: "reset" })
  client.send({ _tag: "play" })
}

export const stopScenario = (): void => {
  if (run.get().scenario !== undefined) client.send({ _tag: "clearScenario" })
  playing.set(undefined)
}

/** Take a scenario out of the design (undoable), stopping it first if it is the one playing. */
export const deleteScenario = (id: string): void => {
  if (playing.get() === id) stopScenario()
  removeScenario(id)
}

/**
 * Scenario ▸ Add from file: a scenario file (with or without the `design:` it was written for) becomes one of this
 * design's scenarios, if it fits: everything it names must be here.
 */
export const importScenarioDialog = async (): Promise<void> => {
  const file = await pickFile(".yaml,.yml,.json,application/json,application/yaml")
  if (file === undefined) return
  let parsed: Scenario.Scenario
  try {
    parsed = parseScenario(await file.text())
  } catch (error) {
    return say(`Couldn't read ${file.name} as a scenario: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`, 6000)
  }
  const { version: _version, design: named, ...scenario } = parsed
  const problems = Scenario.check(doc.get().design, scenario)
  if (problems.length > 0) {
    const elsewhere = designOf(parsed)
    const hint = elsewhere !== undefined ? ` It was written for the ${elsewhere.title} example: open that and add it there.` : typeof named === "string" ? ` It was written for ${named}.` : ""
    return say(`${file.name} doesn't fit this design: ${problems.slice(0, 2).join("; ")}.${hint}`, 8000)
  }
  const id = addScenario(scenario)
  setDockTab("scenario")
  say(`Added "${scenario.name ?? id}" to this design's scenarios`)
}
