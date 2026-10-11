// Monaco with only what the editor needs: the editor's features and YAML (no other languages, no TypeScript service).
import "monaco-editor/features/register.all"
import "monaco-editor/languages/definitions/yaml/register"
import * as monaco from "monaco-editor/editor/editor.api"
import EditorWorker from "monaco-editor/editor/editor.worker?worker"
// @ts-expect-error: Monaco ships this module without types; its signature is the legacy `editor.createWebWorker`'s.
import { createWebWorker as createLabelledWorker } from "monaco-editor/internal/common/workers"
import { configureMonacoYaml } from "monaco-yaml"
import type { DesignSchema } from "#simulator"
import YamlWorker from "./yaml.worker.ts?worker"

/**
 * Monaco, set up once: its workers, a theme that matches the app, and the YAML language server pointed at the design
 * schema, the same one VS Code reads from a design file's first line. The schema is handed over as an object, so
 * nothing is fetched.
 */

globalThis.MonacoEnvironment = {
  getWorker: (_id: string, label: string) => (label === "yaml" ? new YamlWorker() : new EditorWorker())
}

monaco.editor.defineTheme("infra-sim", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "type", foreground: "8cc0ff" },
    { token: "string", foreground: "9fd7b8" },
    { token: "number", foreground: "f4c26b" },
    { token: "keyword", foreground: "c49bf5" },
    { token: "comment", foreground: "5a6579", fontStyle: "italic" }
  ],
  colors: {
    "editor.background": "#0c1016",
    "editor.foreground": "#e3e9f3",
    "editor.lineHighlightBackground": "#121822",
    "editor.lineHighlightBorder": "#00000000",
    "editorLineNumber.foreground": "#39455a",
    "editorLineNumber.activeForeground": "#8995a8",
    "editorGutter.background": "#0c1016",
    "editor.selectionBackground": "#2a4a78",
    "editorIndentGuide.background1": "#1a212c",
    "editorWidget.background": "#161c26",
    "editorWidget.border": "#2c3647",
    "editorSuggestWidget.background": "#161c26",
    "editorSuggestWidget.border": "#2c3647",
    "editorSuggestWidget.selectedBackground": "#22304a",
    "editorHoverWidget.background": "#161c26",
    "editorHoverWidget.border": "#2c3647",
    "scrollbarSlider.background": "#2a334288"
  }
})

export const DESIGN_MODEL = monaco.Uri.parse("file:///design.yaml")

/**
 * Since Monaco 0.56, `editor.createWebWorker` takes a ready worker. monaco-yaml still asks for one by label (`yaml`) with
 * data to start it with, the older form. Monaco keeps that form for its own languages (JSON, CSS) in an internal module,
 * which finds the worker through `MonacoEnvironment.getWorker` by label and sends it the data; monaco-yaml gets that.
 */
const withLabelledWorkers: typeof monaco = {
  ...monaco,
  editor: { ...monaco.editor, createWebWorker: createLabelledWorker as typeof monaco.editor.createWebWorker }
}

let yaml: ReturnType<typeof configureMonacoYaml> | undefined

/** Point the language server at the schema (again, when the components change). */
export const applySchema = (schema: DesignSchema.JsonSchema, url: string): void => {
  const options = {
    enableSchemaRequest: false,
    hover: true,
    completion: true,
    validate: true,
    schemas: [{ uri: url, fileMatch: [DESIGN_MODEL.toString()], schema: schema as never }]
  }
  if (yaml === undefined) yaml = configureMonacoYaml(withLabelledWorkers, options)
  else void yaml.update(options)
}

export { monaco }
