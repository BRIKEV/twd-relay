# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build       # Build all entry points (relay, browser, vite) + CLI
npm run test        # Run tests in watch mode (vitest)
npm run test:ci     # Run tests with coverage
```

To run a single test file:
```bash
npx vitest run src/tests/relay/createTwdRelay.spec.ts
```

The build has two stages: `vite build` for the three library entry points (ESM+CJS), then `vite build -c vite.cli.config.ts` for the CLI (ESM only, node18 target). A postbuild script injects `#!/usr/bin/env node` into `dist/cli.js`.

## Architecture

twd-relay is a WebSocket relay that lets AI agents and external tools trigger and observe browser test runs powered by [twd-js](https://github.com/nicolo-ribaudo/twd-js). It has three entry points:

**Relay Server** (`src/relay/`, exported as `twd-relay`) — A WebSocket server that attaches to an HTTP server. It manages exactly one browser connection and many client connections. Clients send commands (`run`, `status`); the relay forwards them to the browser. The browser sends test lifecycle events (`test:start`, `test:pass`, `test:fail`, `run:complete`, etc.); the relay broadcasts them to all clients. A `runInProgress` lock prevents concurrent test runs.

**Browser Client** (`src/browser/`, exported as `twd-relay/browser`) — Runs in the browser. Connects to the relay, listens for commands, dynamically imports `twd-js/runner` to execute tests, and streams results back. Uses native browser `WebSocket` with auto-reconnect. Reads test state from `window.__TWD_STATE__` (set by twd-js). A small `faviconManager` (in `src/browser/faviconManager.ts`) sets a colored favicon + `document.title` prefix based on connection/run state so the active TWD tab is identifiable among multiple tabs to the same origin. A sibling `runMonitor` (in `src/browser/runMonitor.ts`) tracks per-test wall-clock time; on the 3 s heartbeat tick AND at the end of every test, the browser checks whether the test exceeded `maxTestDurationMs` (default 10 s) and, if so, emits a `run:aborted` event so the CLI can exit with a clear error instead of hanging on a throttled tab. A third helper, `diagnostics.ts`, renders the failure-diagnostics block twd-js attaches to a failed test and composes it above the error message on `test:fail`.

**Vite Plugin** (`src/vite/`, exported as `twd-relay/vite`) — A Vite plugin that hooks into `configureServer` to attach the relay to the dev server's HTTP instance, and (in `apply: 'serve'` mode) auto-injects a `<script type="module">` that imports `createBrowserClient` and calls `.connect()` via a virtual module (`virtual:twd-relay/connect`). Auto-injection is on by default; set `autoConnect: false` to opt out and wire `createBrowserClient` manually (required for non-Vite consumers). Both the relay-server path and the injected client path use the same formula (`options.path ?? base + '/__twd/ws'`); `configResolved` sets the `base` for both.

**CLI** (`src/cli/`, bin: `twd-relay`) — Two subcommands: `serve` (default) starts a standalone HTTP server with the relay on port 9876; `run` connects to an existing relay as a client, sends a `run` command, stays silent during the run, and prints a single summary block at the end (passed/failed/skipped counts plus failure details) before exiting with code 0/1. The `run` subcommand defaults to port 5173 (Vite dev server) and has a 180s timeout. Use `--test "name"` (repeatable) to filter tests by name substring match. The output format is optimised for AI-agent consumption — every line printed costs context tokens.

### Message protocol flow

1. Browser connects with `{ type: 'hello', role: 'browser' }`
2. Clients connect with `{ type: 'hello', role: 'client' }`
3. Client sends `{ type: 'run', scope: 'all' }` (optionally with `testNames: string[]` for filtered runs) → relay forwards to browser
4. Browser streams test events → relay broadcasts to all clients
5. `run:complete` clears the run lock

### Manual testing (standalone relay)

Three pieces work together: (1) **relay server** — one WebSocket server; (2) **browser** — your app loads the browser client and connects to the relay, then waits for commands; (3) **client** — something that connects to the relay and sends `run` (e.g. an AI agent or the `send-run` script). Your app’s `main.tsx` only enables the browser side; to trigger a run you need a client that sends the command.

From repo root:

1. **Start the relay** (builds and runs on port 9876):  
   `npm run relay`
2. **Start the example app** (any port):  
   `cd examples/twd-test-app && npm run dev`
3. **Open the app in a browser** — the page connects to the relay as “browser”.
4. **Trigger a run** from another terminal:  
   `npm run send-run`  
   (or `node scripts/send-run.js --port 9876`). The script connects as a client and sends `run`; you’ll see test events in the terminal.

## Key Design Decisions

- `twd-js` is a **peer dependency**; the browser client uses `await import('twd-js/runner')` to avoid bundling it
- `vite` is an **optional peer dependency**; the Vite plugin defines an inline `VitePlugin` interface instead of importing from `vite` to avoid dts resolution issues
- `moduleResolution: "Bundler"` in tsconfig is required for subpath exports like `twd-js/runner`
- Use `import { type RawData } from 'ws'` (not `WebSocket.RawData` namespace access) for ESM/CJS compat
- Build externals: `ws`, `http`, `stream`, `vite`, `twd-js`, `twd-js/runner`
- `src/browser/diagnostics.ts` is a **deliberate port** of twd-js's internal `src/utils/diagnostics.ts`, not an import. twd-js keeps `formatDiagnostics` private, and its only public entry pulls in the sidebar, chai and the theme (~470 KB) — far too much to load into the page for a pure string formatter. The relay needs only the *data*, which arrives on the handler via `twd-js/runner` (already imported). The output must stay byte-identical to twd-js's, since the sidebar and `runner-ci` render the same block; `src/tests/browser/diagnostics.spec.ts` mirrors twd-js's own spec to keep them honest. **If twd-js's format changes, update this port.**

## Dependency Constraints

Two pins here are deliberate — don't "clean them up":

- **`overrides: { "fast-uri": "^4.1.4" }`** in `package.json` is required for a clean `npm audit`.
  `fast-uri` 3.x carries 6 high-severity advisories and reaches us dev-only via
  `vite-plugin-dts` → `@microsoft/api-extractor` → `@microsoft/tsdoc-config` → `ajv`.
  `ajv` pins `fast-uri: ^3.0.1`, so the fixed 4.x only lands via an override. It never
  ships — the published package's sole runtime dependency is `ws`.
- **`typescript` stays `^5.9.x` and `vite-plugin-dts` stays `^4.5.x`.** TypeScript 7 removed the
  JavaScript Compiler API. With dts 4.5.4 the build fails outright; with `vite-plugin-dts@5`
  plus the `@typescript/typescript6` bridge the build **exits 0 but silently ships broken types** —
  `rollupTypes` degrades to multi-file stubs and `dist/index.d.ts` becomes a re-export stub.

After any dependency bump, verify each of these:

```bash
npm audit                  # expect 0 vulnerabilities
npm ci --dry-run           # catches lockfile inconsistency CI would hit
npm run build && ls dist/*.d.ts
find dist -name '*.d.ts' -mindepth 2   # MUST be empty — non-empty means rollup silently failed
npx @arethetypeswrong/cli --pack .     # node16 (from ESM) must be green on all 3 entries
```

A green build is not sufficient evidence: the type rollup fails silently.

## Test Patterns

- **95 tests** across 10 files, runs in ~3s
- Each test file uses **unique ports** (9877, 9878, 9879+) to avoid conflicts
- WebSocket tests use a **`TrackedWs` wrapper** that buffers incoming messages into a queue. This prevents race conditions — `nextMessage()` either returns a queued message or waits for the next one. This pattern is critical; without it, messages arrive before assertions are set up.
- A new browser connection replaces any existing one (closed with code 1000, reason "Replaced by new browser")
