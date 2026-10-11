import { designOf, parseScenario, type ScenarioExample } from "#examples"
import type { ScenarioDoc } from "./types.ts"
import { client } from "./engine.ts"
import { openDesign, pickFile, say } from "./files.ts"
import { run } from "./run.ts"
import { setDockTab } from "./ui.ts"

/**
 * Playing scenarios. The engine does the playing (events at their times, checks measured, a pause at the end); the UI
 * picks the design a scenario was written for, hands the scenario over, and shows how it goes.
 */

/**
 * Play `scenario` from t = 0. A scenario that names a design that ships with the app opens that design first; one that
 * carries its own design opens that; otherwise it plays against the design on the canvas.
 */
export const playScenario = (scenario: ScenarioDoc, fileName?: string): void => {
  const { design: named, ...rest } = scenario
  if (typeof named === "object") {
    if (!openDesign(named)) return
  } else if (typeof named === "string") {
    const example = designOf(scenario)
    if (example !== undefined) {
      if (!openDesign(example.design())) return
    } else say(`${fileName ?? "The scenario"} names ${named}, which isn't open here: playing it against this design`, 6000)
  }
  // The design is already on its way to the engine; the scenario follows it.
  client.send({ _tag: "scenario", scenario: rest })
  client.send({ _tag: "play" })
  setDockTab("scenario")
}

export const playExample = (example: ScenarioExample): void => playScenario(example.scenario())

/** Scenario ▸ Open: a scenario file from disk. */
export const openScenarioDialog = async (): Promise<void> => {
  const file = await pickFile(".yaml,.yml,.json,application/json,application/yaml")
  if (file === undefined) return
  try {
    playScenario(parseScenario(await file.text()), file.name)
  } catch (error) {
    say(`Couldn't read ${file.name} as a scenario: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`, 6000)
  }
}

/** Play the current scenario again from the start. */
export const restartScenario = (): void => {
  client.send({ _tag: "reset" })
  client.send({ _tag: "play" })
}

export const stopScenario = (): void => {
  if (run.get().scenario !== undefined) client.send({ _tag: "clearScenario" })
}
