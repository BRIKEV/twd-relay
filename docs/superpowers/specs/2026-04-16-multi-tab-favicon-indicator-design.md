# Multi-Tab Favicon & Title Indicator

## Problem

When a user has multiple tabs open to the same dev server (e.g. `localhost:5173`), the relay only supports one browser connection. The second tab silently replaces the first. The user can't tell which tab is the active TWD tab — all tabs look identical in the tab bar. This leads to confusion: "where are my tests running?", "why did my tests stop?", "which tab do I need to keep open?"

This is a common scenario — developers habitually open new tabs (clicking links, `npm run dev` opening a tab, copy-pasting localhost URLs) and end up with several tabs to the same origin.

## Solution

Add dynamic favicon and title prefix to the active TWD browser tab. The browser client sets a colored favicon and prefixes `document.title` based on its relay connection state. When the tab is evicted or disconnects, the original favicon and title are restored. The user can scan their tab bar and instantly identify the TWD tab.

All changes are in `src/browser/createBrowserClient.ts`. No relay changes.

## Favicon States

| State | Favicon | Title prefix | When |
|-------|---------|-------------|------|
| Connected (idle) | Blue dot | `[TWD]` | Browser connected to relay, no tests running |
| Running | Orange dot | `[TWD ...]` | Tests executing |
| Pass | Green dot | `[TWD ✓]` | Last run completed, all tests passed |
| Fail | Red dot | `[TWD ✗]` | Last run completed, at least one test failed |
| Disconnected/evicted | Original favicon restored | Original title restored | Not connected to relay |

Favicons are inline SVGs encoded as data URIs. A simple colored circle renders clearly at 16x16/32x32 favicon size and is unmistakable in the tab bar. No external assets to bundle.

Example data URI for a blue dot:

```
data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><circle cx='16' cy='16' r='14' fill='%234A90D9'/></svg>
```

## Implementation

### Favicon manager

A small utility within the browser client with this interface:

```ts
interface FaviconManager {
  save(): void;       // save current favicon and title
  restore(): void;    // restore saved favicon and title
  set(state: 'connected' | 'running' | 'pass' | 'fail'): void;
}
```

**`save()`**: Reads the current `<link rel="icon">` element's href and `document.title`. Stores them. Called once on initial relay connection.

**`restore()`**: Replaces favicon href and document.title with the saved values. Called on disconnect and eviction. If no `<link rel="icon">` existed originally, removes the one we created.

**`set(state)`**: Sets the favicon to the corresponding colored dot SVG data URI and prefixes `document.title` with the state indicator.

### Favicon element handling

The manager creates or reuses a `<link rel="icon">` element:
- If one exists in the document, save its `href` and reuse the element
- If none exists, create one and append to `<head>`. On restore, remove it.

### Integration points in createBrowserClient.ts

**On connect (WebSocket `open` event, after hello handshake):**
```ts
faviconManager.save();
faviconManager.set('connected');
```

**On `handleRunCommand` start (before runner executes):**
```ts
faviconManager.set('running');
```

**On `handleRunCommand` end (after `run:complete` is sent):**
```ts
faviconManager.set(failed > 0 ? 'fail' : 'pass');
```

**On disconnect/eviction (WebSocket `close` event):**
```ts
faviconManager.restore();
```

### No relay changes needed

The browser client already knows its own state transitions:
- It knows when it connects (WebSocket `open`)
- It knows when tests start and end (`handleRunCommand`)
- It knows when it's evicted (WebSocket `close` with reason `"Replaced by new browser"`)

All favicon/title logic lives in the browser client. The relay protocol is unchanged.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Tab evicted by new tab connecting | `close` event fires, favicon and title restored. New tab gets the TWD favicon. |
| User refreshes the TWD tab | WebSocket reconnects, favicon re-applied on connect. |
| Multiple rapid test runs | Each `handleRunCommand` sets "running", then "pass"/"fail". Last state wins. |
| App has no favicon | Manager creates a `<link rel="icon">`, removes it on restore. |
| App changes its own favicon after TWD connects | TWD overwrites it while connected. Original saved favicon is restored on disconnect (may be stale, but this is an edge case). |

## Files Changed

| File | Change |
|------|--------|
| `src/browser/createBrowserClient.ts` | Add favicon manager, integrate at connect/run/disconnect lifecycle points |
