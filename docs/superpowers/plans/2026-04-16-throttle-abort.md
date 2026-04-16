# Throttle Detection + Abort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect when the browser tab is being throttled by the browser (e.g. backgrounded tab) during a test run, abort the run early with a clear error message the AI/user can act on, and improve the `RUN_IN_PROGRESS` stuck-lock error to include recovery guidance.

**Architecture:** A new `src/browser/runMonitor.ts` module encapsulates "is the currently-running test past threshold?" as a small, testable state machine. `createBrowserClient` instantiates it per-run, records test start/end around the runner event callbacks, and checks it on every 3 s heartbeat tick. On threshold breach the browser emits `run:aborted` + `run:complete` (via the existing path, so the relay's lock clears via the normal `run:complete` handler). A new protocol event type, a new optional field on `RunCommand`, and one richer error message round out the relay/CLI changes. twd-js is untouched (no runner cancellation).

**Tech Stack:** TypeScript, Vitest, `ws`, happy-dom (for runMonitor unit tests). No new runtime deps.

**Spec:** [`docs/superpowers/specs/2026-04-16-throttle-abort-design.md`](../specs/2026-04-16-throttle-abort-design.md)

---

## File Structure

| File | Role |
|---|---|
| `src/relay/types.ts` | **Modify.** Add `RunAbortedEvent`, extend `RunCommand`, extend `BrowserEvent` union. |
| `src/browser/types.ts` | **Modify.** Add `maxTestDurationMs?: number` to `BrowserClientOptions`. |
| `src/relay/createTwdRelay.ts` | **Modify.** Expand the `RUN_IN_PROGRESS` error string. No behavior change. |
| `src/browser/runMonitor.ts` | **New.** Small factory: tracks current test + threshold, reports "should abort?" to the caller. No I/O. |
| `src/tests/browser/runMonitor.spec.ts` | **New.** Unit tests for the monitor, node env (no DOM needed). |
| `src/browser/createBrowserClient.ts` | **Modify.** Wire `runMonitor` into `handleRunCommand`: instantiate per run, record start/end in runner callbacks, check in heartbeat tick, emit `run:aborted` + `run:complete`, short-circuit trailing events and end-of-function. |
| `src/tests/relay/createTwdRelay.spec.ts` | **Modify.** Add tests: `maxTestDurationMs` is forwarded to the browser, `run:aborted` events are broadcast to clients, `RUN_IN_PROGRESS` message contains recovery guidance. |
| `src/cli/standalone.ts` | **Modify.** Parse a new `--max-test-duration <ms>` flag for the `run` subcommand; update help; pass through to `run()`. |
| `src/cli/run.ts` | **Modify.** Add `maxTestDurationMs` to `RunOptions`. Include it in the `run` payload when defined. Handle incoming `run:aborted` with the clear multi-line error message; set `failed = true`. |
| `README.md` | **Modify.** Short note describing the abort threshold and recovery path. |
| `CLAUDE.md` (twd-relay) | **Modify.** One-sentence mention of the abort-on-throttle behavior alongside the heartbeat-recovery note. |

---

## Task 1: Protocol types

**Files:**
- Modify: `src/relay/types.ts`
- Modify: `src/browser/types.ts`

- [ ] **Step 1: Add `RunAbortedEvent` and extend `RunCommand` in `src/relay/types.ts`**

Find the `RunCommand` interface (around line 17) and add the new optional field so it reads:

```ts
export interface RunCommand {
  type: 'run';
  scope: 'all';
  testNames?: string[];
  /** Max wall-clock ms any single test may run before the browser aborts
   *  the run with reason 'throttled'. 0 disables detection. Omit to let
   *  the browser use its own default (10000). */
  maxTestDurationMs?: number;
}
```

Find the `RunAbandonedEvent` interface (around line 86) and directly after it add:

```ts
export interface RunAbortedEvent {
  type: 'run:aborted';
  reason: 'throttled';
  durationMs: number;
  testName: string;
}
```

Find the `BrowserEvent` union (around line 91) and add `RunAbortedEvent` to it so it reads:

```ts
export type BrowserEvent =
  | ConnectedEvent
  | RunStartEvent
  | TestStartEvent
  | TestPassEvent
  | TestFailEvent
  | TestSkipEvent
  | RunCompleteEvent
  | RunAbandonedEvent
  | RunAbortedEvent;
```

- [ ] **Step 2: Add `maxTestDurationMs` to `BrowserClientOptions` in `src/browser/types.ts`**

After the existing `log` field inside `BrowserClientOptions`, add:

```ts
  /**
   * Maximum wall-clock ms any single test may run before the browser
   * aborts the run with reason 'throttled'. Typically triggered when the
   * tab is backgrounded and Chrome throttles timers. Default: 10000.
   * Set to 0 to disable detection.
   */
  maxTestDurationMs?: number;
```

- [ ] **Step 3: Type-check**

```bash
cd /Users/kevinccbsg/brikev/twd-relay
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Full test suite (sanity)**

```bash
npm run test:ci
```

Expected: all existing tests still pass (types are additive).

- [ ] **Step 5: Commit**

```bash
git add src/relay/types.ts src/browser/types.ts
git commit -m "feat: add run:aborted event type and maxTestDurationMs option"
```

---

## Task 2: Improve `RUN_IN_PROGRESS` error message (TDD)

**Files:**
- Modify: `src/tests/relay/createTwdRelay.spec.ts`
- Modify: `src/relay/createTwdRelay.ts`

- [ ] **Step 1: Write the failing test**

Open `src/tests/relay/createTwdRelay.spec.ts`. At the end of the file (inside the outermost `describe` block), append this test:

```ts
  it('RUN_IN_PROGRESS error message includes recovery guidance', async () => {
    const browser = track(await connectAs('browser'));
    const client1 = track(await connectAs('client'));
    await client1.nextMessage(); // drain connected:true

    // First run starts and is in progress
    client1.ws.send(JSON.stringify({ type: 'run', scope: 'all' }));
    await new Promise<unknown>((resolve) => browser.ws.once('message', resolve));

    // Second client tries to start another run — should get RUN_IN_PROGRESS
    const client2 = track(await connectAs('client'));
    await client2.nextMessage(); // drain connected:true
    client2.ws.send(JSON.stringify({ type: 'run', scope: 'all' }));
    const err = (await client2.nextMessage()) as { code?: string; message?: string };

    expect(err.code).toBe('RUN_IN_PROGRESS');
    expect(err.message).toContain('backgrounded');
    expect(err.message).toContain('foreground');
    expect(err.message).toContain('heartbeat');
  });
```

Note: this test uses the file's existing `track()` and `connectAs()` helpers. If the outermost `describe` block is named differently (e.g. `'Browser client protocol (integration via relay)'`), the appended test should go inside whichever existing `describe` has the `track`/`connectAs` helpers — look at the top of the file for the pattern used by existing tests.

If no `RUN_IN_PROGRESS`-oriented `describe` exists, simply append the test at the end of whichever `describe` already contains WebSocket connection tests against the relay (in `src/tests/relay/createTwdRelay.spec.ts`, this will be the main `describe` that sets up `server`, `relay`, and `connections`).

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/tests/relay/createTwdRelay.spec.ts
```

Expected: this test FAILS because the existing error string is `'A test run is already in progress'` — it does not contain `backgrounded`, `foreground`, or `heartbeat`.

- [ ] **Step 3: Update the error message**

Open `src/relay/createTwdRelay.ts`. Find:

```ts
      if (runInProgress) {
        sendError(ws, 'RUN_IN_PROGRESS', 'A test run is already in progress');
        return;
      }
```

Replace with:

```ts
      if (runInProgress) {
        sendError(
          ws,
          'RUN_IN_PROGRESS',
          'A test run is already in progress. If the previous run appears stuck, ' +
            'the browser tab may be backgrounded and throttled — foreground the TWD tab ' +
            '(identified by the "[TWD …]" title prefix) or reload it. The relay also ' +
            'auto-clears the lock after 120s of heartbeat silence.'
        );
        return;
      }
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/tests/relay/createTwdRelay.spec.ts
```

Expected: all tests pass, including the new one.

- [ ] **Step 5: Commit**

```bash
git add src/relay/createTwdRelay.ts src/tests/relay/createTwdRelay.spec.ts
git commit -m "feat: expand RUN_IN_PROGRESS error with recovery guidance"
```

---

## Task 3: `runMonitor` module skeleton

**Files:**
- Create: `src/browser/runMonitor.ts`

A skeleton with types + a no-op factory. Gives Task 4 something to TDD against and keeps the commit series linear.

- [ ] **Step 1: Create the file**

Create `src/browser/runMonitor.ts`:

```ts
export interface RunMonitor {
  onTestStart(name: string): void;
  onTestEnd(): void;
  checkThreshold(): { testName: string; durationMs: number } | null;
  markAborted(): void;
  isAborted(): boolean;
}

export interface RunMonitorOptions {
  /** Max wall-clock ms any single test may run. 0 disables detection. */
  thresholdMs: number;
  /** Clock function; defaults to performance.now. Override for testing. */
  now?: () => number;
}

export function createRunMonitor(options: RunMonitorOptions): RunMonitor {
  // Implemented in Task 4.
  void options;
  return {
    onTestStart() {},
    onTestEnd() {},
    checkThreshold() {
      return null;
    },
    markAborted() {},
    isAborted() {
      return false;
    },
  };
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/browser/runMonitor.ts
git commit -m "feat: add RunMonitor type + skeleton factory"
```

---

## Task 4: `runMonitor` behavior (TDD)

**Files:**
- Create: `src/tests/browser/runMonitor.spec.ts`
- Modify: `src/browser/runMonitor.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/tests/browser/runMonitor.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createRunMonitor } from '../../browser/runMonitor';

function makeClock() {
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

describe('runMonitor', () => {
  it('is not aborted on construction', () => {
    const monitor = createRunMonitor({ thresholdMs: 1000 });
    expect(monitor.isAborted()).toBe(false);
  });

  it('checkThreshold returns null when no test is in flight', () => {
    const monitor = createRunMonitor({ thresholdMs: 1000 });
    expect(monitor.checkThreshold()).toBeNull();
  });

  it('checkThreshold returns null when the current test is under threshold', () => {
    const clock = makeClock();
    const monitor = createRunMonitor({ thresholdMs: 1000, now: clock.now });
    monitor.onTestStart('fast test');
    clock.advance(500);
    expect(monitor.checkThreshold()).toBeNull();
  });

  it('checkThreshold returns test name + duration when threshold is exceeded', () => {
    const clock = makeClock();
    const monitor = createRunMonitor({ thresholdMs: 1000, now: clock.now });
    monitor.onTestStart('slow test');
    clock.advance(1500);
    const result = monitor.checkThreshold();
    expect(result).not.toBeNull();
    expect(result?.testName).toBe('slow test');
    expect(result?.durationMs).toBe(1500);
  });

  it('onTestEnd clears the current test — checkThreshold then returns null', () => {
    const clock = makeClock();
    const monitor = createRunMonitor({ thresholdMs: 1000, now: clock.now });
    monitor.onTestStart('test');
    clock.advance(2000);
    monitor.onTestEnd();
    expect(monitor.checkThreshold()).toBeNull();
  });

  it('markAborted flips isAborted to true', () => {
    const monitor = createRunMonitor({ thresholdMs: 1000 });
    monitor.markAborted();
    expect(monitor.isAborted()).toBe(true);
  });

  it('thresholdMs 0 disables detection even for arbitrarily long tests', () => {
    const clock = makeClock();
    const monitor = createRunMonitor({ thresholdMs: 0, now: clock.now });
    monitor.onTestStart('forever');
    clock.advance(1_000_000);
    expect(monitor.checkThreshold()).toBeNull();
  });

  it('consecutive onTestStart replaces the tracked test', () => {
    const clock = makeClock();
    const monitor = createRunMonitor({ thresholdMs: 1000, now: clock.now });
    monitor.onTestStart('first');
    clock.advance(500);
    monitor.onTestStart('second');
    clock.advance(600);
    // 600 ms since 'second' started, under threshold
    expect(monitor.checkThreshold()).toBeNull();
    clock.advance(500);
    const result = monitor.checkThreshold();
    expect(result?.testName).toBe('second');
    expect(result?.durationMs).toBe(1100);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/tests/browser/runMonitor.spec.ts
```

Expected: FAIL — the skeleton returns hardcoded null/false values, so checks like "returns test name + duration when threshold is exceeded" and "markAborted flips isAborted to true" all fail.

- [ ] **Step 3: Replace the factory with a real implementation**

Replace the entire contents of `src/browser/runMonitor.ts` with:

```ts
export interface RunMonitor {
  onTestStart(name: string): void;
  onTestEnd(): void;
  checkThreshold(): { testName: string; durationMs: number } | null;
  markAborted(): void;
  isAborted(): boolean;
}

export interface RunMonitorOptions {
  /** Max wall-clock ms any single test may run. 0 disables detection. */
  thresholdMs: number;
  /** Clock function; defaults to performance.now. Override for testing. */
  now?: () => number;
}

export function createRunMonitor(options: RunMonitorOptions): RunMonitor {
  const now = options.now ?? (() => performance.now());
  const thresholdMs = options.thresholdMs;

  let currentTestStart: number | null = null;
  let currentTestName: string | null = null;
  let aborted = false;

  return {
    onTestStart(name: string): void {
      currentTestStart = now();
      currentTestName = name;
    },
    onTestEnd(): void {
      currentTestStart = null;
      currentTestName = null;
    },
    checkThreshold() {
      if (thresholdMs <= 0) return null;
      if (currentTestStart === null || currentTestName === null) return null;
      const durationMs = now() - currentTestStart;
      if (durationMs <= thresholdMs) return null;
      return { testName: currentTestName, durationMs };
    },
    markAborted(): void {
      aborted = true;
    },
    isAborted(): boolean {
      return aborted;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/tests/browser/runMonitor.spec.ts
```

Expected: all 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/browser/runMonitor.ts src/tests/browser/runMonitor.spec.ts
git commit -m "feat: implement runMonitor threshold detection"
```

---

## Task 5: Integrate `runMonitor` into `createBrowserClient`

**Files:**
- Modify: `src/browser/createBrowserClient.ts`

This task wires the monitor into `handleRunCommand`. No new unit tests here — the monitor's logic is covered in Task 4, and the end-to-end abort protocol is covered by the relay test in Task 6 plus the manual smoke test in Task 8.

- [ ] **Step 1: Add the import at the top of the file**

Open `src/browser/createBrowserClient.ts`. After the existing `import { createFaviconManager } from './faviconManager';` line, add:

```ts
import { createRunMonitor } from './runMonitor';
```

(If the codebase no longer has that exact import line — e.g. the favicon module was renamed — insert after whichever other local `./*` import appears near the top.)

- [ ] **Step 2: Capture `maxTestDurationMs` from options**

Inside `createBrowserClient`, near the other option destructuring (around the line `const enableLog = options?.log ?? false;`), add:

```ts
  const defaultMaxTestDurationMs = options?.maxTestDurationMs ?? 10_000;
```

Do NOT clamp, validate, or mutate — let the raw number flow through. `0` means disabled per the spec.

- [ ] **Step 3: Extend `handleRunCommand` signature + call site to pass the full parsed message**

Find the current signature:

```ts
async function handleRunCommand(testNames?: string[]): Promise<void> {
```

Change it to:

```ts
async function handleRunCommand(
  testNames?: string[],
  parsed: { maxTestDurationMs?: number } = {},
): Promise<void> {
```

Then in `handleMessage` (lower in the same file), find the call `handleRunCommand(testNames);` and change it to `handleRunCommand(testNames, parsed);`. At this point the file still type-checks — `parsed` is just declared but unused.

- [ ] **Step 4: Resolve threshold + instantiate monitor at the top of `handleRunCommand`**

Near the top of the function body, before the existing `const heartbeatInterval = setInterval(...)` line, add:

```ts
    const thresholdMs =
      typeof parsed.maxTestDurationMs === 'number'
        ? parsed.maxTestDurationMs
        : defaultMaxTestDurationMs;
    const monitor = createRunMonitor({ thresholdMs });
```

- [ ] **Step 5: Update the heartbeat `setInterval` to check threshold**

Find the existing block:

```ts
    const heartbeatInterval = setInterval(() => {
      send({ type: 'heartbeat' });
    }, 3000);
```

Replace with:

```ts
    const heartbeatInterval = setInterval(() => {
      send({ type: 'heartbeat' });
      const breach = monitor.checkThreshold();
      if (!breach || monitor.isAborted()) return;
      monitor.markAborted();
      send({
        type: 'run:aborted',
        reason: 'throttled',
        durationMs: breach.durationMs,
        testName: breach.testName,
      });
      send({
        type: 'run:complete',
        passed,
        failed,
        skipped,
        duration: performance.now() - runStart,
      });
      clearInterval(heartbeatInterval);
    }, 3000);
```

The references to `passed`, `failed`, `skipped`, and `runStart` must exist in the surrounding scope by the time this closure runs. In the current file they are declared further down inside the `try` block. Move those declarations up so the closure can close over them. Specifically, relocate these four lines from their current position in the file:

```ts
      let passed = 0;
      let failed = 0;
      let skipped = 0;
      const runStart = performance.now();
```

to just after the `faviconManager.set('running');` line (or wherever sits at the top of `handleRunCommand`'s body before the `try`), so the heartbeat closure sees them. Remove the original declarations from their old position inside the try-block.

- [ ] **Step 6: Hook the runner event callbacks**

Inside the `events: TwdRunnerEvents` literal, update each callback to interact with the monitor and short-circuit when aborted.

Find the `onStart` callback and change its body from:

```ts
        onStart(test: TwdHandler) {
          test.status = 'running';
          dispatchStateChange();
          send({
            type: 'test:start',
            id: test.id,
            name: test.name,
            suite: getSuiteName(test, handlers),
          });
        },
```

to:

```ts
        onStart(test: TwdHandler) {
          if (monitor.isAborted()) return;
          monitor.onTestStart(test.name);
          test.status = 'running';
          dispatchStateChange();
          send({
            type: 'test:start',
            id: test.id,
            name: test.name,
            suite: getSuiteName(test, handlers),
          });
        },
```

For `onPass`, change the body:

```ts
        onPass(test: TwdHandler) {
          passed++;
          test.status = 'pass';
          dispatchStateChange();
          send({
            type: 'test:pass',
            id: test.id,
            name: test.name,
            suite: getSuiteName(test, handlers),
            duration: performance.now() - runStart,
          });
        },
```

to:

```ts
        onPass(test: TwdHandler) {
          monitor.onTestEnd();
          if (monitor.isAborted()) return;
          passed++;
          test.status = 'pass';
          dispatchStateChange();
          send({
            type: 'test:pass',
            id: test.id,
            name: test.name,
            suite: getSuiteName(test, handlers),
            duration: performance.now() - runStart,
          });
        },
```

For `onFail`, change the body:

```ts
        onFail(test: TwdHandler, error: Error) {
          failed++;
          test.status = 'fail';
          test.logs = [error.message];
          dispatchStateChange();
          send({
            type: 'test:fail',
            id: test.id,
            name: test.name,
            suite: getSuiteName(test, handlers),
            error: error.message,
            duration: performance.now() - runStart,
          });
        },
```

to:

```ts
        onFail(test: TwdHandler, error: Error) {
          monitor.onTestEnd();
          if (monitor.isAborted()) return;
          failed++;
          test.status = 'fail';
          test.logs = [error.message];
          dispatchStateChange();
          send({
            type: 'test:fail',
            id: test.id,
            name: test.name,
            suite: getSuiteName(test, handlers),
            error: error.message,
            duration: performance.now() - runStart,
          });
        },
```

For `onSkip`, change the body:

```ts
        onSkip(test: TwdHandler) {
          skipped++;
          test.status = 'skip';
          dispatchStateChange();
          send({
            type: 'test:skip',
            id: test.id,
            name: test.name,
            suite: getSuiteName(test, handlers),
          });
        },
```

to:

```ts
        onSkip(test: TwdHandler) {
          monitor.onTestEnd();
          if (monitor.isAborted()) return;
          skipped++;
          test.status = 'skip';
          dispatchStateChange();
          send({
            type: 'test:skip',
            id: test.id,
            name: test.name,
            suite: getSuiteName(test, handlers),
          });
        },
```

For `onSuiteStart` and `onSuiteEnd`, prefix each body with `if (monitor.isAborted()) return;` — these are silent in the current implementation apart from state mutation + `dispatchStateChange`, but skipping them after abort keeps the UI state consistent.

- [ ] **Step 7: Guard the end-of-function `run:complete`**

Find the existing block:

```ts
      const duration = performance.now() - runStart;
      send({ type: 'run:complete', passed, failed, skipped, duration });
      faviconManager.set(failed > 0 ? 'fail' : 'pass');
      dispatchStateChange();
```

Replace with:

```ts
      const duration = performance.now() - runStart;
      if (!monitor.isAborted()) {
        send({ type: 'run:complete', passed, failed, skipped, duration });
        faviconManager.set(failed > 0 ? 'fail' : 'pass');
      } else {
        // Abort already sent its own run:complete; paint the tab as failed
        // so the user sees the abnormal termination.
        faviconManager.set('fail');
      }
      dispatchStateChange();
```

- [ ] **Step 8: Handle the NO_MATCH early-return identically**

Find the NO_MATCH branch in `handleRunCommand`. It sends its own `run:start` + `error` + `run:complete` + `faviconManager.set('pass')`. No change needed here — when there are no tests to run, the monitor never sees an `onTestStart`, so `checkThreshold` always returns null and `isAborted()` stays false. The existing code path is already correct.

- [ ] **Step 9: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 10: Full test suite**

```bash
npm run test:ci
```

Expected: all existing tests pass + the Task 4 runMonitor tests pass. No new tests added in this task — Task 6 covers the relay-side integration.

- [ ] **Step 11: Build**

```bash
npm run build
```

Expected: clean build. No new warnings.

- [ ] **Step 12: Commit**

```bash
git add src/browser/createBrowserClient.ts
git commit -m "feat: wire runMonitor into browser client for throttle-based abort"
```

---

## Task 6: Relay tests for `run:aborted` broadcast + `maxTestDurationMs` forwarding

**Files:**
- Modify: `src/tests/relay/createTwdRelay.spec.ts`

The relay currently broadcasts any browser message that isn't a heartbeat or `run:complete` (see `handleBrowserMessage` in `createTwdRelay.ts`), and it forwards the raw `run` command bytes to the browser via `browser.send(data)`. So no relay implementation change is needed for the new event or the new field — but we want tests to pin these behaviors down so future refactors don't silently break them.

- [ ] **Step 1: Write the failing tests (they will actually pass immediately, per above — they're regression guards)**

Open `src/tests/relay/createTwdRelay.spec.ts`. Inside the same `describe` block where the Task 2 RUN_IN_PROGRESS test lives, append:

```ts
  it('forwards maxTestDurationMs in run command to the browser', async () => {
    const browser = track(await connectAs('browser'));
    const client = track(await connectAs('client'));
    await client.nextMessage(); // drain connected:true

    client.ws.send(JSON.stringify({ type: 'run', scope: 'all', maxTestDurationMs: 5000 }));
    const forwarded = (await new Promise<string>((resolve) => {
      browser.ws.once('message', (data) => resolve(data.toString()));
    }));
    const parsed = JSON.parse(forwarded) as { type: string; maxTestDurationMs?: number };

    expect(parsed.type).toBe('run');
    expect(parsed.maxTestDurationMs).toBe(5000);
  });

  it('broadcasts run:aborted events from the browser to all clients', async () => {
    const browser = track(await connectAs('browser'));
    const client = track(await connectAs('client'));
    await client.nextMessage(); // drain connected:true

    browser.ws.send(JSON.stringify({
      type: 'run:aborted',
      reason: 'throttled',
      durationMs: 12000,
      testName: 'some slow test',
    }));

    const received = (await client.nextMessage()) as {
      type: string;
      reason?: string;
      durationMs?: number;
      testName?: string;
    };
    expect(received.type).toBe('run:aborted');
    expect(received.reason).toBe('throttled');
    expect(received.durationMs).toBe(12000);
    expect(received.testName).toBe('some slow test');
  });
```

- [ ] **Step 2: Run the tests — they should pass immediately**

```bash
npx vitest run src/tests/relay/createTwdRelay.spec.ts
```

Expected: all tests PASS, including the two new ones. If either new test fails, the relay's forwarding or broadcasting logic has changed and should be investigated before proceeding.

- [ ] **Step 3: Commit**

```bash
git add src/tests/relay/createTwdRelay.spec.ts
git commit -m "test: pin maxTestDurationMs forwarding and run:aborted broadcasting"
```

---

## Task 7: CLI — `--max-test-duration` flag, forwarding, and `run:aborted` handler

**Files:**
- Modify: `src/cli/standalone.ts`
- Modify: `src/cli/run.ts`

- [ ] **Step 1: Add `maxTestDurationMs` to `RunOptions` in `src/cli/run.ts`**

Find the `RunOptions` interface near the top of the file and add a new field so it reads:

```ts
export interface RunOptions {
  port: number;
  timeout: number;
  path: string;
  host: string;
  testNames?: string[];
  maxTestDurationMs?: number;
}
```

- [ ] **Step 2: Destructure and forward `maxTestDurationMs` in the `run` function**

Inside `run(options: RunOptions): void`, update the destructure line to include `maxTestDurationMs`:

```ts
  const { port, timeout, path, host, testNames, maxTestDurationMs } = options;
```

Find the block that builds `runMsg` when the `connected` event arrives:

```ts
      case 'connected':
        if (msg.browser && !runSent) {
          runSent = true;
          console.log('Browser connected, triggering test run...\n');
          const runMsg: Record<string, unknown> = { type: 'run', scope: 'all' };
          if (testNames?.length) runMsg.testNames = testNames;
          ws.send(JSON.stringify(runMsg));
        } else if (!msg.browser) {
          console.log('Waiting for browser to connect...');
        }
        break;
```

Replace with:

```ts
      case 'connected':
        if (msg.browser && !runSent) {
          runSent = true;
          console.log('Browser connected, triggering test run...\n');
          const runMsg: Record<string, unknown> = { type: 'run', scope: 'all' };
          if (testNames?.length) runMsg.testNames = testNames;
          if (maxTestDurationMs !== undefined) runMsg.maxTestDurationMs = maxTestDurationMs;
          ws.send(JSON.stringify(runMsg));
        } else if (!msg.browser) {
          console.log('Waiting for browser to connect...');
        }
        break;
```

- [ ] **Step 3: Handle `run:aborted` in the CLI message switch**

In the same file, inside the `switch (msg.type)` block, add a new case immediately before the existing `case 'run:abandoned':`:

```ts
      case 'run:aborted': {
        failed = true;
        const seconds = typeof msg.durationMs === 'number' ? (msg.durationMs / 1000).toFixed(1) : '?';
        console.error(
          `\nRun aborted: test "${msg.testName ?? '?'}" ran for ${seconds}s — threshold exceeded.\n` +
            `The TWD browser tab is likely backgrounded and throttled by the browser.\n` +
            `Foreground the TWD tab (identified by the "[TWD …]" title prefix) and keep it active, then retry.\n` +
            `For unattended runs, prefer \`twd-cli\` which drives a headless browser with no tab throttling.`
        );
        break;
      }
```

No process.exit here — the `run:complete` that the browser sends immediately after will trigger the existing exit path, and `failed = true` ensures the exit code is 1.

- [ ] **Step 4: Add the `--max-test-duration` flag in `src/cli/standalone.ts`**

Find the `run` subcommand block (starts with `if (subcommand === 'run') {`). Add a new flag parse after `const testNames = parseFlagAll('--test');`:

```ts
  const maxDurationStr = parseFlag('--max-test-duration');
  let maxTestDurationMs: number | undefined;
  if (maxDurationStr !== undefined) {
    maxTestDurationMs = parseInt(maxDurationStr, 10);
    if (isNaN(maxTestDurationMs)) {
      console.error('Invalid --max-test-duration value:', maxDurationStr);
      process.exit(1);
    }
  }
```

Then update the `run()` call to pass the value:

```ts
  run({
    port,
    timeout,
    path: pathFlag,
    host: hostFlag,
    testNames: testNames.length > 0 ? testNames : undefined,
    maxTestDurationMs,
  });
```

- [ ] **Step 5: Update the help text**

In the same file, find the `run` options block inside `printHelp()` (look for the line containing `--test <name>`):

```ts
Options for run:
  --port <port>      Relay port to connect to (default: 5173)
  --host <host>      Relay host to connect to (default: localhost)
  --path <path>      WebSocket path (default: /__twd/ws)
  --timeout <ms>     Timeout in ms (default: 180000)
  --test <name>      Filter tests by name substring (repeatable)
```

Replace with:

```ts
Options for run:
  --port <port>                   Relay port to connect to (default: 5173)
  --host <host>                   Relay host to connect to (default: localhost)
  --path <path>                   WebSocket path (default: /__twd/ws)
  --timeout <ms>                  Timeout in ms (default: 180000)
  --test <name>                   Filter tests by name substring (repeatable)
  --max-test-duration <ms>        Abort if any single test exceeds this many
                                  ms (default from browser client, typically
                                  10000; 0 disables)
```

Update the example block to include a `--max-test-duration` example; find:

```ts
  twd-relay run --test "login"           # run tests matching "login"
  twd-relay run --test "login" --test "signup"  # run multiple
```

And replace with:

```ts
  twd-relay run --test "login"           # run tests matching "login"
  twd-relay run --test "login" --test "signup"  # run multiple
  twd-relay run --max-test-duration 30000         # raise abort threshold to 30s
  twd-relay run --max-test-duration 0             # disable abort detection`);
```

Note: the backtick and closing parenthesis in the last example match the existing `printHelp` template-string close. Match the exact syntax of the existing `console.log(\`...\`);` call — add the two example lines inside the existing backtick block, not after it.

- [ ] **Step 6: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Build**

```bash
npm run build
```

Expected: clean build for the CLI + library entries.

- [ ] **Step 8: Spot-check the help text**

```bash
node dist/cli.js --help
```

Expected: the help output includes the new `--max-test-duration` row and the two new examples.

- [ ] **Step 9: Commit**

```bash
git add src/cli/run.ts src/cli/standalone.ts
git commit -m "feat: CLI --max-test-duration flag + run:aborted handler"
```

---

## Task 8: Manual smoke test

**Files:** none modified.

- [ ] **Step 1: Fresh build**

```bash
cd /Users/kevinccbsg/brikev/twd-relay
npm run build
```

- [ ] **Step 2: Start the relay**

In one terminal:

```bash
npm run relay
```

- [ ] **Step 3: Start the example app**

In another terminal:

```bash
cd examples/twd-test-app
npm run dev
```

- [ ] **Step 4: Foreground baseline**

Open the app URL in a browser. Keep the tab focused. From a third terminal:

```bash
cd /Users/kevinccbsg/brikev/twd-relay
npm run send-run
```

Expected: tests pass in ~1 s. No `run:aborted` message. Exit code 0.

- [ ] **Step 5: Lower the threshold to force a trip**

Still in the foreground tab, force an abort by setting a tiny threshold:

```bash
node dist/cli.js run --port 5173 --max-test-duration 50
```

Expected: within ~3 s, CLI prints a `Run aborted: …` message with the slow test name and duration. CLI exits 1. No traceback or stack.

- [ ] **Step 6: Verify the lock-clear behavior**

Immediately re-run with the normal threshold:

```bash
npm run send-run
```

Expected: run starts successfully (no `RUN_IN_PROGRESS` error). All tests pass. Exit 0.

- [ ] **Step 7: Background-tab scenario**

Switch to a different browser tab so the TWD tab is hidden. From the terminal:

```bash
npm run send-run
```

Expected: within ~3 s of whichever test crosses 10 s, CLI prints the abort message. You should see test results up to the slow test, then the multi-line error, then exit 1.

- [ ] **Step 8: Verify `RUN_IN_PROGRESS` guidance surfaces**

Trigger two overlapping runs (one in a background terminal, one immediate) to produce the error:

```bash
npm run send-run &
sleep 0.2
npm run send-run
```

Expected: the second CLI invocation prints an `[RUN_IN_PROGRESS]` error whose message includes `backgrounded`, `foreground`, and `heartbeat`. Exit 1.

- [ ] **Step 9: No commit needed — verification only.**

---

## Task 9: Update docs

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md` (the twd-relay one, at `/Users/kevinccbsg/brikev/twd-relay/CLAUDE.md`)

- [ ] **Step 1: README note**

Open `README.md`. Locate the favicon-state table added by the prior favicon feature (search for `[TWD ✓]`). Directly after the paragraph that follows the table, insert a new subsection:

```markdown

### Aborting throttled runs

Chrome aggressively throttles timers in backgrounded tabs, which can stretch a 1-second test run to 30+ seconds. To avoid AI/CI hangs, the browser client monitors per-test wall-clock time. If any single test runs longer than 10 seconds (configurable), the browser emits `run:aborted`, the CLI prints a clear error, and the run ends with exit code 1.

Override the threshold with `--max-test-duration <ms>` on `twd-relay run`, or pass `maxTestDurationMs` to `createBrowserClient`. Set it to `0` to disable detection entirely.

For unattended runs (CI, agents), prefer `twd-cli`: it drives a headless browser where the tab is always focused and throttling doesn't apply.

```

- [ ] **Step 2: CLAUDE.md note**

Open `/Users/kevinccbsg/brikev/twd-relay/CLAUDE.md`. Find the paragraph about the browser client (search for `faviconManager` — the favicon feature added a sentence there). Append one sentence so the paragraph ends with:

> … A small `faviconManager` (in `src/browser/faviconManager.ts`) sets a colored favicon + `document.title` prefix based on connection/run state. A sibling `runMonitor` (in `src/browser/runMonitor.ts`) tracks per-test wall-clock time; on the existing 3 s heartbeat tick the browser checks whether any test has exceeded `maxTestDurationMs` (default 10 s) and, if so, emits a `run:aborted` event so the CLI can exit with a clear error instead of hanging on a throttled tab.

(Match the exact shape of the existing "small `faviconManager` (in `src/browser/faviconManager.ts`) …" sentence — extend or replace whatever is currently there so both modules are mentioned.)

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document run:aborted threshold and RUN_IN_PROGRESS recovery"
```

---

## Task 10: Final verification

**Files:** none modified.

- [ ] **Step 1: Full test run with coverage**

```bash
npm run test:ci
```

Expected: all tests pass. The previous baseline (after the favicon feature was merged to main) was 44 tests across 4 files. New total should be 44 + 8 runMonitor + 3 relay (RUN_IN_PROGRESS + forward + broadcast) = 55. Exact counts may vary; the bar is "all green and no regressions."

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: clean build.

- [ ] **Step 3: Sanity-grep the bundle**

```bash
grep -c 'run:aborted' dist/browser.es.js dist/cli.js
```

Expected: each file ≥1 — the new event type string is inlined in both the browser client bundle (emitter) and the CLI bundle (handler).

- [ ] **Step 4: Review commit series**

```bash
git log --oneline main..HEAD
```

Expected: a series of focused commits matching the task order — types, error message, skeleton, monitor, integration, relay tests, CLI, docs.

- [ ] **Step 5: Self-review the diff**

```bash
git diff main..HEAD -- src/
```

Look for: stray `console.log`, leftover skeleton comments (`// Implemented in Task N.`), unused imports, accidental reformatting of unrelated code.

---

## Definition of done

- All 8 new `runMonitor` unit tests pass.
- 3 new relay tests pass (`RUN_IN_PROGRESS` guidance, `maxTestDurationMs` forwarding, `run:aborted` broadcasting).
- Full test suite green.
- Manual smoke test confirms: forced abort with low threshold fires within ~3 s, lock clears after abort, backgrounded-tab scenario produces a clear error, `RUN_IN_PROGRESS` message contains recovery guidance.
- `npm run build` produces a clean browser + CLI bundle with the new event strings inlined.
- README and CLAUDE.md updated.
- No changes to twd-js (explicitly out of scope).
