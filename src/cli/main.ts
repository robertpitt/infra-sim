#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Exit, Runtime } from "effect"
import { program } from "./cli.ts"
import { nodeIO } from "./io.ts"

// A reader that stops early (`| head`) closes the pipe: that is not an error worth a stack trace.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(process.exitCode ?? 0)
  throw e
})

// Exit with the code the program returns, after stdout has drained (so piped output is never cut off): set `process.exitCode`
// and let the process end by itself instead of calling `process.exit`.
NodeRuntime.runMain(program(process.argv.slice(2), nodeIO()).pipe(Effect.provide(NodeServices.layer)), {
  teardown: (exit, onExit) => {
    if (!Exit.isSuccess(exit)) return Runtime.defaultTeardown(exit, onExit)
    process.exitCode = typeof exit.value === "number" ? exit.value : 0
    onExit(0)
  }
})
