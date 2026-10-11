import react from "@vitejs/plugin-react"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"

export default defineConfig({
  // Relative asset paths, so `dist/` works from any URL: the root of a domain, a sub-path, a file server.
  base: "./",
  plugins: [react()],
  build: { target: "es2023" },
  resolve: {
    alias: [
      // monaco-yaml's worker imports `monaco-editor/esm/vs/...`, a path Monaco 0.57's exports map no longer opens.
      { find: /^monaco-editor\/esm\/vs\/(.*)$/, replacement: `${fileURLToPath(new URL("./node_modules/monaco-editor/esm/vs/", import.meta.url))}$1` }
    ]
  },
  // The engine runs in a module worker (src/ui/state/engine.worker.ts).
  worker: { format: "es" }
})
