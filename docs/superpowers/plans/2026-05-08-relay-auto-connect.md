# Auto-Inject Browser Client — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the `twdRemote()` Vite plugin so it auto-injects a `<script type="module">` into the dev-server HTML that calls `createBrowserClient(...).connect()`, eliminating the manual `main.tsx` snippet for Vite consumers. Manual `createBrowserClient` API stays untouched and remains the path for non-Vite consumers.

**Architecture:** All plugin changes in `src/vite/twdRemote.ts`. The plugin claims a virtual module id (`virtual:twd-relay/connect`), `load()`s it as a small JS string that imports `createBrowserClient` from `twd-relay/browser` and connects, and injects a script tag pointing at it via `transformIndexHtml`. The relay-server path and the injected client path are computed once in `configResolved` (single source of truth). The plugin sets `apply: 'serve'` so it's inert in production builds. Auto-connect is on by default; `autoConnect: false` (or an options object for forwarded flags) is the escape hatch.

**Tech Stack:** TypeScript, Vite plugin API, Vitest. Spec: `docs/superpowers/specs/2026-05-08-relay-auto-connect-design.md`.

---

## File Structure

| File | Change |
|---|---|
| `src/vite/twdRemote.ts` | Extend `TwdRemoteOptions` with `autoConnect`. Add `AutoConnectOptions` interface. Extend the inline `VitePlugin` interface with `apply`, `resolveId`, `load`, `transformIndexHtml`. Move path resolution into `configResolved`. Implement the three new hooks. |
| `src/vite/index.ts` | Re-export `AutoConnectOptions`. |
| `src/tests/vite/twdRemote.spec.ts` | **Add** unit tests for the new behavior (current tests stay; we're extending). Use the existing `portCounter`/HTTP-server pattern only for the relay-attach tests; the new hook tests are pure (no server needed). |
| `examples/twd-test-app/src/main.tsx` | Delete the manual `createBrowserClient` block (lines 28–32 currently). The Vue example has no such block; do not touch. |
| `README.md` | Update `## Vite plugin (optional)` to mention auto-connect default + `autoConnect: false`. Promote the existing "Quick start (standalone relay)" snippet as the canonical "Manual usage (non-Vite)" reference. |
| `CLAUDE.md` | One sentence under the existing relay/Vite section noting auto-connect-on-by-default and the `autoConnect: false` opt-out. |

The `VitePlugin` interface stays inline (per project CLAUDE.md: "Vite plugin uses inline `VitePlugin` interface instead of importing from `vite` to avoid dts resolution issues with optional peer deps").

---

## Task 1: Add failing tests for the new plugin hooks

**Files:**
- Modify: `src/tests/vite/twdRemote.spec.ts` (extend existing file)

**Why TDD:** The new behavior is plugin-shape changes (return values from `transformIndexHtml`, content of `load()` strings, gating on `autoConnect: false`). Pure unit-level assertions on the plugin object catch regressions cheaply and don't need a running HTTP server.

- [ ] **Step 1: Add a second `describe` block at the bottom of `src/tests/vite/twdRemote.spec.ts`**

Add the following after the existing `describe('twdRemote Vite plugin', ...)` block (do not modify the existing block). This new block tests the auto-connect hooks in isolation, no HTTP server needed:

```typescript
describe('twdRemote auto-connect', () => {
  const VIRTUAL_ID = 'virtual:twd-relay/connect';
  const RESOLVED_ID = `\0${VIRTUAL_ID}`;

  function withResolvedConfig(
    plugin: ReturnType<typeof twdRemote>,
    base = '/',
  ): void {
    (plugin.configResolved as (c: { base: string }) => void)({ base });
  }

  it('injects a script tag pointing at the virtual id by default', () => {
    const plugin = twdRemote();
    withResolvedConfig(plugin);

    const tags =
      (plugin.transformIndexHtml as () => Array<{
        tag: string;
        attrs?: Record<string, string>;
        injectTo?: string;
      }>)();

    expect(tags).toHaveLength(1);
    const [tag] = tags;
    expect(tag.tag).toBe('script');
    expect(tag.attrs?.type).toBe('module');
    expect(tag.attrs?.src).toBe(`/@id/${VIRTUAL_ID}`);
    expect(tag.injectTo).toBe('head');
  });

  it('respects a non-default Vite base when constructing the script src', () => {
    const plugin = twdRemote();
    withResolvedConfig(plugin, '/my-app/');

    const tags =
      (plugin.transformIndexHtml as () => Array<{
        attrs?: Record<string, string>;
      }>)();

    expect(tags[0].attrs?.src).toBe(`/my-app/@id/${VIRTUAL_ID}`);
  });

  it('resolveId claims the virtual id and returns the prefixed form', () => {
    const plugin = twdRemote();
    const resolveId = plugin.resolveId as (id: string) => string | null;

    expect(resolveId(VIRTUAL_ID)).toBe(RESOLVED_ID);
    expect(resolveId('some-other-id')).toBeNull();
  });

  it('load() returns a module that imports createBrowserClient and connects on the configured path', () => {
    const plugin = twdRemote();
    withResolvedConfig(plugin);

    const code = (plugin.load as (id: string) => string | null)(RESOLVED_ID);

    expect(code).not.toBeNull();
    expect(code).toContain("from 'twd-relay/browser'");
    expect(code).toContain('createBrowserClient(');
    expect(code).toContain('.connect()');
    expect(code).toContain('"path":"/__twd/ws"');
  });

  it('load() reflects an explicit path option', () => {
    const plugin = twdRemote({ path: '/custom/relay' });
    withResolvedConfig(plugin);

    const code = (plugin.load as (id: string) => string | null)(RESOLVED_ID);

    expect(code).toContain('"path":"/custom/relay"');
  });

  it('load() reflects a non-default Vite base', () => {
    const plugin = twdRemote();
    withResolvedConfig(plugin, '/my-app/');

    const code = (plugin.load as (id: string) => string | null)(RESOLVED_ID);

    expect(code).toContain('"path":"/my-app/__twd/ws"');
  });

  it('load() forwards AutoConnectOptions into the createBrowserClient call', () => {
    const plugin = twdRemote({
      autoConnect: { reconnect: false, log: true, maxTestDurationMs: 5000 },
    });
    withResolvedConfig(plugin);

    const code = (plugin.load as (id: string) => string | null)(RESOLVED_ID);

    expect(code).toContain('"reconnect":false');
    expect(code).toContain('"log":true');
    expect(code).toContain('"maxTestDurationMs":5000');
  });

  it('autoConnect: false makes resolveId, load, and transformIndexHtml no-ops', () => {
    const plugin = twdRemote({ autoConnect: false });
    withResolvedConfig(plugin);

    expect(
      (plugin.resolveId as (id: string) => string | null)(VIRTUAL_ID),
    ).toBeNull();
    expect((plugin.load as (id: string) => string | null)(RESOLVED_ID)).toBeNull();
    expect((plugin.transformIndexHtml as () => unknown)()).toBeUndefined();
  });

  it('plugin opts out of production builds via apply: "serve"', () => {
    const plugin = twdRemote();
    expect(plugin.apply).toBe('serve');
  });
});
```

- [ ] **Step 2: Run the file, confirm new tests fail**

Run: `npx vitest run src/tests/vite/twdRemote.spec.ts`

Expected: existing 6 tests pass; the 9 new tests fail because `resolveId`, `load`, `transformIndexHtml`, and `apply` don't exist on the current plugin (or fail because `as Function` calls hit `undefined`). Failures should be type/property errors, not unrelated infrastructure errors.

- [ ] **Step 3: Commit the failing tests**

```bash
git add src/tests/vite/twdRemote.spec.ts
git commit -m "test: add failing tests for twdRemote auto-connect hooks"
```

---

## Task 2: Implement the auto-connect hooks

**Files:**
- Modify: `src/vite/twdRemote.ts`
- Modify: `src/vite/index.ts`

- [ ] **Step 1: Replace `src/vite/twdRemote.ts` with the new implementation**

Open `src/vite/twdRemote.ts` and replace its entire contents with:

```typescript
import { createTwdRelay } from '../relay';
import type { Server } from 'http';

export interface TwdRemoteOptions {
  /** WebSocket path. Default: '/__twd/ws' (relative to Vite `base`). */
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

interface HtmlTagDescriptor {
  tag: string;
  attrs?: Record<string, string>;
  injectTo?: 'head' | 'body' | 'head-prepend' | 'body-prepend';
}

interface VitePlugin {
  name: string;
  apply?: 'serve' | 'build';
  configResolved?: (config: { base: string }) => void;
  configureServer?: (server: { httpServer: Server | null }) => void;
  resolveId?: (id: string) => string | null;
  load?: (id: string) => string | null;
  transformIndexHtml?: () => HtmlTagDescriptor[] | undefined;
}

const VIRTUAL_ID = 'virtual:twd-relay/connect';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

export function twdRemote(options?: TwdRemoteOptions): VitePlugin {
  let resolvedBase = '/';
  let resolvedPath = '/__twd/ws';

  const autoConnectEnabled = options?.autoConnect !== false;
  const autoConnectOptions: AutoConnectOptions =
    typeof options?.autoConnect === 'object' && options.autoConnect !== null
      ? options.autoConnect
      : {};

  return {
    name: 'twd-relay',
    apply: 'serve',
    configResolved(config) {
      resolvedBase = config.base;
      resolvedPath =
        options?.path ?? resolvedBase.replace(/\/$/, '') + '/__twd/ws';
    },
    configureServer(server) {
      if (!server.httpServer) return;
      const relay = createTwdRelay(server.httpServer, { path: resolvedPath });
      server.httpServer.on('close', () => relay.close());
    },
    resolveId(id) {
      if (!autoConnectEnabled) return null;
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    load(id) {
      if (!autoConnectEnabled || id !== RESOLVED_ID) return null;
      const opts = JSON.stringify({ path: resolvedPath, ...autoConnectOptions });
      return [
        "import { createBrowserClient } from 'twd-relay/browser';",
        `createBrowserClient(${opts}).connect();`,
      ].join('\n');
    },
    transformIndexHtml() {
      if (!autoConnectEnabled) return undefined;
      return [
        {
          tag: 'script',
          attrs: {
            type: 'module',
            src: `${resolvedBase}@id/${VIRTUAL_ID}`,
          },
          injectTo: 'head',
        },
      ];
    },
  };
}
```

Key things to notice (and verify against the diff once written):

- `configResolved` now also computes `resolvedPath`. `configureServer` reads it. The relay-server path and the injected client path agree by construction.
- `apply: 'serve'` keeps the plugin inert in production builds.
- The `HtmlTagDescriptor` interface is inline (matches the project's "no `vite` import" decision).
- `resolveId`/`load`/`transformIndexHtml` short-circuit when `autoConnectEnabled` is `false`. The relay-server attach in `configureServer` is unaffected by the toggle.

- [ ] **Step 2: Update `src/vite/index.ts` to export `AutoConnectOptions`**

Replace its contents with:

```typescript
export { twdRemote } from './twdRemote';
export type { TwdRemoteOptions, AutoConnectOptions } from './twdRemote';
```

- [ ] **Step 3: Run the vite test file, confirm all tests pass**

Run: `npx vitest run src/tests/vite/twdRemote.spec.ts`

Expected: all 15 tests pass (6 existing + 9 new).

- [ ] **Step 4: Run the full suite, confirm no regressions**

Run: `npm test -- --run`

Expected: every existing test still passes, plus the new ones. No `EADDRINUSE`, no flake. The CLI test, browser tests, relay tests, and heartbeat tests are independent of the vite plugin and should be unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/vite/twdRemote.ts src/vite/index.ts
git commit -m "feat(vite): auto-inject browser client connect script in dev"
```

---

## Task 3: Remove the manual `createBrowserClient` block from the React example

**Files:**
- Modify: `examples/twd-test-app/src/main.tsx:28-32`

This proves the new plugin behavior end-to-end and matches the spec's recommended migration. The Vue example (`examples/vue-twd-example`) has no such block (verified via grep) — leave it alone.

- [ ] **Step 1: Delete the manual block**

In `examples/twd-test-app/src/main.tsx`, the current dev-only `if (import.meta.env.DEV) { ... }` body ends with these five lines:

```tsx
  // Browser client: connects to the relay via the Vite plugin.
  // To trigger a run: npx twd-relay run (or node ../../dist/cli.js run)
  const { createBrowserClient } = await import('twd-relay/browser');
  const client = createBrowserClient();
  client.connect();
```

Delete those five lines (and the blank line preceding the comment if any). Leave the rest of the dev block (test-modules import, `initTests`, `twd.initRequestMocking()`) intact — those are twd-js setup, not relay setup.

After the edit, the tail of the dev block should look like:

```tsx
  twd.initRequestMocking()
    .then(() => {
      console.log("Request mocking initialized");
    })
    .catch((err) => {
      console.error("Error initializing request mocking:", err);
    });
}
```

- [ ] **Step 2: Manually verify the example still loads and connects**

This is the only manual smoke needed. From the repo root:

```bash
npm run build
cd examples/twd-test-app
npm run dev
```

In the browser, open the printed URL and confirm:

1. The page renders normally (no JS errors in DevTools console).
2. DevTools → Network → WS shows a connection to `/__twd/ws`.
3. The `[TWD]` title prefix appears in the tab title (set by the browser client's favicon manager once connected).
4. From another terminal: `npx twd-relay run --port <vite-port>` — tests should run.

If any of these fail, STOP and report. Do not commit.

- [ ] **Step 3: Commit**

```bash
git add examples/twd-test-app/src/main.tsx
git commit -m "chore(example): rely on twdRemote auto-connect in test-app"
```

---

## Task 4: Update README

**Files:**
- Modify: `README.md` — `## Vite plugin (optional)` section starting at line 116.

- [ ] **Step 1: Replace the Vite plugin section body**

Find the section that currently reads:

```markdown
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
```

Replace the body (everything between the `## Vite plugin (optional)` header and the next `---` separator) with:

```markdown
## Vite plugin (optional)

If you use Vite, the plugin attaches the relay to the dev server **and** auto-injects the browser client into your `index.html` — so you don't need to call `createBrowserClient` yourself:

```ts
// vite.config.ts
import { twdRemote } from 'twd-relay/vite';

export default defineConfig({
  plugins: [react(), twdRemote()],
});
```

That's the whole setup. The plugin only runs in dev (`apply: 'serve'`); production builds are untouched.

### Plugin options

| Option | Type | Default | Description |
|---|---|---|---|
| `path` | `string` | `'/__twd/ws'` (relative to Vite `base`) | WebSocket path. Used both by the relay and by the injected client — single source of truth. |
| `autoConnect` | `boolean \| AutoConnectOptions` | `true` | Inject the browser client connect script into `index.html`. Set to `false` to wire `createBrowserClient` manually in your entry file. Pass an object to forward options (`reconnect`, `reconnectInterval`, `log`, `maxTestDurationMs`) into the injected `createBrowserClient` call. |

### Manual usage (non-Vite, or opting out)

`twd-relay/browser` is the supported public API for any setup the Vite plugin doesn't cover (Webpack, Angular, Rollup, esbuild, Rspack), and for advanced Vite users who want to subscribe to client events or coordinate connect timing. See the [Quick start](#quick-start-standalone-relay) section above for the manual snippet. To use the manual snippet **with** the Vite plugin, set `autoConnect: false` so the plugin doesn't also inject one — otherwise two clients connect.
```

(The `[Quick start](#quick-start-standalone-relay)` link points to the existing section; verify the anchor by GitHub-rendered slug rules — lower-cased, spaces → hyphens, parentheses dropped.)

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document twdRemote auto-connect option"
```

---

## Task 5: Update project CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` — the bullet covering the Vite plugin in the Architecture section.

- [ ] **Step 1: Update the Vite plugin bullet**

Open `CLAUDE.md` (the project-root `CLAUDE.md` for `twd-relay`) and locate the Architecture-section paragraph that begins:

```
**Vite Plugin** (`src/vite/`, exported as `twd-relay/vite`) — A Vite plugin that hooks into `configureServer` to attach the relay to the dev server's HTTP instance.
```

Replace that whole paragraph with:

```
**Vite Plugin** (`src/vite/`, exported as `twd-relay/vite`) — A Vite plugin that hooks into `configureServer` to attach the relay to the dev server's HTTP instance, and (in `apply: 'serve'` mode) auto-injects a `<script type="module">` that imports `createBrowserClient` and calls `.connect()` via a virtual module (`virtual:twd-relay/connect`). Auto-injection is on by default; set `autoConnect: false` to opt out and wire `createBrowserClient` manually (required for non-Vite consumers). The relay-server path and the injected client path are computed once in `configResolved` so they cannot drift.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): note auto-connect default in vite plugin section"
```

---

## Out of Scope (per spec)

- Removing or deprecating `createBrowserClient`. Stays public.
- Plugins for Webpack/Rollup/Angular/Rspack. Manual API serves them.
- Coordinating injected connect with React mount timing (fire-and-forget is sufficient).
- Surfacing client events through plugin options.
- A URL builder fn in place of the `path` option.
- Auto-detecting whether the user already calls `createBrowserClient` manually. Changelog covers this in the migration note.
- Version bump / publish — handled separately on `main`.

---

## Manual smoke summary (covered in Task 3 Step 2)

1. Build the package: `npm run build`.
2. Run the React example: `cd examples/twd-test-app && npm run dev`.
3. Confirm: page renders, WS connection in DevTools, `[TWD]` title prefix, `npx twd-relay run` triggers a real run.
4. Confirm: with `autoConnect: false` in `vite.config.ts` and the manual block restored in `main.tsx`, behavior is identical to today (one client). Then revert.

The unit tests cover the plugin shape; the manual smoke covers the integration end-to-end.
