# twd-relay

WebSocket relay for [TWD](https://github.com/nicolo-ribaudo/twd-js) — lets AI agents and external tools trigger and observe in-browser test runs.

Your app runs tests in the browser with twd-js. twd-relay adds a relay server and a browser client so that a **client** (script, CI, or AI agent) can send a “run” command over WebSocket; the relay forwards it to the browser, and test events are streamed back. No Vite or specific framework required: the relay can run standalone and work with any app that loads the browser client.

---

## Architecture

- **Relay server** — WebSocket server that accepts one browser connection and many client connections. Clients send commands (`run`, `status`); the relay forwards them to the browser. The browser runs tests and streams events back; the relay broadcasts those to all clients. A lock prevents concurrent runs.

- **Browser client** (`twd-relay/browser`) — Runs in your app. Connects to the relay, listens for commands, uses `twd-js/runner` to execute tests, and streams results back. Logs connection state in the console (e.g. `[twd-relay] Connected to relay`).

- **Vite plugin** (`twd-relay/vite`) — Optional. Attaches the relay to your Vite dev server so the WebSocket is on the same origin. Also available: a **standalone CLI** that runs the relay on its own HTTP server (default port 9876).

### Protocol (summary)

1. Browser connects → sends `{ type: 'hello', role: 'browser' }`
2. Client connects → sends `{ type: 'hello', role: 'client' }`
3. Client sends `{ type: 'run', scope: 'all' }` → relay forwards to browser
4. Browser runs tests and streams events → relay broadcasts to clients
5. `run:complete` clears the run lock (and the send-run script exits)

---

## Installation

```bash
npm install twd-relay
```

Peer dependency: **twd-js** (>=1.4.0). Your app must use twd-js for tests; the browser client imports `twd-js/runner` at runtime.

---

## Quick start (standalone relay)

Works with any framework. Run the relay on one port and your app on another.

**1. Start the relay** (from this repo, or use the CLI in your project):

```bash
npm run relay
# or: npx twd-relay
# Listens on ws://localhost:9876/__twd/ws (use --port to change)
```

**2. In your app**, connect the browser client and call `connect()`:

```js
import { createBrowserClient } from 'twd-relay/browser';

const client = createBrowserClient({
  url: 'ws://localhost:9876/__twd/ws',
});
client.connect();
```

**3. Open your app in a browser** — the page connects to the relay as “browser”.

**4. Trigger a run** — something must connect as a **client** and send `run`:

- From this repo: `npm run send-run` (or `node scripts/send-run.js [--port 9876]`). The script exits when it receives `run:complete`.
- From another project (if `ws` is available, e.g. via twd-relay): use the one-liner below.

### One-liner to trigger a run

Run from a directory where `ws` is installed (e.g. project with twd-relay):

```bash
node -e 'const Ws=require("ws");const w=new Ws("ws://localhost:9876/__twd/ws");let s=false;w.on("open",()=>w.send(JSON.stringify({type:"hello",role:"client"})));w.on("message",d=>{const m=JSON.parse(d);console.log(m.type,m);if(m.type==="connected"&&m.browser&&!s){s=true;w.send(JSON.stringify({type:"run",scope:"all"}));}if(m.type==="run:complete"){w.close();}});w.on("close",()=>process.exit(0));'
```

Change the URL if your relay uses another port or path.

---

## Vite plugin (optional)

If you use Vite, you can attach the relay to the dev server so the WebSocket is on the same host/port:

```js
// vite.config.ts
import { twdRemote } from 'twd-relay/vite';

export default defineConfig({
  plugins: [react(), twdRemote()],
});
```

Then in your app you can omit the URL; the client defaults to `ws(s)://<current host>/__twd/ws`.

---

## Scripts (this repo)

| Script        | Description |
|---------------|-------------|
| `npm run build`   | Build relay, browser, vite entry points + CLI |
| `npm run relay`   | Build and start the standalone relay (port 9876) |
| `npm run send-run`| Connect as client and send `run`; exits on `run:complete` |
| `npm run dev`     | Start relay only (assumes already built) |
| `npm run test`    | Run tests (watch) |
| `npm run test:ci` | Run tests with coverage |

---

## Exports

| Export | Use |
|--------|-----|
| `twd-relay` (main) | Relay server: `createTwdRelay(httpServer, options)` |
| `twd-relay/browser` | Browser client: `createBrowserClient(options)` |
| `twd-relay/vite`   | Vite plugin: `twdRemote(options)` |

CLI: `twd-relay` (or `npx twd-relay`) runs the standalone relay; supports `--port`.

---

## License

MIT · [BRIKEV](https://github.com/BRIKEV/twd-relay)
