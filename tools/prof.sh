#!/bin/bash
# Profile a benchmark and show where the time goes, by source line.
#   tools/prof.sh <example-id> <virtual-ms> <traffic-scale>           profiles tools/bench.ts
#   BENCH=tools/bench-components.ts tools/prof.sh <component-case>    profiles something else
#   TOP=40 CALLERS="Hash.ts:108" tools/prof.sh ...                    rows to show; who calls a function
# Bundles with sourcemaps (so profile frames map back to src/), runs under --cpu-prof, then attributes self time.
set -e
cd "$(dirname "$0")/.."
OUT=.tmp/prof
rm -rf "$OUT" && mkdir -p "$OUT"
npx esbuild "${BENCH:-tools/bench.ts}" --bundle --platform=node --format=esm --sourcemap=external --outfile="$OUT/bundle.mjs" --log-level=error \
  --banner:js="import {createRequire} from 'module';const require=createRequire(import.meta.url);"
node --cpu-prof --cpu-prof-dir="$OUT" "$OUT/bundle.mjs" "$@" | tail -1
node tools/prof-map.mjs "$OUT"/*.cpuprofile "$OUT/bundle.mjs.map" "${TOP:-35}"
