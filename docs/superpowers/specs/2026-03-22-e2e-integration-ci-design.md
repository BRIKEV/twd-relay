# E2E Integration Test in CI via Vite Plugin

## Problem

The example app imports `createBrowserClient` from a hardcoded `../../../dist/browser.es.js` path and connects to a standalone relay on port 9876. The existing CI script (`run-tests-ci.js`) uses puppeteer directly with `window.__testRunner`, bypassing twd-relay entirely. There is no CI job that exercises the full twd-relay pipeline (Vite plugin → browser client → relay → CLI).

## Goal

Add an E2E integration test that validates the complete twd-relay flow before releases, catching regressions in the relay, browser client, Vite plugin, and CLI (including the `--test` flag).

## Architecture

The React example app (`examples/twd-test-app`) switches from standalone relay to the Vite plugin. A new Node orchestrator script manages the full test lifecycle: starts Vite dev server, opens a headless browser, runs `twd-relay run` CLI, and reports results. A new GitHub Actions workflow runs this on every push/PR.

## Design

### 1. Example app — switch to Vite plugin

**`examples/twd-test-app/package.json`** — add `twd-relay` as a file dependency:
```json
"devDependencies": {
  "twd-relay": "file:../../"
}
```
This lets the example import from `twd-relay/browser` and `twd-relay/vite` like a real consumer. Requires twd-relay to be built first.

Add script:
```json
"test:e2e": "node scripts/run-e2e.js"
```

**`examples/twd-test-app/vite.config.ts`** — add the Vite plugin:
```ts
import { twdRelay } from 'twd-relay/vite'

export default defineConfig({
  plugins: [
    react(),
    twdRelay(),
    istanbul({ ... }),
  ],
})
```

This attaches the relay to the Vite dev server on the default path `/__twd/ws`.

**`examples/twd-test-app/src/main.tsx`** — switch from hardcoded dist import to package import:
```ts
const { createBrowserClient } = await import('twd-relay/browser');
const client = createBrowserClient();  // auto-detects ws://localhost:5173/__twd/ws
client.connect();
```

No more standalone relay — everything runs through the Vite dev server on port 5173.

### 2. Orchestrator script — `examples/twd-test-app/scripts/run-e2e.js`

A Node script that manages the full lifecycle:

1. **Spawn Vite dev server** as a child process (`npm run dev`)
2. **Poll `http://localhost:5173`** until it responds (timeout 30s)
3. **Launch puppeteer** headless, navigate to `http://localhost:5173` — browser client auto-connects to relay
4. **Wait** for twd-js to initialize and register test handlers
5. **Run pass 1:** spawn `twd-relay run` CLI (from `../../dist/cli.js`), pipe stdout/stderr to parent. Captures exit code — 0 means all tests pass, 1 means failures.
6. **Run pass 2:** spawn `twd-relay run --test "<known test name>"` to validate the `--test` flag end-to-end. Pick a known test name from the example's test files.
7. **Cleanup:** close puppeteer, kill Vite process, exit with combined result (fail if either pass failed)

**Error handling:**
- Vite doesn't start within 30s → exit 1
- Puppeteer fails to launch → kill Vite, exit 1
- CLI times out (built-in 180s timeout) → exit 1
- Always cleanup child processes in a `finally` block

### 3. CI workflow — `.github/workflows/e2e.yml`

New workflow, separate from existing `ci.yml`:

```yaml
name: E2E Integration

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  e2e:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [22, 24]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: cd examples/twd-test-app && npm install
      - run: cd examples/twd-test-app && npm run test:e2e
```

Flow: build twd-relay → install example deps (links `twd-relay` via `file:../../`) → run orchestrator → report results.

Puppeteer downloads its own Chromium during `npm install` in the example (already a devDependency).

### 4. What the E2E validates

| Pass | Command | Validates |
|------|---------|-----------|
| 1 | `twd-relay run` | Full pipeline: Vite plugin → relay → browser client → twd-js runner → events → CLI output → exit code |
| 2 | `twd-relay run --test "<name>"` | `--test` flag filters by name substring end-to-end |

If either pass exits non-zero, the script fails.

## Files changed

| File | Change |
|------|--------|
| `examples/twd-test-app/package.json` | Add `twd-relay: "file:../../"` dep, add `test:e2e` script |
| `examples/twd-test-app/vite.config.ts` | Add `twdRelay()` plugin |
| `examples/twd-test-app/src/main.tsx` | Import from `twd-relay/browser` instead of dist path |
| `examples/twd-test-app/scripts/run-e2e.js` | New orchestrator script |
| `.github/workflows/e2e.yml` | New workflow |

## Files NOT changed

| File | Reason |
|------|--------|
| `.github/workflows/ci.yml` | Existing CI stays untouched |
| `examples/vue-twd-example/*` | Doesn't use twd-relay |
| `examples/twd-test-app/scripts/run-tests-ci.js` | Existing puppeteer script stays for its own CI job |
