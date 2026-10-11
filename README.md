# infra-sim

Simulate cloud infrastructure under traffic and faults. Draw a design (clients, API Gateway, Lambda, SQS, SNS, DynamoDB, S3, regions, external HTTP services), press play, and watch where it scales, where it pushes back, and where it falls over: throttling cascades, retry storms, redelivery loops, regional outages. AWS first, using AWS's published limits (each one marked **hard**, an adjustable **quota**, or **assumed**), with the structure to add other providers.

The engine is pure [Effect](https://effect.website) (`src/simulator`, no DOM) and runs in a Web Worker in the browser; the UI (`src/ui`) is a client of it. How it works, and why it is fast: [SIMULATOR.md](SIMULATOR.md). Where every number comes from: [docs/AWS-LIMITS.md](docs/AWS-LIMITS.md).

## Quick start

Needs Node 22 or newer (`.nvmrc` pins 22).

```sh
npm install
npm run dev        # http://localhost:5173
```

| Command | |
| --- | --- |
| `npm run dev` | The app with hot reload. Editing a component restarts the running simulation with the same design. |
| `npm run build` | Cleans and builds the app to `dist/`: static files with relative paths, so they work from any URL. |
| `npm run preview` | Serves `dist/` locally. |
| `npm test` | The test suite (vitest). |
| `npm run typecheck` | Type-checks the engine (with no DOM types) and the app. |
| `npm run bench -- poshub 60000 10` | CPU cost of simulating an example, at a multiple of its traffic. See `tools/`. |

## Deployment

Every push to `main` runs the typecheck and tests, builds the app, and publishes `dist/` to GitHub Pages ([`.github/workflows/pages.yml`](.github/workflows/pages.yml)): https://robertpitt.github.io/infra-sim/. One-time setup: in the repository's **Settings → Pages**, set **Source** to **GitHub Actions**.

## Designs are files

A design is YAML or JSON. The [`examples/`](examples) folder holds the ones that ship with the app, and the app opens and saves the same format (File menu).

```yaml
version: 1
name: Order pipeline
description: Clients call an API that runs a function.   # the first paragraph is the blurb
seed: 7                         # the same design and seed always play out identically
nodes:
  web:
    type: common.client
    position: {x: 0, y: 60}
    settings: {rps: 120}        # only what you change; the rest takes the documented default
  eu:
    type: aws.region            # a box: whatever is inside runs in this region
    position: {x: 300, y: 0}
    size: {w: 760, h: 240}
    settings: {region: eu-west-1}
  api:
    type: aws.apigateway
    parent: eu
    position: {x: 330, y: 60}
    settings: {apiType: http}
  handler:
    type: aws.lambda
    parent: eu
    position: {x: 700, y: 60}
    settings: {memory: 512, duration: {mean: 80}}
edges:
  web-api: {from: {node: web}, to: api, settings: {retry: {maxAttempts: 3}}}
  api-handler: {from: {node: api}, to: handler}
```

Add a file to `examples/` (a numeric prefix sets the order) and it appears in the app. Settings are validated against each component's schema, with every problem reported by its location, e.g. `nodes.api.settings.apiType`.

## Layout

```
src/simulator/   the engine: pure Effect, no DOM. Components, edges, faults, virtual time, the Engine protocol
src/ui/          the React app: canvas, sidebar, charts. Runs the engine in a worker (src/ui/state/engine.worker.ts)
src/examples/    loads examples/*.yaml for the app and tests
examples/        the example designs
docs/            AWS limits, with sources
tools/           benchmarks, profiler, headless UI checks
```

Repository: `git@robertpitt1988:robertpitt/infra-sim.git`
