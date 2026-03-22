# E2E Integration CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an E2E integration test that exercises the full twd-relay pipeline (Vite plugin → relay → browser client → CLI) in CI, including the `--test` flag.

**Architecture:** Switch the React example app from standalone relay to the Vite plugin. A Node orchestrator script starts Vite, opens a headless browser, runs the CLI twice (full run + filtered run), and reports results. A new GitHub Actions workflow runs this on push/PR.

**Tech Stack:** Node.js, puppeteer, Vite, twd-relay CLI, GitHub Actions

**Spec:** `docs/superpowers/specs/2026-03-22-e2e-integration-ci-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `examples/twd-test-app/package.json` | Modify | Add `twd-relay` file dep, add `test:e2e` script |
| `examples/twd-test-app/vite.config.ts` | Modify | Add `twdRemote()` Vite plugin |
| `examples/twd-test-app/src/main.tsx` | Modify | Import from `twd-relay/browser` instead of dist path |
| `examples/twd-test-app/scripts/run-e2e.js` | Create | Orchestrator: Vite + puppeteer + CLI lifecycle |
| `.github/workflows/e2e.yml` | Create | New CI workflow |

---

### Task 1: Example app — add twd-relay dependency and Vite plugin

**Files:**
- Modify: `examples/twd-test-app/package.json`
- Modify: `examples/twd-test-app/vite.config.ts`

- [ ] **Step 1: Add `twd-relay` as a file dependency**

In `examples/twd-test-app/package.json`, add to `devDependencies`:

```json
"twd-relay": "file:../../"
```

And add to `scripts`:

```json
"test:e2e": "node scripts/run-e2e.js"
```

- [ ] **Step 2: Add `twdRemote()` plugin to Vite config**

In `examples/twd-test-app/vite.config.ts`, add the import and plugin. The full file:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import istanbul from 'vite-plugin-istanbul';
import { twdRemote } from 'twd-relay/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    twdRemote(),
    // configure istanbul plugin
    istanbul({
      include: 'src/**/*',
      exclude: ['node_modules', 'dist', 'twd-tests/**'],
      extension: ['.ts', '.tsx'],
      requireEnv: process.env.CI ? true : false,
    }),
  ],
})
```

- [ ] **Step 3: Commit**

```bash
git add examples/twd-test-app/package.json examples/twd-test-app/vite.config.ts
git commit -m "feat: add twd-relay Vite plugin to example app"
```

---

### Task 2: Example app — switch browser client import

**Files:**
- Modify: `examples/twd-test-app/src/main.tsx:28-34`

- [ ] **Step 1: Replace the hardcoded dist import**

In `examples/twd-test-app/src/main.tsx`, replace lines 28-34:

```ts
  // Browser client: connects to the relay and runs tests when it receives a "run" command.
  // To trigger a run, use a client (e.g. from repo root: npm run send-run).
  const { createBrowserClient } = await import('../../../dist/browser.es.js');
  const client = createBrowserClient({
    url: 'ws://localhost:9876/__twd/ws',
  });
  client.connect();
```

With:

```ts
  // Browser client: connects to the relay via the Vite plugin.
  // To trigger a run: npx twd-relay run (or node ../../dist/cli.js run)
  const { createBrowserClient } = await import('twd-relay/browser');
  const client = createBrowserClient();
  client.connect();
```

The `createBrowserClient()` with no args auto-detects the WebSocket URL from `window.location`, which will be `ws://localhost:5173/__twd/ws` when running the Vite dev server.

- [ ] **Step 2: Install dependencies in example**

Run from repo root (twd-relay must be built first):

```bash
npm run build && cd examples/twd-test-app && npm install
```

Expected: installs cleanly, `twd-relay` symlinked from `file:../../`.

- [ ] **Step 3: Verify the example app starts**

```bash
cd examples/twd-test-app && npx vite --host localhost &
sleep 5
curl -s http://localhost:5173 | head -20
kill %1
```

Expected: HTML response from the Vite dev server. This confirms the Vite plugin loads and the imports resolve.

- [ ] **Step 4: Commit**

```bash
git add examples/twd-test-app/src/main.tsx
git commit -m "feat: switch example app to twd-relay/browser package import"
```

---

### Task 3: Orchestrator script

**Files:**
- Create: `examples/twd-test-app/scripts/run-e2e.js`

- [ ] **Step 1: Create the orchestrator script**

Create `examples/twd-test-app/scripts/run-e2e.js`:

```js
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_DIR = path.resolve(__dirname, '..');
const CLI_PATH = path.resolve(PROJECT_DIR, '../../dist/cli.js');
const VITE_PORT = 5173;
const VITE_URL = `http://localhost:${VITE_PORT}`;
const POLL_INTERVAL = 500;
const VITE_TIMEOUT = 30_000;
const INIT_WAIT = 5_000;

// --- Helpers ---

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForServer(url, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await sleep(POLL_INTERVAL);
  }
  throw new Error(`Server at ${url} did not start within ${timeout}ms`);
}

function runCli(args = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [CLI_PATH, 'run', ...args], {
      stdio: 'inherit',
      cwd: PROJECT_DIR,
    });

    proc.on('close', (code) => {
      resolve(code);
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

// --- Main ---

let viteProc = null;
let browser = null;
let exitCode = 0;

try {
  // 1. Start Vite dev server
  console.log('Starting Vite dev server...');
  viteProc = spawn('npx', ['vite', '--host', 'localhost'], {
    cwd: PROJECT_DIR,
    stdio: 'pipe',
  });

  viteProc.stdout.on('data', (data) => {
    const line = data.toString().trim();
    if (line) console.log(`[vite] ${line}`);
  });

  viteProc.stderr.on('data', (data) => {
    const line = data.toString().trim();
    if (line) console.error(`[vite] ${line}`);
  });

  // 2. Wait for Vite to be ready
  console.log(`Waiting for Vite at ${VITE_URL}...`);
  await waitForServer(VITE_URL, VITE_TIMEOUT);
  console.log('Vite is ready.');

  // 3. Launch puppeteer and navigate
  console.log('Launching headless browser...');
  browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.goto(VITE_URL, { waitUntil: 'networkidle0', timeout: 30_000 });

  // 4. Wait for twd-js to initialize
  console.log(`Waiting ${INIT_WAIT / 1000}s for twd-js to initialize...`);
  await sleep(INIT_WAIT);

  // 5. Pass 1: run all tests
  console.log('\n=== Pass 1: Run all tests ===\n');
  const code1 = await runCli();
  if (code1 !== 0) {
    console.error(`\nPass 1 FAILED (exit code ${code1})`);
    exitCode = 1;
  } else {
    console.log('\nPass 1 PASSED.\n');

    // Need to wait briefly between runs for relay lock to clear
    await sleep(1000);

    // 6. Pass 2: run filtered test
    console.log('=== Pass 2: Run filtered test (--test "clicks the button") ===\n');
    const code2 = await runCli(['--test', 'clicks the button']);
    if (code2 !== 0) {
      console.error(`\nPass 2 FAILED (exit code ${code2})`);
      exitCode = 1;
    } else {
      console.log('\nPass 2 PASSED.\n');
      console.log('All E2E passes succeeded!');
    }
  }

} catch (err) {
  console.error('E2E script error:', err.message);
  exitCode = 1;
} finally {
  // 7. Cleanup
  if (browser) {
    await browser.close().catch(() => {});
  }
  if (viteProc) {
    viteProc.kill('SIGTERM');
  }
}

process.exit(exitCode);
```

- [ ] **Step 2: Test the orchestrator locally**

From repo root (twd-relay must be built):

```bash
cd examples/twd-test-app && node scripts/run-e2e.js
```

Expected: Vite starts, browser opens, Pass 1 runs all tests and passes, Pass 2 runs filtered test and passes, script exits 0.

- [ ] **Step 3: Commit**

```bash
git add examples/twd-test-app/scripts/run-e2e.js
git commit -m "feat: add E2E orchestrator script for twd-relay integration test"
```

---

### Task 4: GitHub Actions workflow

**Files:**
- Create: `.github/workflows/e2e.yml`

- [ ] **Step 1: Create the workflow file**

Create `.github/workflows/e2e.yml`:

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

      - name: Use Node.js ${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: npm

      - name: Install root dependencies
        run: npm ci

      - name: Build twd-relay
        run: npm run build

      - name: Install example dependencies
        run: cd examples/twd-test-app && npm install

      - name: Run E2E integration tests
        run: cd examples/twd-test-app && npm run test:e2e
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/e2e.yml
git commit -m "ci: add E2E integration workflow for twd-relay"
```

---

### Task 5: Local smoke test and cleanup

- [ ] **Step 1: Run twd-relay unit tests**

```bash
npx vitest run
```

Expected: All 26 tests pass (no regressions from example changes).

- [ ] **Step 2: Run the full E2E locally**

From repo root:

```bash
npm run build && cd examples/twd-test-app && npm install && npm run test:e2e
```

Expected: Both passes succeed, script exits 0.

- [ ] **Step 3: Fix any issues and commit if needed**

Only if fixes were required.
