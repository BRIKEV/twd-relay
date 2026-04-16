# Detect-and-Abort on Throttled Tab Runs

## Problem

Chrome aggressively throttles timers and the WebSocket message loop in backgrounded tabs. When a developer or AI triggers `twd-relay run` from the terminal while the TWD browser tab is hidden, tests that normally complete in ~1 s stretch to 20–30 s. Observed example: a 6-test suite where test 1 finished in 515 ms and subsequent tests each took 5–10 s of wall time, for a total run of 27.6 s.

This has two bad downstream effects for automation:

1. **The AI waits blindly.** The only signal the AI sees is CLI output that looks fine — tests pass, total duration just happens to be huge. By the time the run completes, the AI has burned 30 s of wall time and still has no idea why.
2. **The relay can get wedged.** If the AI times out, kills the CLI, and retries, the relay's `runInProgress` lock is still held (until the browser eventually finishes its orphan run and sends `run:complete`, or the 2-minute heartbeat timeout fires). The retry receives `A test run is already in progress` with no recovery hint.

The prior [tab-keepalive design](./2026-04-16-tab-keepalive-design.md) tried to *bypass* throttling via silent audio. That approach is dead: Chrome only grants media-activation to visible tabs with recent gestures, and we can't click a hidden tab. We stop fighting the browser and detect the symptom instead.

## Solution

Detect unusually slow individual tests in the browser client and abort the run proactively with a clear message the AI can act on. Improve the existing `RUN_IN_PROGRESS` error message so the stuck-lock case — when it still happens — is recoverable by reading the error.

Two small, related changes:

1. **Throttle detection + abort.** The browser client measures wall-clock time per in-flight test. On the existing 3 s heartbeat tick, if the current test has exceeded a configurable threshold (default 10 s), the browser emits a new `run:aborted` event and then a conventional `run:complete` so the relay releases its lock via the normal path. The CLI prints a clear error with recovery guidance and exits non-zero.
2. **Better stuck-lock message.** The relay's `RUN_IN_PROGRESS` error string is expanded to explain how to recover (foreground and/or reload the tab; wait 120 s for heartbeat auto-release).

All work is in `twd-relay`. `twd-js` is untouched: the runner does not support mid-run cancellation and that is explicitly out of scope.

## Known tradeoff: the orphan browser run

Because the runner cannot be cancelled, the browser keeps executing the remaining tests internally after we abort. We simply stop reporting them: an `aborted` flag short-circuits `onPass` / `onFail` / `onSkip` / `onSuiteStart` / `onSuiteEnd`, and no further `test:*` events are sent. When the runner eventually finishes, our own `run:complete` has already unblocked the relay, so the runner's trailing result is discarded by us and a no-op at the relay.

This is the minimum-coupling trade: the AI is unblocked fast; the browser tab churns on its own until the user refocuses it. In practice, refocusing the tab also kills the throttling, so the orphan run finishes quickly.

## Threshold shape

| Setting | Value |
|---|---|
| Default | **10 000 ms** per test |
| Disable | Set the option or flag to `0` |
| Browser option | `maxTestDurationMs?: number` on `BrowserClientOptions` |
| CLI flag | `--max-test-duration <ms>` on `twd-relay run` |
| Per-run override | The CLI forwards its flag in the `run` command payload; the browser prefers it over its own option |

10 s is deliberately generous. Real TWD tests are sub-second; anything above a few seconds is almost always throttling. Users with a legitimately slow test can raise the threshold for a single run without touching app code.

## Protocol

### New event: `run:aborted`

Emitted by the browser client, broadcast by the relay like every other browser event. Parallel to but distinct from the existing relay-originated `run:abandoned`.

```ts
export interface RunAbortedEvent {
  type: 'run:aborted';
  reason: 'throttled';
  durationMs: number;   // actual wall-clock time spent on the slow test so far
  testName: string;     // the test whose duration tripped the threshold
}
```

Added to the `BrowserEvent` union in `src/relay/types.ts`.

**Why a new event and not a new `run:abandoned` reason?** Different origin (browser-detected vs relay-detected), different recovery hint, different CLI message. Worth the distinct name.

### Extended `RunCommand`

The CLI forwards its `--max-test-duration` value in the `run` payload:

```ts
export interface RunCommand {
  type: 'run';
  scope: 'all';
  testNames?: string[];
  maxTestDurationMs?: number;   // NEW — omit or 0 disables detection
}
```

The relay forwards unknown fields verbatim (its current behavior), so the only relay change is the type definition.

### Event sequence on abort

1. `test:start` for the slow test (as normal).
2. …slow test continues executing…
3. On the next 3 s heartbeat tick where `performance.now() - currentTestStart > threshold`:
   - Browser sets `aborted = true`.
   - Browser sends `run:aborted` with reason/duration/testName.
   - Browser sends `run:complete` with counts-so-far and `duration = performance.now() - runStart`.
   - Browser clears the heartbeat interval; no further events from this run.
4. Runner's `onPass` / `onFail` / `onSkip` for subsequent tests is guarded by `aborted` and returns immediately without sending.
5. When the runner eventually returns, the end-of-function block in `handleRunCommand` also short-circuits under `aborted`:
   - The final `send({ type: 'run:complete', … })` is skipped (we already sent it in the abort tick — emitting twice would confuse clients).
   - `faviconManager.set('fail')` is still called so the tab's favicon + title reflect that the run did not succeed.
   - `dispatchStateChange()` is still called for the sidebar UI.
6. The `finally` block (`clearInterval(heartbeatInterval)`) is a no-op since we already cleared the interval in the abort tick.

## Browser client changes

Inside `handleRunCommand`, track per-test start time and an `aborted` flag. The existing heartbeat `setInterval` gains a second responsibility: threshold check.

```ts
let currentTestStart: number | null = null;
let currentTestName: string | null = null;
let aborted = false;
const threshold = resolveThreshold(parsed.maxTestDurationMs, options?.maxTestDurationMs);

const heartbeatInterval = setInterval(() => {
  send({ type: 'heartbeat' });
  if (
    !aborted &&
    threshold > 0 &&
    currentTestStart !== null &&
    performance.now() - currentTestStart > threshold
  ) {
    aborted = true;
    const durationMs = performance.now() - currentTestStart;
    send({
      type: 'run:aborted',
      reason: 'throttled',
      durationMs,
      testName: currentTestName ?? '',
    });
    send({
      type: 'run:complete',
      passed,
      failed,
      skipped,
      duration: performance.now() - runStart,
    });
    clearInterval(heartbeatInterval);
  }
}, 3000);
```

`onStart` sets `currentTestStart` + `currentTestName`. `onPass` / `onFail` / `onSkip` clear `currentTestStart = null` and then — only if not aborted — emit their normal event and update counters. The existing callbacks just add an `if (aborted) return;` at the top.

Threshold resolution:

```ts
function resolveThreshold(fromCommand?: number, fromOption?: number): number {
  if (typeof fromCommand === 'number') return fromCommand;   // 0 honored as "disabled"
  if (typeof fromOption === 'number') return fromOption;
  return 10_000;
}
```

`maxTestDurationMs` added to `BrowserClientOptions`:

```ts
/**
 * Maximum wall-clock time any single test may run before the browser
 * aborts the run with reason 'throttled'. Typically triggered when the
 * tab is backgrounded and Chrome throttles timers. Default: 10000 (ms).
 * Set to 0 to disable detection.
 */
maxTestDurationMs?: number;
```

## CLI changes

Add `--max-test-duration <ms>` to the `run` subcommand. Default `10000`. `0` disables.

Include the value in the `run` payload:

```ts
const runMsg: Record<string, unknown> = { type: 'run', scope: 'all' };
if (testNames?.length) runMsg.testNames = testNames;
if (maxTestDurationMs !== undefined) runMsg.maxTestDurationMs = maxTestDurationMs;
ws.send(JSON.stringify(runMsg));
```

Handle `run:aborted` in the message switch:

```ts
case 'run:aborted':
  failed = true;
  console.error(
    `\nRun aborted: test "${msg.testName}" ran for ${(msg.durationMs / 1000).toFixed(1)}s — threshold exceeded.\n` +
    `The TWD browser tab is likely backgrounded and throttled by the browser.\n` +
    `Foreground the TWD tab (identified by the "[TWD …]" title prefix) and keep it active, then retry.\n` +
    `For unattended runs, prefer \`twd-cli\` which drives a headless browser with no tab throttling.`
  );
  break;
```

The existing `run:complete` handler arrives right after and does the `process.exit(failed ? 1 : 0)`.

## Relay changes

### Forward `maxTestDurationMs`

The relay currently forwards the raw `run` message verbatim from client to browser (it does not deconstruct the payload for known fields). Confirm this still works for the new field; if the forwarding path reconstructs the message, extend it. Add a test.

### Improved `RUN_IN_PROGRESS` error message

Change the sentinel string at the one site in `createTwdRelay.ts`:

```ts
sendError(
  ws,
  'RUN_IN_PROGRESS',
  'A test run is already in progress. If the previous run appears stuck, ' +
  'the browser tab may be backgrounded and throttled — foreground the TWD tab ' +
  '(identified by the "[TWD …]" title prefix) or reload it. The relay also ' +
  'auto-clears the lock after 120s of heartbeat silence.'
);
```

No type changes, no new error code. CLI forwards the message verbatim today via its existing `error` handler.

## Files changed

| File | Change |
|---|---|
| `src/relay/types.ts` | Add `RunAbortedEvent` to `BrowserEvent`. Extend `RunCommand` with optional `maxTestDurationMs`. |
| `src/relay/createTwdRelay.ts` | Expand the `RUN_IN_PROGRESS` error string. No behavior change. |
| `src/browser/types.ts` | Add `maxTestDurationMs?: number` to `BrowserClientOptions`. |
| `src/browser/createBrowserClient.ts` | Track current-test start/name; add `aborted` flag; add threshold check inside the heartbeat tick; short-circuit runner event callbacks when aborted. Accept `maxTestDurationMs` from the `run` command, fall back to option, fall back to 10000. |
| `src/cli/run.ts` | Add `--max-test-duration` flag (default 10000). Include in `run` payload. Handle `run:aborted` with the clear multi-line error message and set `failed = true`. |
| `src/tests/relay/createTwdRelay.spec.ts` | Test `maxTestDurationMs` is forwarded to the browser. Test `RUN_IN_PROGRESS` error contains the recovery guidance substring. Test `run:aborted` events are broadcast to all clients. |
| `src/tests/browser/createBrowserClient.spec.ts` | Integration test via the existing protocol simulator: browser emits `run:aborted` + `run:complete` when a test takes longer than the threshold. Uses fake timers to drive the heartbeat tick deterministically. |
| `src/tests/cli/run.spec.ts` (new, optional) | Test the `run:aborted` handler prints the guidance text. Only worth adding if a CLI spec file exists or we create one. |
| `README.md` | Short note: tests auto-abort if any single test runs longer than 10s (configurable); foreground the TWD tab (spot it via the `[TWD …]` title) or use `twd-cli` for unattended runs. |
| `CLAUDE.md` | Add one sentence under the existing browser-client paragraph noting the abort-on-throttle behavior. |

## Edge cases

| Scenario | Behavior |
|---|---|
| Happy path — all tests under threshold | Identical to today. No `run:aborted` event. |
| Single slow test, tab throttled | Abort fires within ~3 s of threshold breach (next heartbeat tick). CLI prints guidance and exits 1. |
| Legitimately slow test | User passes `--max-test-duration 30000` or sets the client option, or uses `0` to disable. |
| Threshold = 0 | Detection skipped; identical to today (matching the existing `duration` reporting). |
| `run:aborted` sent, runner keeps running | Subsequent `test:*` events are suppressed by the `aborted` flag. Terminal `run:complete` from the runner path is not sent (the one we sent in the abort tick is authoritative). |
| Browser truly frozen (no heartbeats) | Unchanged. The existing `run:abandoned` path (heartbeat timeout) still fires. Independent code path. |
| NO_MATCH (no tests matched) | No tests run, threshold never fires. Already disarms via existing code. |
| User runs two back-to-back slow runs | First aborts cleanly → `runInProgress` cleared → second starts normally. |
| User sees `RUN_IN_PROGRESS` | New message explains exactly how to recover without restarting the relay. |
| `twd-cli` (headless) run | Puppeteer keeps the tab foregrounded; threshold is not expected to trip. Option still available if someone wants a belt-and-suspenders cap. |

## Testing approach

**Browser client integration test:** existing protocol simulator + Vitest fake timers. Client sends `run` with `maxTestDurationMs: 50`. Simulator browser acknowledges `run:start`, `test:start`, then advances fake time past threshold before sending `test:pass`. Assert the order of received messages: `run:start`, `test:start`, `run:aborted` with the right `reason`/`testName`, `run:complete`. Follow-up `test:pass` and terminal `run:complete` from the runner are suppressed.

**Relay tests:** unit tests confirming `maxTestDurationMs` is forwarded, `run:aborted` is broadcast to all clients, `RUN_IN_PROGRESS` error message contains recovery guidance text.

**CLI:** unit-level test of the `run:aborted` handler (asserts stderr or the formatted message). Manual smoke in a backgrounded tab to confirm the end-to-end experience.

## Non-goals

- Cancelling the twd-js runner mid-test. Out of scope; runner maintainer (user) has confirmed it is not on the roadmap.
- Any form of keepalive or throttle-bypass. Explicitly abandoned by the prior keepalive spec.
- Detecting throttling via cross-test timing ratios (test N is M× test 1). The absolute threshold is simpler and sufficient.
- Surfacing a per-session lag warning in the relay itself. The message is only emitted when we abort; we do not warn on merely slow runs that finish.
- Changes to `twd-cli`. Headless runs are not affected by tab throttling and do not need this feature.
