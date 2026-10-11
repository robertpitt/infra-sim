import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  // Relative asset paths, so `dist/` works from any URL: the root of a domain, a sub-path, a file server.
  base: "./",
  plugins: [react()],
  build: { target: "es2023" },
  // The engine runs in a module worker (src/ui/state/engine.worker.ts).
  worker: { format: "es" }
})
