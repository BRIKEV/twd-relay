# Run-by-Name Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `--test` flag to the CLI so AI agents can run specific tests by name substring match without editing source files.

**Architecture:** Extend `RunCommand` with optional `testNames` array. The relay forwards it as-is (already passes raw JSON). The browser client filters `window.__TWD_STATE__.handlers` by name substring and calls `runner.runByIds()` instead of `runner.runAll()`. The CLI collects repeated `--test` flags into the array.

**Tech Stack:** TypeScript, ws, vitest, twd-js/runner (`runByIds`)

**Spec:** `docs/superpowers/specs/2026-03-22-run-by-name-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/relay/types.ts` | Modify | Add `testNames?` to `RunCommand`, `'NO_MATCH'` to `TwdErrorCode` |
| `src/browser/createBrowserClient.ts` | Modify | Filter handlers by name, call `runByIds`, handle NO_MATCH |
| `src/cli/run.ts` | Modify | Add `testNames?` to `RunOptions`, include in WS message |
| `src/cli/standalone.ts` | Modify | Add `parseFlagAll`, parse `--test`, update help text |
| `src/tests/relay/createTwdRelay.spec.ts` | Modify | Add test: relay forwards `testNames` field to browser |
| `src/tests/browser/createBrowserClient.spec.ts` | Modify | Add tests: run with testNames, NO_MATCH error path |

---

### Task 1: Protocol — extend types

**Files:**
- Modify: `src/relay/types.ts:17-20` (RunCommand)
- Modify: `src/relay/types.ts:90-94` (TwdErrorCode)

- [ ] **Step 1: Add `testNames` to `RunCommand`**

In `src/relay/types.ts`, change:

```ts
export interface RunCommand {
  type: 'run';
  scope: 'all';
  testNames?: string[];
}
```

- [ ] **Step 2: Add `'NO_MATCH'` to `TwdErrorCode`**

```ts
export type TwdErrorCode =
  | 'NO_BROWSER'
  | 'RUN_IN_PROGRESS'
  | 'UNKNOWN_COMMAND'
  | 'INVALID_MESSAGE'
  | 'NO_MATCH';
```

- [ ] **Step 3: Run existing tests to confirm nothing breaks**

Run: `npx vitest run`
Expected: All 21 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/relay/types.ts
git commit -m "feat: add testNames to RunCommand and NO_MATCH error code"
```

---

### Task 2: Relay — test that `testNames` passes through

**Files:**
- Modify: `src/tests/relay/createTwdRelay.spec.ts`

The relay already forwards raw JSON to the browser (`browser.send(data)` at `src/relay/createTwdRelay.ts:80`). We add a test to document this behavior for `testNames`.

- [ ] **Step 1: Write the test**

Add after the existing "should forward run command to browser" test (line ~141):

```ts
it('should forward run command with testNames to browser', async () => {
  const browser = track(await connectAs('browser'));
  const client = track(await connectAs('client'));
  // Drain connected message
  await client.nextMessage();

  client.ws.send(JSON.stringify({ type: 'run', scope: 'all', testNames: ['adds numbers'] }));
  const msg = await browser.nextMessage();

  expect(msg).toEqual({ type: 'run', scope: 'all', testNames: ['adds numbers'] });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run src/tests/relay/createTwdRelay.spec.ts`
Expected: PASS (relay already forwards raw data, so this should pass immediately)

- [ ] **Step 3: Commit**

```bash
git add src/tests/relay/createTwdRelay.spec.ts
git commit -m "test: verify relay forwards testNames in run command"
```

---

### Task 3: Browser client — filtering and `runByIds`

**Files:**
- Modify: `src/browser/createBrowserClient.ts:86-175` (handleRunCommand)
- Modify: `src/browser/createBrowserClient.ts:201-215` (handleMessage)

- [ ] **Step 1: Update `handleMessage` to extract `testNames`**

In `src/browser/createBrowserClient.ts`, change `handleMessage` (line ~201-215):

```ts
function handleMessage(event: MessageEvent): void {
  let parsed: { type?: string; testNames?: string[] };
  try {
    parsed = JSON.parse(event.data);
  } catch {
    return;
  }

  if (parsed.type === 'run') {
    log('Received run command — running tests...');
    const testNames = Array.isArray(parsed.testNames) ? parsed.testNames : undefined;
    handleRunCommand(testNames);
  } else if (parsed.type === 'status') {
    handleStatusCommand();
  }
}
```

- [ ] **Step 2: Add `testNames` parameter and filtering to `handleRunCommand`**

Change `handleRunCommand` signature and add filtering logic before the runner call. The full updated function:

```ts
async function handleRunCommand(testNames?: string[]): Promise<void> {
  const twdState = window.__TWD_STATE__;
  if (!twdState) {
    warn('TWD not initialized — make sure twd-js is loaded before running tests');
    send({ type: 'error', code: 'NO_TWD', message: 'TWD not initialized' });
    return;
  }

  const handlers = twdState.handlers;
  let testIds: string[] | undefined;

  if (testNames && testNames.length > 0) {
    const lowerNames = testNames.map(n => n.toLowerCase());
    const matched: string[] = [];
    for (const [, handler] of handlers) {
      if (handler.type === 'test') {
        const lowerName = handler.name.toLowerCase();
        if (lowerNames.some(n => lowerName.includes(n))) {
          matched.push(handler.id);
        }
      }
    }

    if (matched.length === 0) {
      const available = Array.from(handlers.values())
        .filter(h => h.type === 'test')
        .map(h => h.name);
      send({ type: 'run:start', testCount: 0 });
      send({
        type: 'error',
        code: 'NO_MATCH',
        message: `No tests matched: ${JSON.stringify(testNames)}. Available tests: ${JSON.stringify(available)}`,
      });
      send({ type: 'run:complete', passed: 0, failed: 0, skipped: 0, duration: 0 });
      return;
    }

    testIds = matched;
  }

  const testCount = testIds
    ? testIds.length
    : Array.from(handlers.values()).filter(h => h.type === 'test').length;
  send({ type: 'run:start', testCount });

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const runStart = performance.now();

  const events: TwdRunnerEvents = {
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
    onSuiteStart(suite: TwdHandler) {
      suite.status = 'running';
      dispatchStateChange();
    },
    onSuiteEnd(suite: TwdHandler) {
      suite.status = 'idle';
      dispatchStateChange();
    },
  };

  try {
    const { TestRunner } = await import('twd-js/runner');
    const runner = new TestRunner(events);
    if (testIds) {
      await runner.runByIds(testIds);
    } else {
      await runner.runAll();
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    warn('Runner error:', errorMsg);
    send({ type: 'error', code: 'RUNNER_ERROR', message: errorMsg });
  }

  const duration = performance.now() - runStart;
  send({ type: 'run:complete', passed, failed, skipped, duration });
  dispatchStateChange();
}
```

- [ ] **Step 3: Run existing tests**

Run: `npx vitest run`
Expected: All existing tests still pass (browser client tests are integration tests through the relay with simulated browsers, so they don't directly call `handleRunCommand`).

- [ ] **Step 4: Commit**

```bash
git add src/browser/createBrowserClient.ts
git commit -m "feat: browser client filters tests by name and calls runByIds"
```

---

### Task 4: Browser client — integration tests for filtering

**Files:**
- Modify: `src/tests/browser/createBrowserClient.spec.ts`

These tests simulate a browser that understands `testNames` — matching the pattern from existing tests where the browser-role connection responds to commands.

- [ ] **Step 1: Write test for run with testNames forwarded to browser**

Add after the existing "should handle browser reconnection" test (line ~175):

```ts
it('should forward testNames in run command to browser', async () => {
  const browser = track(await connectAs('browser'));
  const client = track(await connectAs('client'));
  await client.nextMessage();

  // Browser responds to filtered run
  browser.ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'run' && msg.testNames) {
      // Simulate: only matched test runs
      browser.ws.send(JSON.stringify({ type: 'run:start', testCount: 1 }));
      browser.ws.send(JSON.stringify({ type: 'test:start', id: '1', name: 'adds numbers', suite: 'Math' }));
      browser.ws.send(JSON.stringify({ type: 'test:pass', id: '1', name: 'adds numbers', suite: 'Math', duration: 5 }));
      browser.ws.send(JSON.stringify({ type: 'run:complete', passed: 1, failed: 0, skipped: 0, duration: 5 }));
    }
  });

  client.ws.send(JSON.stringify({ type: 'run', scope: 'all', testNames: ['adds'] }));

  const messages: unknown[] = [];
  for (let i = 0; i < 4; i++) {
    messages.push(await client.nextMessage());
  }

  expect(messages[0]).toEqual({ type: 'run:start', testCount: 1 });
  expect(messages[1]).toEqual({ type: 'test:start', id: '1', name: 'adds numbers', suite: 'Math' });
  expect(messages[2]).toEqual({ type: 'test:pass', id: '1', name: 'adds numbers', suite: 'Math', duration: 5 });
  expect(messages[3]).toEqual({ type: 'run:complete', passed: 1, failed: 0, skipped: 0, duration: 5 });
});

it('should handle NO_MATCH and still clear run lock', async () => {
  const browser = track(await connectAs('browser'));
  const client = track(await connectAs('client'));
  await client.nextMessage();

  // Browser responds with NO_MATCH sequence
  browser.ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'run' && msg.testNames) {
      browser.ws.send(JSON.stringify({ type: 'run:start', testCount: 0 }));
      browser.ws.send(JSON.stringify({ type: 'error', code: 'NO_MATCH', message: 'No tests matched: ["nonexistent"]' }));
      browser.ws.send(JSON.stringify({ type: 'run:complete', passed: 0, failed: 0, skipped: 0, duration: 0 }));
    }
  });

  client.ws.send(JSON.stringify({ type: 'run', scope: 'all', testNames: ['nonexistent'] }));

  const msg1 = await client.nextMessage();
  expect(msg1).toEqual({ type: 'run:start', testCount: 0 });

  const msg2 = await client.nextMessage();
  expect(msg2).toMatchObject({ type: 'error', code: 'NO_MATCH' });

  const msg3 = await client.nextMessage();
  expect(msg3).toEqual({ type: 'run:complete', passed: 0, failed: 0, skipped: 0, duration: 0 });

  // Verify run lock is cleared — can start another run
  client.ws.send(JSON.stringify({ type: 'run', scope: 'all' }));
  const browserMsg = await browser.nextMessage();
  expect(browserMsg).toEqual({ type: 'run', scope: 'all' });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/tests/browser/createBrowserClient.spec.ts`
Expected: All tests pass (including the two new ones).

- [ ] **Step 3: Commit**

```bash
git add src/tests/browser/createBrowserClient.spec.ts
git commit -m "test: integration tests for testNames filtering and NO_MATCH"
```

---

### Task 5: CLI — `run.ts` accepts and sends `testNames`

**Files:**
- Modify: `src/cli/run.ts:2-8` (RunOptions)
- Modify: `src/cli/run.ts:38-39` (send run message)

- [ ] **Step 1: Add `testNames` to `RunOptions`**

In `src/cli/run.ts`, change the interface:

```ts
export interface RunOptions {
  port: number;
  timeout: number;
  path: string;
  host: string;
  testNames?: string[];
}
```

- [ ] **Step 2: Include `testNames` in the run message**

In `src/cli/run.ts`, change line 39 where `ws.send` is called inside the `case 'connected'` block:

Replace:
```ts
ws.send(JSON.stringify({ type: 'run', scope: 'all' }));
```

With:
```ts
const runMsg: Record<string, unknown> = { type: 'run', scope: 'all' };
if (testNames?.length) runMsg.testNames = testNames;
ws.send(JSON.stringify(runMsg));
```

Extract `testNames` from options at the top of the function:
```ts
const { port, timeout, path, host, testNames } = options;
```

- [ ] **Step 3: Run existing tests**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/cli/run.ts
git commit -m "feat: CLI run command accepts and sends testNames"
```

---

### Task 6: CLI — `standalone.ts` parses `--test` flags

**Files:**
- Modify: `src/cli/standalone.ts:10-14` (add parseFlagAll)
- Modify: `src/cli/standalone.ts:47-65` (run subcommand block)
- Modify: `src/cli/standalone.ts:16-40` (help text)

- [ ] **Step 1: Add `parseFlagAll` helper**

Add after the existing `parseFlag` function (line ~14):

```ts
function parseFlagAll(name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1] && !args[i + 1].startsWith('--')) {
      values.push(args[i + 1]);
    }
  }
  return values;
}
```

- [ ] **Step 2: Parse `--test` in the `run` subcommand block and pass to `run()`**

In the `run` subcommand block (line ~47-65), add before the `run()` call:

```ts
const testNames = parseFlagAll('--test');
```

And update the `run()` call:

```ts
run({ port, timeout, path: pathFlag, host: hostFlag, testNames: testNames.length > 0 ? testNames : undefined });
```

- [ ] **Step 3: Update help text**

Add `--test` to the "Options for run" section:

```
Options for run:
  --port <port>      Relay port to connect to (default: 5173)
  --host <host>      Relay host to connect to (default: localhost)
  --path <path>      WebSocket path (default: /__twd/ws)
  --timeout <ms>     Timeout in ms (default: 180000)
  --test <name>      Filter tests by name substring (repeatable)
```

Add examples:

```
  twd-relay run --test "login"           # run tests matching "login"
  twd-relay run --test "login" --test "signup"  # run multiple
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/standalone.ts
git commit -m "feat: CLI --test flag for filtering tests by name"
```

---

### Task 7: Build and manual smoke test

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: Clean build, no errors.

- [ ] **Step 2: Verify CLI help shows `--test`**

Run: `node dist/cli.js run --help` or `node dist/cli.js --help`
Expected: Help text shows `--test <name>` option under "Options for run".

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (21 existing + 3 new = 24 total).

- [ ] **Step 4: Commit (if any fixes needed)**

Only if fixes were required during smoke test.
