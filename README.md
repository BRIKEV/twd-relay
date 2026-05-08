# twd-relay

WebSocket relay for [TWD](https://github.com/nicolo-ribaudo/twd-js) — lets AI agents and external tools trigger and observe in-browser test runs.

Your app runs tests in the browser with twd-js. twd-relay adds a relay server and a browser client so a **client** (script, CI, or AI agent) can send a `run` command over WebSocket; the relay forwards it to the browser, and test events stream back.

---

## Quick start (Vite)

The Vite plugin attaches the relay to the dev server **and** auto-injects the browser client into your `index.html` — one line in `vite.config.ts` and you're done.

**1. Install:**

```bash
npm install --save-dev twd-relay
```

Peer dependency: **twd-js** (>=1.4.0). Your app must use twd-js for tests; the browser client imports `twd-js/runner` at runtime.

**2. Add the plugin:**

```ts
// vite.config.ts
import { twdRemote } from 'twd-relay/vite';

export default defineConfig({
  plugins: [react(), twdRemote()],
});
```

That's the whole setup. The plugin only runs in dev (`apply: 'serve'`); production builds are untouched.

**3. Run your app, then trigger a test run:**

```bash
npm run dev                 # in one terminal
npx twd-relay run           # in another — connects, runs, exits 0/1
```

`twd-relay run` defaults to port 5173 (Vite). See [CLI run command](#cli-run-command) for filters and flags.

### Visual feedback in the browser tab

When connected, the browser client sets a colored favicon and prefixes `document.title` so you can spot the active TWD tab among many:

| Favicon | Title prefix | State |
|---|---|---|
| Blue | `[TWD]` | Connected, idle |
| Orange | `[TWD ...]` | Tests running |
| Green | `[TWD ✓]` | Last run passed |
| Red | `[TWD ✗]` | Last run had failures |

On disconnect or eviction (another tab taking over), the original favicon and title are restored.

---

## Plugin options

```ts
twdRemote({
  path: '/__twd/ws',           // WebSocket path (relative to Vite `base`)
  autoConnect: true,            // inject the browser client into index.html
});

twdRemote({ autoConnect: false }); // opt out — wire createBrowserClient manually

twdRemote({                         // forward client options into the injected call
  autoConnect: { reconnect: false, log: true, maxTestDurationMs: 5000 },
});
```

| Option | Type | Default | Description |
|---|---|---|---|
| `path` | `string` | `'/__twd/ws'` (relative to Vite `base`) | WebSocket path. Used by the relay and the injected client — single source of truth. |
| `autoConnect` | `boolean \| AutoConnectOptions` | `true` | Inject the browser client connect script into `index.html`. `false` opts out. Object form forwards `reconnect`, `reconnectInterval`, `log`, `maxTestDurationMs` into the injected `createBrowserClient` call. |

---

## Operational reliability

These features are on by default — no configuration needed.

### Aborting throttled runs

Chrome aggressively throttles timers in backgrounded tabs, which can stretch a 1-second test run to 30+ seconds. To avoid AI/CI hangs, the browser client monitors per-test wall-clock time. If any single test runs longer than 10 seconds, the browser emits `run:aborted`, the CLI prints a clear error, and the run exits with code 1.

Override the threshold with `--max-test-duration <ms>` on `twd-relay run`, or pass `maxTestDurationMs` to `twdRemote({ autoConnect: { ... } })`. Set it to `0` to disable detection:

```bash
twd-relay run --max-test-duration 20000   # raise to 20s for heavy multistep tests
twd-relay run --max-test-duration 0       # disable detection
```

The default of 10 s sits above the Testing Library default `findBy*` timeout (3 s). A legitimately failing test still completes under the threshold; throttled runs cluster in the 10–30 s range and trip the abort reliably.

Recovery: foreground the TWD tab (identified by the `[TWD …]` title prefix) and retry. For unattended runs, prefer `twd-cli` — it drives a headless browser where the tab is always focused.

### Frozen-tab recovery (heartbeat)

During a run, the browser sends a heartbeat every 3 seconds. The relay tracks the last heartbeat and checks every 10 seconds. If no heartbeat arrives for **120 seconds** during an active run, the relay considers the run dead (browser tab frozen by the OS), resets the run lock, and broadcasts:

```json
{ "type": "run:abandoned", "reason": "heartbeat_timeout" }
```

The CLI prints `Run abandoned — browser tab appears frozen. Refresh the browser tab and retry.` and exits 1. AI agents get an actionable signal instead of a 180 s timeout followed by a cryptic `RUN_IN_PROGRESS` error.

### Failures recap

When tests fail, the CLI prints a recap block at the very end of the output listing each failed test and its error. This survives `tail -N` truncation and is easy to copy as a single block.

---

## Manual setup (non-Vite, or opting out)

Use this path for **Webpack, Angular CLI, Rollup, esbuild, Rspack** — anywhere the Vite plugin doesn't apply — or when you want full control over the browser client lifecycle in a Vite project (set `autoConnect: false` on the plugin).

**1. Run a relay** — either standalone, or attached to a dev server you control:

```bash
npx twd-relay
# Listens on ws://localhost:9876/__twd/ws (use --port to change)
```

**2. Connect the browser client in your app entry file:**

```js
import { createBrowserClient } from 'twd-relay/browser';

const client = createBrowserClient({
  url: 'ws://localhost:9876/__twd/ws',
});
client.connect();
```

`createBrowserClient` accepts `url`, `path`, `reconnect`, `reconnectInterval`, `log`, and `maxTestDurationMs`. See [`src/browser/types.ts`](./src/browser/types.ts) for the full interface.

**3. Open the app in a browser, then trigger a run:**

```bash
npx twd-relay run --port 9876
```

> ⚠️ **Don't enable both auto-connect and a manual `createBrowserClient` call.** Two clients will connect — visible in relay logs as a duplicate browser. Either remove the manual block, or set `autoConnect: false` on `twdRemote()`.

### One-liner to trigger a run from a script

When you don't want the CLI but already have `ws` available:

```bash
node -e 'const Ws=require("ws");const w=new Ws("ws://localhost:9876/__twd/ws");let s=false;w.on("open",()=>w.send(JSON.stringify({type:"hello",role:"client"})));w.on("message",d=>{const m=JSON.parse(d);console.log(m.type,m);if(m.type==="connected"&&m.browser&&!s){s=true;w.send(JSON.stringify({type:"run",scope:"all"}));}if(m.type==="run:complete"){w.close();}});w.on("close",()=>process.exit(0));'
```

---

## CLI `run` command

Connect to a running relay, trigger tests, stream output, exit 0 (all pass) or 1 (failures).

```bash
# Run all tests (defaults to port 5173 — Vite dev server)
twd-relay run

# Different port (e.g. standalone relay)
twd-relay run --port 9876

# Filter tests by name (substring match, case-insensitive, repeatable)
twd-relay run --test "should show error"
twd-relay run --test "login" --test "signup"
```

| Flag | Description | Default |
|---|---|---|
| `--port <port>` | Relay port | `5173` |
| `--host <host>` | Relay host | `localhost` |
| `--path <path>` | WebSocket path | `/__twd/ws` |
| `--timeout <ms>` | Run timeout | `180000` |
| `--max-test-duration <ms>` | Per-test wall-clock abort threshold | `10000` |
| `--test <name>` | Filter tests by name substring (repeatable) | — |

When `--test` is used and no tests match, the CLI prints the available test names so you can correct the filter.

---

## Architecture

- **Relay server** (`twd-relay`) — WebSocket server that accepts one browser connection and many client connections. Clients send commands (`run`, `status`); the relay forwards them. The browser runs tests and streams events back; the relay broadcasts to all clients. A lock prevents concurrent runs.
- **Browser client** (`twd-relay/browser`) — Runs in your app. Connects to the relay, listens for commands, uses `twd-js/runner` to execute tests, and streams results back. Logs connection state to the console.
- **Vite plugin** (`twd-relay/vite`) — Attaches the relay to your Vite dev server **and** auto-injects the browser client. The recommended path for Vite projects.
- **Standalone CLI** (`twd-relay` bin) — Runs the relay on its own HTTP server (default port 9876) for projects that aren't on Vite.

### Protocol summary

1. Browser connects → sends `{ type: 'hello', role: 'browser' }`
2. Client connects → sends `{ type: 'hello', role: 'client' }`
3. Client sends `{ type: 'run', scope: 'all' }` (optionally `testNames: string[]`) → relay forwards to browser
4. Browser runs tests and streams events → relay broadcasts to clients
5. Browser sends `{ type: 'heartbeat' }` every 3 s during a run (consumed by the relay, not forwarded)
6. `run:complete` clears the run lock

---

## Exports

| Export | Use |
|---|---|
| `twd-relay` (main) | Relay server: `createTwdRelay(httpServer, options)` |
| `twd-relay/browser` | Browser client: `createBrowserClient(options)` |
| `twd-relay/vite` | Vite plugin: `twdRemote(options)` |

CLI: `twd-relay` (or `npx twd-relay`):

- `twd-relay serve` (default) — start the standalone relay
- `twd-relay run` — connect to a relay and trigger a test run

---

## Scripts (this repo)

| Script | Description |
|---|---|
| `npm run build` | Build relay, browser, vite entry points + CLI |
| `npm run relay` | Build and start the standalone relay (port 9876) |
| `npm run send-run` | Connect as client and send `run`; exits on `run:complete` |
| `npm run dev` | Start relay only (assumes already built) |
| `npm run test` | Run tests (watch) |
| `npm run test:ci` | Run tests with coverage |

---

## License

MIT · [BRIKEV](https://github.com/BRIKEV/twd-relay)
