#!/usr/bin/env node
import { main } from "./cli.ts"
import { nodeIO } from "./io.ts"

// A reader that stops early (`| head`) closes the pipe: that is not an error worth a stack trace.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(process.exitCode ?? 0)
  throw e
})

// Exit with the code `main` returns, after stdout has drained, so piped output is never cut off.
const code = await main(process.argv.slice(2), nodeIO())
process.exitCode = code
