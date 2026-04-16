# Multi-Tab Favicon & Title Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dynamic favicon + `document.title` prefix to the twd-relay browser client so users can instantly spot the active TWD tab among many tabs open to the same dev server.

**Architecture:** All logic lives in `src/browser/`. A new module `faviconManager.ts` encapsulates DOM mutation (favicon `<link>` element + `document.title`) with `save()` / `set(state)` / `restore()`. `createBrowserClient.ts` wires the manager into four lifecycle points: `open` → `save()` + `set('connected')`; run start → `set('running')`; run end → `set('pass'|'fail')`; `close` → `restore()`. The relay protocol is unchanged.

**Tech Stack:** TypeScript, Vitest, `happy-dom` (new dev dep — gives browser-like `document` in tests without pulling jsdom's weight). No runtime deps added.

**Spec:** [`docs/superpowers/specs/2026-04-16-multi-tab-favicon-indicator-design.md`](../specs/2026-04-16-multi-tab-favicon-indicator-design.md)

---

## File Structure

| File | Role |
|---|---|
| `src/browser/faviconManager.ts` | **New.** Self-contained manager: data-URI favicon constants, title prefix constants, `createFaviconManager(doc)` factory. Takes a `Document` so it is trivially testable. |
| `src/tests/browser/faviconManager.spec.ts` | **New.** Unit tests for the manager. Uses `// @vitest-environment happy-dom` pragma so only this file spins up a DOM. |
| `src/browser/createBrowserClient.ts` | **Modify.** Instantiate the manager once per client, call `save/set/restore` at the four lifecycle points above. |
| `package.json` | **Modify.** Add `happy-dom` to `devDependencies`. |
| `README.md` | **Modify.** Short blurb under the browser-client section explaining the favicon indicator. |
| `CLAUDE.md` (twd-relay) | **Modify.** Mention favicon manager in the browser-client architecture paragraph. |

---

## Task 1: Add `happy-dom` dev dependency

**Files:**
- Modify: `package.json` (devDependencies)
- Modify: `package-lock.json` (automatic via npm)

- [ ] **Step 1: Install happy-dom**

Run from `/Users/kevinccbsg/brikev/twd-relay`:

```bash
npm install --save-dev happy-dom@^15.11.7
```

Expected: adds `"happy-dom": "^15.11.7"` to `devDependencies`. No errors.

- [ ] **Step 2: Verify install**

```bash
node -e "require.resolve('happy-dom')"
```

Expected: prints nothing, exit code 0.

- [ ] **Step 3: Confirm existing tests still pass (regression check)**

```bash
npm run test:ci
```

Expected: all 26 existing tests pass.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add happy-dom dev dep for DOM-based favicon tests"
```

---

## Task 2: Favicon manager — data URI and title prefix constants

**Files:**
- Create: `src/browser/faviconManager.ts`

This task just sets up the constants + exported types. No behavior yet — the factory will be added in Task 3. Keeping these constants in the same file so future reviewers see them in one place.

- [ ] **Step 1: Create the file with types + constants**

Create `src/browser/faviconManager.ts`:

```ts
export type FaviconState = 'connected' | 'running' | 'pass' | 'fail';

export interface FaviconManager {
  save(): void;
  restore(): void;
  set(state: FaviconState): void;
}

// Inline SVG data URIs — a filled circle, 32x32 viewBox. '%23' is URL-encoded '#'.
// Colors chosen for contrast at 16x16 favicon size:
//   blue   #4A90D9 — connected/idle
//   orange #F5A623 — running
//   green  #7ED321 — pass
//   red    #D0021B — fail
export const FAVICON_DATA_URIS: Record<FaviconState, string> = {
  connected: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><circle cx='16' cy='16' r='14' fill='%234A90D9'/></svg>",
  running:   "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><circle cx='16' cy='16' r='14' fill='%23F5A623'/></svg>",
  pass:      "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><circle cx='16' cy='16' r='14' fill='%237ED321'/></svg>",
  fail:      "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><circle cx='16' cy='16' r='14' fill='%23D0021B'/></svg>",
};

export const TITLE_PREFIXES: Record<FaviconState, string> = {
  connected: '[TWD] ',
  running:   '[TWD ...] ',
  pass:      '[TWD ✓] ',
  fail:      '[TWD ✗] ',
};
```

- [ ] **Step 2: Verify file compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/browser/faviconManager.ts
git commit -m "feat: add favicon state constants and FaviconManager type"
```

---

## Task 3: Favicon manager — `save()` test and implementation

**Files:**
- Create: `src/tests/browser/faviconManager.spec.ts`
- Modify: `src/browser/faviconManager.ts` (append `createFaviconManager` factory)

- [ ] **Step 1: Write the failing test**

Create `src/tests/browser/faviconManager.spec.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { createFaviconManager } from '../../browser/faviconManager';

describe('faviconManager.save', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.title = 'My App';
  });

  it('saves the current document title', () => {
    const mgr = createFaviconManager(document);
    mgr.save();
    // title is saved internally — verify via restore() after a change
    document.title = 'something else';
    mgr.restore();
    expect(document.title).toBe('My App');
  });

  it('saves an existing <link rel="icon"> href', () => {
    const link = document.createElement('link');
    link.rel = 'icon';
    link.href = 'https://example.com/app.ico';
    document.head.appendChild(link);

    const mgr = createFaviconManager(document);
    mgr.save();

    // mutate, then restore
    link.href = 'https://example.com/other.ico';
    mgr.restore();

    const restored = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    expect(restored?.href).toBe('https://example.com/app.ico');
  });

  it('records absence of <link rel="icon"> so restore can clean up', () => {
    const mgr = createFaviconManager(document);
    mgr.save();
    // no icon existed — nothing else to assert here; Task 5 verifies removal on restore
    expect(document.querySelector("link[rel='icon']")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/tests/browser/faviconManager.spec.ts
```

Expected: FAIL with `createFaviconManager is not a function` (export does not exist yet).

- [ ] **Step 3: Implement `createFaviconManager` with only `save()` and stub `restore()`**

Append to `src/browser/faviconManager.ts`:

```ts
export function createFaviconManager(doc: Document): FaviconManager {
  let savedHref: string | null = null;
  let savedTitle: string | null = null;
  let hadIconLink = false;

  return {
    save() {
      const existing = doc.querySelector<HTMLLinkElement>("link[rel='icon']");
      hadIconLink = existing !== null;
      savedHref = existing?.href ?? null;
      savedTitle = doc.title;
    },
    restore() {
      if (savedTitle !== null) {
        doc.title = savedTitle;
      }
      if (hadIconLink && savedHref !== null) {
        const link = doc.querySelector<HTMLLinkElement>("link[rel='icon']");
        if (link) link.href = savedHref;
      }
      savedHref = null;
      savedTitle = null;
      hadIconLink = false;
    },
    set() {
      // Implemented in Task 4
      throw new Error('not implemented');
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/tests/browser/faviconManager.spec.ts
```

Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/browser/faviconManager.ts src/tests/browser/faviconManager.spec.ts
git commit -m "feat: faviconManager.save captures current icon href and title"
```

---

## Task 4: Favicon manager — `set()` test and implementation

**Files:**
- Modify: `src/tests/browser/faviconManager.spec.ts`
- Modify: `src/browser/faviconManager.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/tests/browser/faviconManager.spec.ts`:

```ts
describe('faviconManager.set', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.title = 'My App';
  });

  it('sets the favicon to the blue dot and prefixes title when state is connected', () => {
    const mgr = createFaviconManager(document);
    mgr.save();
    mgr.set('connected');

    const link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    expect(link?.getAttribute('href')).toContain('%234A90D9');
    expect(document.title).toBe('[TWD] My App');
  });

  it('switches through all states without compounding the title prefix', () => {
    const mgr = createFaviconManager(document);
    mgr.save();

    mgr.set('connected');
    expect(document.title).toBe('[TWD] My App');

    mgr.set('running');
    expect(document.title).toBe('[TWD ...] My App');

    mgr.set('pass');
    expect(document.title).toBe('[TWD ✓] My App');

    mgr.set('fail');
    expect(document.title).toBe('[TWD ✗] My App');
  });

  it('reuses an existing <link rel="icon"> element rather than creating another', () => {
    const original = document.createElement('link');
    original.rel = 'icon';
    original.href = 'https://example.com/app.ico';
    document.head.appendChild(original);

    const mgr = createFaviconManager(document);
    mgr.save();
    mgr.set('running');

    const links = document.querySelectorAll("link[rel='icon']");
    expect(links.length).toBe(1);
    expect(links[0]).toBe(original);
    expect(original.getAttribute('href')).toContain('%23F5A623');
  });

  it('creates a <link rel="icon"> when none exists', () => {
    const mgr = createFaviconManager(document);
    mgr.save();
    mgr.set('pass');

    const link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toContain('%237ED321');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/tests/browser/faviconManager.spec.ts
```

Expected: 4 new tests FAIL (throws `not implemented` or similar).

- [ ] **Step 3: Implement `set()` and update the factory**

Replace the entire `createFaviconManager` function in `src/browser/faviconManager.ts` with:

```ts
export function createFaviconManager(doc: Document): FaviconManager {
  let savedHref: string | null = null;
  let savedTitle: string | null = null;
  let hadIconLink = false;
  let linkElement: HTMLLinkElement | null = null;

  function getOrCreateLink(): HTMLLinkElement {
    if (linkElement && linkElement.isConnected) return linkElement;
    const existing = doc.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (existing) {
      linkElement = existing;
    } else {
      const link = doc.createElement('link');
      link.rel = 'icon';
      doc.head.appendChild(link);
      linkElement = link;
    }
    return linkElement;
  }

  return {
    save() {
      const existing = doc.querySelector<HTMLLinkElement>("link[rel='icon']");
      hadIconLink = existing !== null;
      savedHref = existing?.href ?? null;
      savedTitle = doc.title;
      linkElement = existing;
    },
    restore() {
      if (savedTitle !== null) {
        doc.title = savedTitle;
      }
      if (!hadIconLink && linkElement && linkElement.isConnected) {
        linkElement.remove();
      } else if (hadIconLink && savedHref !== null && linkElement) {
        linkElement.setAttribute('href', savedHref);
      }
      savedHref = null;
      savedTitle = null;
      hadIconLink = false;
      linkElement = null;
    },
    set(state) {
      const link = getOrCreateLink();
      link.setAttribute('href', FAVICON_DATA_URIS[state]);
      const baseTitle = savedTitle ?? doc.title;
      doc.title = TITLE_PREFIXES[state] + baseTitle;
    },
  };
}
```

Rationale for `setAttribute('href', …)` instead of `link.href = …`: happy-dom normalizes `link.href` to an absolute URL when read back (prepending `about:blank/`), which would break assertions that search for the raw color token. Using/reading via the attribute preserves the exact value we wrote.

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/tests/browser/faviconManager.spec.ts
```

Expected: all 7 tests PASS (3 from Task 3 + 4 new).

- [ ] **Step 5: Commit**

```bash
git add src/browser/faviconManager.ts src/tests/browser/faviconManager.spec.ts
git commit -m "feat: faviconManager.set applies colored favicon and title prefix"
```

---

## Task 5: Favicon manager — `restore()` edge-case tests

Verify the two restore paths: (a) original icon present → href put back; (b) no original icon → created `<link>` is removed entirely.

**Files:**
- Modify: `src/tests/browser/faviconManager.spec.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/tests/browser/faviconManager.spec.ts`:

```ts
describe('faviconManager.restore', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.title = 'My App';
  });

  it('restores original favicon href after set() when one existed', () => {
    const original = document.createElement('link');
    original.rel = 'icon';
    original.href = 'https://example.com/app.ico';
    document.head.appendChild(original);

    const mgr = createFaviconManager(document);
    mgr.save();
    mgr.set('running');
    mgr.restore();

    const link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    expect(link?.href).toBe('https://example.com/app.ico');
    expect(document.title).toBe('My App');
  });

  it('removes the created <link> when no favicon existed originally', () => {
    const mgr = createFaviconManager(document);
    mgr.save();
    mgr.set('fail');
    expect(document.querySelectorAll("link[rel='icon']").length).toBe(1);

    mgr.restore();
    expect(document.querySelectorAll("link[rel='icon']").length).toBe(0);
    expect(document.title).toBe('My App');
  });

  it('is a no-op when restore is called without a prior save', () => {
    const mgr = createFaviconManager(document);
    expect(() => mgr.restore()).not.toThrow();
    expect(document.title).toBe('My App');
  });

  it('supports a save/set/restore cycle followed by another save/set cycle', () => {
    const mgr = createFaviconManager(document);
    mgr.save();
    mgr.set('connected');
    mgr.restore();

    document.title = 'Renamed App';
    mgr.save();
    mgr.set('pass');

    expect(document.title).toBe('[TWD ✓] Renamed App');
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run src/tests/browser/faviconManager.spec.ts
```

Expected: all 11 tests PASS (Task 3 + Task 4 implementation already covers these).

If any fail, inspect the failure and fix the manager — do not loosen the test.

- [ ] **Step 3: Commit**

```bash
git add src/tests/browser/faviconManager.spec.ts
git commit -m "test: faviconManager.restore handles both original-present and created cases"
```

---

## Task 6: Integrate favicon manager into `createBrowserClient`

**Files:**
- Modify: `src/browser/createBrowserClient.ts`

Wire the manager into the four lifecycle points described in the spec.

- [ ] **Step 1: Add the import at the top of the file**

Open `src/browser/createBrowserClient.ts`. After the existing `import type { BrowserClient, BrowserClientOptions } from './types';` line, add:

```ts
import { createFaviconManager } from './faviconManager';
```

- [ ] **Step 2: Instantiate the manager inside `createBrowserClient`**

Find the block that declares `let ws`, `intentionalClose`, `reconnectTimer` (around line 72). Directly before `let ws: WebSocket | null = null;`, insert:

```ts
  const faviconManager = createFaviconManager(document);
```

- [ ] **Step 3: Set `connected` state after the hello handshake**

Locate the `open` handler in `connect()`:

```ts
    ws.addEventListener('open', () => {
      send({ type: 'hello', role: 'browser' });
      log('Connected to relay — ready to receive run/status commands');
    });
```

Replace with:

```ts
    ws.addEventListener('open', () => {
      send({ type: 'hello', role: 'browser' });
      faviconManager.save();
      faviconManager.set('connected');
      log('Connected to relay — ready to receive run/status commands');
    });
```

- [ ] **Step 4: Set `running` at the start of `handleRunCommand`, and `pass`/`fail` after `run:complete`**

Locate `async function handleRunCommand`. Currently starts with the `setInterval` heartbeat and a `try { ... } finally { clearInterval(heartbeatInterval); }`. Make two edits inside that function:

(a) Directly after `const heartbeatInterval = setInterval(...)` (before `try {`), add:

```ts
    faviconManager.set('running');
```

(b) Inside the `try { ... }` block, immediately after the line `send({ type: 'run:complete', passed, failed, skipped, duration });` and before `dispatchStateChange();`, add:

```ts
      faviconManager.set(failed > 0 ? 'fail' : 'pass');
```

Also, inside the same function, the early-return NO_MATCH branch issues its own `send({ type: 'run:complete', ... })` and then `return;`. Add the same favicon update there. Find:

```ts
          send({ type: 'run:complete', passed: 0, failed: 0, skipped: 0, duration: 0 });
          return;
```

Change it to:

```ts
          send({ type: 'run:complete', passed: 0, failed: 0, skipped: 0, duration: 0 });
          faviconManager.set('pass');
          return;
```

(NO_MATCH has 0 failures, so it's treated as pass — matches the "last run completed, all tests passed" definition in the spec.)

- [ ] **Step 5: Restore favicon on WebSocket close**

Locate the `close` handler:

```ts
    ws.addEventListener('close', (event) => {
      ws = null;

      if (event.reason === 'Replaced by new browser') {
        warn('Another browser instance connected — this instance will not reconnect');
        return;
      }

      if (!intentionalClose) {
        log('Disconnected', event.code ? `(code ${event.code})` : '', event.reason || '');
      }
      scheduleReconnect();
    });
```

Replace with:

```ts
    ws.addEventListener('close', (event) => {
      ws = null;
      faviconManager.restore();

      if (event.reason === 'Replaced by new browser') {
        warn('Another browser instance connected — this instance will not reconnect');
        return;
      }

      if (!intentionalClose) {
        log('Disconnected', event.code ? `(code ${event.code})` : '', event.reason || '');
      }
      scheduleReconnect();
    });
```

`restore()` is called unconditionally because both "evicted" and normal disconnects should return the tab to its original appearance. It is a safe no-op if no prior save ever happened.

- [ ] **Step 6: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Run the full test suite to confirm no regression**

```bash
npm run test:ci
```

Expected: existing 26 browser/relay/vite tests all pass + 11 new faviconManager tests pass = 37 total.

- [ ] **Step 8: Build check**

```bash
npm run build
```

Expected: clean build for `browser.es.js` + `browser.cjs.js` + CLI. No warnings about unresolved imports.

- [ ] **Step 9: Commit**

```bash
git add src/browser/createBrowserClient.ts
git commit -m "feat: wire favicon manager into browser client lifecycle

- save+set('connected') on WebSocket open (after hello)
- set('running') at start of handleRunCommand
- set('pass'|'fail') after run:complete (including NO_MATCH)
- restore() on close (covers eviction and normal disconnect)"
```

---

## Task 7: Manual smoke test

Type checks and unit tests verify code correctness. This task verifies the feature actually works in a browser tab bar.

**Files:** none modified; this is verification.

- [ ] **Step 1: Build the package**

```bash
npm run build
```

- [ ] **Step 2: Start the example app**

The repo ships an example at `examples/twd-test-app` (consumes the built `dist/`). In one terminal:

```bash
npm run relay
```

In another terminal:

```bash
cd examples/twd-test-app
npm install  # if not already
npm run dev
```

- [ ] **Step 3: Open the app in a browser and observe the favicon + title**

Open the dev server URL (e.g. `http://localhost:5173`). Within ~2 seconds of page load, you should see:
- Tab favicon becomes a **blue dot**
- Tab title prefixed with `[TWD] `

If not, check the browser console for `[twd-relay]` logs — the client may not have connected.

- [ ] **Step 4: Trigger a run and watch states cycle**

From the repo root:

```bash
npm run send-run
```

While the run is in flight the favicon should flash **orange** (`[TWD ...] `). When it completes, it lands on **green** (`[TWD ✓] `) or **red** (`[TWD ✗] `) depending on outcome.

- [ ] **Step 5: Open a second tab to the same origin and verify eviction**

Open a second browser tab to the same URL. The relay only allows one browser — the old tab is evicted:
- Old tab: favicon + title return to their original app values
- New tab: becomes the TWD tab (blue dot, `[TWD] ` prefix)

- [ ] **Step 6: Refresh the TWD tab and verify re-application**

Refresh the active TWD tab. After reconnect, the blue dot + `[TWD] ` prefix reappear.

- [ ] **Step 7: Kill the relay and verify restore on disconnect**

Ctrl-C the relay process. Within ~2s (scheduleReconnect tick) the browser tab's favicon + title should revert to the app's originals.

If every manual check passes, the feature is verified. If any fail, file the exact failing case and iterate. Do not claim complete without these checks — unit tests cannot observe a real tab bar.

- [ ] **Step 8: (No commit needed — verification only.)**

---

## Task 8: Update docs

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add a section to `README.md`**

Open `README.md`. After the "In your app, connect the browser client and call `connect()`" snippet block (ends around line 69), and before the `**3. Open your app in a browser**` line, insert:

```markdown
Once connected, the browser client sets a colored favicon and prefixes `document.title` so you can spot the active TWD tab at a glance:

| Favicon | Title prefix | State |
|---|---|---|
| Blue dot | `[TWD]` | Connected, idle |
| Orange dot | `[TWD ...]` | Tests running |
| Green dot | `[TWD ✓]` | Last run passed |
| Red dot | `[TWD ✗]` | Last run had failures |

On disconnect or eviction (another tab taking over), the original favicon and title are restored.

```

- [ ] **Step 2: Update `CLAUDE.md` browser-client paragraph**

Open `CLAUDE.md` (the twd-relay one, not the top-level `/Users/kevinccbsg/brikev/CLAUDE.md`). Find the paragraph starting with `**Browser Client** (`src/browser/`, exported as `twd-relay/browser`)`. Append one sentence so it reads:

> **Browser Client** (`src/browser/`, exported as `twd-relay/browser`) — Runs in the browser. Connects to the relay, listens for commands, dynamically imports `twd-js/runner` to execute tests, and streams results back. Uses native browser `WebSocket` with auto-reconnect. Reads test state from `window.__TWD_STATE__` (set by twd-js). A small `faviconManager` (in `src/browser/faviconManager.ts`) sets a colored favicon + `document.title` prefix based on connection/run state so the active TWD tab is identifiable among multiple tabs to the same origin.

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document favicon + title indicator on browser client"
```

---

## Task 9: Final verification

**Files:** none.

- [ ] **Step 1: Full test run with coverage**

```bash
npm run test:ci
```

Expected: all tests pass (37 total). Coverage for `src/browser/faviconManager.ts` should be ~100% lines.

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: clean build. `dist/browser.es.js` should include the favicon data URIs (inlined).

- [ ] **Step 3: Sanity-grep the built output**

```bash
grep -c '4A90D9' dist/browser.es.js
```

Expected: ≥1 (the blue dot color made it into the browser bundle).

- [ ] **Step 4: Review `git log`**

```bash
git log --oneline main..HEAD
```

Expected: a clean series of small, focused commits matching the task breakdown.

- [ ] **Step 5: Self-review the diff**

```bash
git diff main..HEAD -- src/
```

Look for: leftover TODOs, accidental `console.log`, unused imports. Fix in a follow-up commit if any appear.

---

## Definition of done

- All 11 new `faviconManager` unit tests pass.
- All 26 existing tests still pass.
- Manual smoke test in a browser confirms the four state transitions and restore-on-disconnect (Task 7).
- `npm run build` produces a clean browser bundle containing the inlined SVG favicons.
- README and CLAUDE.md updated.
- Relay protocol is unchanged (no new message types, no new fields).
