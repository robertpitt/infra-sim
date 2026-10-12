#!/bin/zsh
# usage: run-with-deadline.sh <seconds> <command...>  — kills the command and everything it started when the deadline passes.
# Only this command's own process tree: several runs (other terminals, agents) may be going at once, and must not be hit.
secs=$1; shift
"$@" &
pid=$!
# Every descendant of a process, deepest first (vitest's workers are grandchildren of npx).
descendants() { local child; for child in $(pgrep -P $1); do descendants $child; echo $child; done }
# The killer's output goes nowhere: its `sleep` would otherwise hold a pipe (`... | tail`) open until the deadline.
( sleep $secs; for p in $(descendants $pid) $pid; do kill -9 $p 2>/dev/null; done ) > /dev/null 2>&1 &
killer=$!
wait $pid; code=$?
kill $killer 2>/dev/null
exit $code
