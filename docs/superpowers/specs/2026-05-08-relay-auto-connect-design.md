# Auto-Inject Browser Client Connect via `twdRemote()` Plugin

## Problem

Today, wiring up `twd-relay` in a Vite project takes two coordinated changes:

1. Add `twdRemote()` to `vite.config.ts` (starts the relay WebSocket server).
2. Add a dev-only block to the entry file (`main.tsx` / `main.ts`) that imports `createBrowserClient` and calls `.connect()`:

```ts
if (import.meta.env.DEV) {
  const { createBrowserClient } = await import('twd-relay/browser');
  const client = createBrowserClient({
    url: `${window.location.origin}/__twd/ws`,
  });
  client.connect();
}
```

This is awkward for three reasons:

- **Two places to keep in sync.** If the plugin's `path` option changes, the entry-file `url` has to change too. There is no single source of truth for "where is the relay listening."
- **Dev-only cruft in app code.** The block lives next to `ReactDOM.createRoot(...)` even though it has nothing to do with the app. Authors who haven't seen it before reasonably wonder why their entry file has an `await import` and a WebSocket connect.
- **Asymmetry with `twd-js`.** The companion `twd()` plugin (recently introduced) already auto-injects its own browser script via `transformIndexHtml`. After that migration, `main.tsx` has only the relay leftover — which now stands out as the one remaining piece of dev tooling in app code.

End-state target: a Vite project using `twd-relay` should need **zero** dev-only code in its entry file. Plugin in `vite.config.ts` is the single point of configuration.

## Solution

Extend `twdRemote()` to also inject a `<script type="module">` into the dev-server HTML that constructs the browser client and calls `.connect()`. Same pattern `twd-js`'s `twd()` plugin uses (virtual module + `transformIndexHtml`).

The injection is **on by default** because the 90% case is "I want the relay to work end-to-end." Users who need custom client behavior (custom URL, hooks into client events, integration with non-Vite bundlers) can disable it with a single option and continue using the manual `createBrowserClient` API in their entry file.

## Why keep the manual API

The existing `createBrowserClient` export is **not** going away. It remains the supported public API for:

- **Angular / Webpack / Rollup / esbuild / Rspack consumers.** They have no Vite plugin available; the manual init is their only path. Removing it would break these projects.
- **Advanced Vite users** who want to subscribe to client events, customize reconnect behavior beyond what plugin options expose, or coordinate connect timing with their own startup logic.

The plugin auto-connect is a sugar layer on top — it imports `createBrowserClient` from the same public entry. No internal-only API, no two implementations to maintain.

## Plugin API changes

Extend `TwdRemoteOptions` with an `autoConnect` option that accepts `false` (off) or an options object (on, with overrides):

```ts
export interface TwdRemoteOptions {
  /** WebSocket path. Default: '/__twd/ws' */
  path?: string;

  /**
   * Auto-inject the browser client connect script into index.html in dev.
   * Set to `false` to opt out (e.g. when wiring `createBrowserClient`
   * manually in your entry file).
   *
   * Pass an object to forward options to the injected `createBrowserClient`
   * call. Useful overrides: `reconnect`, `reconnectInterval`, `log`,
   * `maxTestDurationMs`.
   *
   * Default: `true` (auto-connect with default client options).
   */
  autoConnect?: boolean | AutoConnectOptions;
}

export interface AutoConnectOptions {
  /** See `BrowserClientOptions.reconnect`. */
  reconnect?: boolean;
  /** See `BrowserClientOptions.reconnectInterval`. */
  reconnectInterval?: number;
  /** See `BrowserClientOptions.log`. */
  log?: boolean;
  /** See `BrowserClientOptions.maxTestDurationMs`. */
  maxTestDurationMs?: number;
}
```

`url` and `path` are intentionally **not** in `AutoConnectOptions`: the plugin already knows its own path (from its own `path` option, falling back to the configured Vite `base`), and the script computes the URL at runtime from `window.location`. Forcing them apart would re-introduce the "two places to keep in sync" problem this spec exists to remove.

## Implementation

All changes in `src/vite/twdRemote.ts`. Plus optional extension to `src/index.ts` if a separate sub-export is needed (it is not — see "Module layout" below).

### Pattern: virtual module + `transformIndexHtml`

Mirror `twd-js`'s `twd()` plugin (`vite-plugin.es.js:46–73`):

1. **`resolveId(id)`** — claim a virtual module name (e.g. `'virtual:twd-relay/connect'`) and return its prefixed form.
2. **`load(id)`** — when the prefixed id is requested, return a small JS string that imports `createBrowserClient` from the public `twd-relay/browser` entry, instantiates it with the resolved options, and calls `.connect()`.
3. **`transformIndexHtml()`** — inject a `<script type="module" src="/@id/virtual:twd-relay/connect">` tag into `<head>` so the dev server serves the virtual module on first page load.
4. **`apply: 'serve'`** — only active in dev. Production builds are unaffected.

The injected script is literally:

```ts
import { createBrowserClient } from 'twd-relay/browser';
createBrowserClient({ path: '<resolved-path>', /* forwarded options */ }).connect();
```

`<resolved-path>` is the same path the relay is listening on, computed from `options.path ?? base + '/__twd/ws'` in `configResolved`. Single source of truth.

### Sketch

```ts
const VIRTUAL_ID = 'virtual:twd-relay/connect';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

export function twdRemote(options?: TwdRemoteOptions): VitePlugin {
  let resolvedBase = '/';
  let resolvedPath = '/__twd/ws';
  const autoConnect = options?.autoConnect !== false;
  const autoConnectOptions =
    typeof options?.autoConnect === 'object' ? options.autoConnect : {};

  return {
    name: 'twd-relay',
    apply: 'serve',
    configResolved(config) {
      resolvedBase = config.base;
      resolvedPath = options?.path ?? resolvedBase.replace(/\/$/, '') + '/__twd/ws';
    },
    configureServer(server) {
      if (!server.httpServer) return;
      const relay = createTwdRelay(server.httpServer, { path: resolvedPath });
      server.httpServer.on('close', () => relay.close());
    },
    resolveId(id) {
      if (!autoConnect) return null;
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    load(id) {
      if (!autoConnect || id !== RESOLVED_ID) return null;
      const opts = JSON.stringify({ path: resolvedPath, ...autoConnectOptions });
      return [
        "import { createBrowserClient } from 'twd-relay/browser';",
        `createBrowserClient(${opts}).connect();`,
      ].join('\n');
    },
    transformIndexHtml() {
      if (!autoConnect) return;
      return [{
        tag: 'script',
        attrs: {
          type: 'module',
          src: `${resolvedBase}@id/${VIRTUAL_ID}`,
        },
        injectTo: 'head',
      }];
    },
  };
}
```

### Why fire-and-forget is safe here

`createBrowserClient(...).connect()` opens a WebSocket. The connection is **not** required to be established before the React app mounts — test runs are triggered later by `twd-relay run`, by which point the WS has had seconds to connect. There is no timing-sensitive await needed in app code. A separate `<script type="module">` running in parallel with `main.tsx` is fine.

(Contrast: the `twd-js` plugin migration prompted a brief race-with-React-mount investigation. That investigation found no real race, and the relay case is even less coupled because the relay client doesn't touch the DOM or any global state the app reads at mount.)

## Module layout

No new sub-package or sub-export is needed. The injected script imports `createBrowserClient` from the existing `twd-relay/browser` entry, which is the same import path users already use manually. This means:

- **Bundle size impact for plugin users:** identical to today (they were importing the same module manually anyway).
- **No risk of duplicate clients:** the virtual module is the only injection point. If a user enables `autoConnect` *and* calls `createBrowserClient(...).connect()` manually in their entry file, two clients connect — but that's a user error visible in the relay's connection count, not a hidden footgun.

The injected import path is hardcoded as the bare specifier `'twd-relay/browser'`. Vite resolves it through the consumer's `node_modules`. No path-mapping or alias gymnastics needed.

## Files changed

| File | Change |
|---|---|
| `src/vite/twdRemote.ts` | Add `autoConnect` to `TwdRemoteOptions`. Add `AutoConnectOptions` interface. Implement `resolveId` / `load` / `transformIndexHtml` for the virtual connect module. Compute `resolvedPath` in `configResolved` so the relay server and the injected script agree. Add `apply: 'serve'`. |
| `src/vite/index.ts` | Re-export `AutoConnectOptions` if it's part of the public type surface. |
| `src/tests/vite/twdRemote.spec.ts` (new or extended) | Test: with default options, `transformIndexHtml` returns a `<script type="module">` pointing at the virtual id; `load(RESOLVED_ID)` returns a string containing `createBrowserClient(` and the configured `path`. Test: with `autoConnect: false`, `resolveId` / `load` / `transformIndexHtml` are no-ops. Test: `autoConnect: { reconnect: false }` is forwarded into the loaded module string. |
| `examples/` (if there's a Vite example app) | Remove the manual `createBrowserClient` block from the entry file in the example to demonstrate the new flow. Keep the manual usage documented in README under the non-Vite section. |
| `README.md` | Document the new option. Add a clear "non-Vite usage" section that keeps the manual `createBrowserClient` example for Angular/Webpack/Rollup/Rspack consumers. Note the option to opt out (`autoConnect: false`) when manual control is needed. |
| `CLAUDE.md` | One sentence under the existing relay section noting the auto-connect default and the `autoConnect: false` opt-out. |

`src/browser/createBrowserClient.ts` and `src/browser/types.ts` are **not** changed — the public API stays identical.

## Edge cases

| Scenario | Behavior |
|---|---|
| Default Vite project | Plugin auto-injects script. App author writes nothing in `main.tsx`. Connect happens on first page load. |
| User passes `autoConnect: false` | No virtual module, no script injection. User wires `createBrowserClient` manually in their entry file. Identical to today's behavior. |
| User passes `autoConnect: { reconnect: false }` | Virtual module includes that option in the `createBrowserClient` call. |
| User changes `path: '/custom/relay'` | Both the relay server and the injected script use `/custom/relay`. No drift. |
| User runs production build | `apply: 'serve'` keeps the plugin off in build. No script injection in production HTML. |
| User has both `autoConnect: true` AND a manual `createBrowserClient(...).connect()` in their entry file | Two clients connect. Visible in relay logs / connection count. Not a hidden bug — the user explicitly did both. README note. |
| Vite `base` is non-default (e.g. `/app/`) | `resolvedPath` already accounts for base via the existing `configResolved` logic. Virtual module URL is `${base}@id/virtual:twd-relay/connect`. |
| Non-Vite project (Webpack, Angular, Rollup, esbuild, Rspack) | Plugin not used. Users continue with manual `createBrowserClient`. No change. |
| TypeScript user wants types for `autoConnect` options | `AutoConnectOptions` exported from `twd-relay/vite`. |
| User on an older `twd-relay` upgrades and the option default changes their behavior | Default becomes `autoConnect: true`, which **adds** a behavior. If they already wired `createBrowserClient` manually, they now get two clients. Mitigation: changelog entry calling this out explicitly, with a one-line migration ("remove the manual block in `main.tsx` OR set `autoConnect: false`"). |

## Migration path for existing Vite consumers

After upgrade, users have three options:

1. **Recommended:** delete the manual `createBrowserClient` block from `main.tsx` (or its equivalent). End state: zero dev-only code in entry file.
2. **No-op:** set `autoConnect: false` in the plugin call. Behavior identical to before the upgrade.
3. **Both at once is wrong** — auto-connect plus manual connect = two clients. The changelog will flag this loudly.

For non-Vite consumers: nothing changes. Their manual usage is the only path and remains supported.

## Testing approach

**Unit-level tests on the plugin object** (existing pattern in `src/tests/vite/`):

- `twdRemote()` returns a plugin where `transformIndexHtml()` yields exactly one `<script>` tag with `type="module"` and `src="/@id/virtual:twd-relay/connect"`.
- `load('\0virtual:twd-relay/connect')` returns a string that contains `createBrowserClient` and the resolved `path`.
- `twdRemote({ autoConnect: false })` returns a plugin where `resolveId` / `load` / `transformIndexHtml` are no-ops (return null/undefined).
- `twdRemote({ autoConnect: { reconnect: false, log: true } })` includes `"reconnect":false` and `"log":true` in the loaded module string.
- `twdRemote({ path: '/custom' })` produces a load output containing `"path":"/custom"`.

**Integration smoke** (manual or scripted): run a real Vite example app, observe the WS connection in DevTools, run `twd-relay run` and confirm tests execute. Repeat with `autoConnect: false` and a manual `createBrowserClient` call in the entry file.

## Non-goals

- Removing or deprecating `createBrowserClient`. Stays public and supported. Non-Vite users depend on it.
- Webpack / Rollup / Angular plugins. Out of scope for this change. The manual API serves them.
- Coordinating the auto-connect with React mount timing (e.g. waiting until `DOMContentLoaded`). Fire-and-forget is sufficient — the WS connect is not on any user-interaction critical path.
- Surfacing client events (connect, disconnect, error) through plugin options. Users who need event hooks should drop to the manual API; trying to channel arbitrary callbacks through plugin options gets ugly fast.
- Replacing the existing `path` option with anything more elaborate (e.g. URL builder fns). The current shape is sufficient.
- Auto-detecting whether the user already calls `createBrowserClient` manually. Not feasible from plugin context; addressed via changelog instead.
