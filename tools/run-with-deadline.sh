#!/bin/zsh
# usage: run-with-deadline.sh <seconds> <command...>  — kills the whole process group when the deadline passes
secs=$1; shift
"$@" &
pid=$!
( sleep $secs; kill -9 $pid 2>/dev/null; pkill -9 -P $pid 2>/dev/null; pkill -9 -f "workers/forks.js" 2>/dev/null ) &
killer=$!
wait $pid; code=$?
kill $killer 2>/dev/null
exit $code
