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

**Browser Client** (`src/browser/`, exported as `twd-relay/browser`) — Runs in the browser. Connects to the relay, listens for commands, dynamically imports `twd-js/runner` to execute tests, and streams results back. Uses native browser `WebSocket` with auto-reconnect. Reads test state from `window.__TWD_STATE__` (set by twd-js).

**Vite Plugin** (`src/vite/`, exported as `twd-relay/vite`) — A Vite plugin that hooks into `configureServer` to attach the relay to the dev server's HTTP instance. Also a standalone CLI (`src/cli/standalone.ts`, bin: `twd-relay`) that spins up its own HTTP server with the relay.

### Message protocol flow

1. Browser connects with `{ type: 'hello', role: 'browser' }`
2. Clients connect with `{ type: 'hello', role: 'client' }`
3. Client sends `{ type: 'run', scope: 'all' }` → relay forwards to browser
4. Browser streams test events → relay broadcasts to all clients
5. `run:complete` clears the run lock

## Key Design Decisions

- `twd-js` is a **peer dependency**; the browser client uses `await import('twd-js/runner')` to avoid bundling it
- `vite` is an **optional peer dependency**; the Vite plugin defines an inline `VitePlugin` interface instead of importing from `vite` to avoid dts resolution issues
- `moduleResolution: "Bundler"` in tsconfig is required for subpath exports like `twd-js/runner`
- Use `import { type RawData } from 'ws'` (not `WebSocket.RawData` namespace access) for ESM/CJS compat
- Build externals: `ws`, `http`, `stream`, `vite`, `twd-js`, `twd-js/runner`

## Test Patterns

- **21 tests** across 3 files, runs in ~1.5s
- Each test file uses **unique ports** (9877, 9878, 9879+) to avoid conflicts
- WebSocket tests use a **`TrackedWs` wrapper** that buffers incoming messages into a queue. This prevents race conditions — `nextMessage()` either returns a queued message or waits for the next one. This pattern is critical; without it, messages arrive before assertions are set up.
- A new browser connection replaces any existing one (closed with code 1000, reason "Replaced by new browser")
