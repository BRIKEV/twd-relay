# End-of-Run Failures Recap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the existing `--- Run complete ---` summary, when any tests failed, print a recap block listing every failed test (with its error) so the failure list survives `tail -N` and can be copied as a single block.

**Architecture:** All changes live in `src/cli/run.ts`. A module-local `failures: FailureRecord[]` array is appended to in the `test:fail` handler; the `run:complete` handler renders the recap block before exit when the array is non-empty. No protocol changes, no new flags, no relay/browser changes. Tests use a real `WebSocketServer` that scripts messages to the `run()` function, with `process.exit` and `console.log` mocked to capture exit code and stdout.

**Tech Stack:** TypeScript, Node `ws`, Vitest. Existing CLI in `src/cli/run.ts`. Spec: `docs/superpowers/specs/2026-05-08-failures-recap-design.md`.

---

## File Structure

| File | Change |
|---|---|
| `src/cli/run.ts` | Add `FailureRecord` interface + `failures` array; append on `test:fail`; render recap block in `run:complete` handler when non-empty. |
| `src/tests/cli/run.spec.ts` | **New file.** Two tests: recap appears with two failures; recap absent on a green run. Spins up a `WebSocketServer` on port 9880 that scripts the message stream to `run()`. |
| `README.md` | Two-sentence note appended at the end of the `## CLI run command` section describing the recap block. |

Port 9880 is unused — existing test files use 9877 (relay), 9878 / 9879 (others). Keeps the convention of one port per test file.

---

## Task 1: Add failing test — recap on failures

**Files:**
- Create: `src/tests/cli/run.spec.ts`

**Why TDD here:** The recap is purely an output change. A test that asserts the exact strings in stdout is the cheapest, most precise verification — it documents the format and catches accidental regressions of the very thing we're shipping.

- [ ] **Step 1: Create the test file with one failing test**

Write `src/tests/cli/run.spec.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketServer, WebSocket as WsServerSocket } from 'ws';
import { run } from '../../cli/run';

const PORT = 9880;
const HOST = 'localhost';
const PATH = '/__twd/ws';

interface Harness {
  server: WebSocketServer;
  logs: string[];
  errors: string[];
  exitPromise: Promise<number>;
}

/**
 * Start a fake relay on PORT that, when the run() client sends `hello`,
 * replies with `{ type: 'connected', browser: true }` and then invokes
 * `script(ws)` so the test can stream lifecycle events.
 *
 * `process.exit` is mocked to resolve `exitPromise` with the exit code
 * instead of terminating the test runner. `console.log` / `console.error`
 * are captured into `logs` / `errors`.
 */
async function startHarness(
  script: (ws: WsServerSocket) => void,
): Promise<Harness> {
  const logs: string[] = [];
  const errors: string[] = [];

  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });

  let resolveExit!: (code: number) => void;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    resolveExit(code ?? 0);
    return undefined as never;
  }) as typeof process.exit);

  const server = new WebSocketServer({ port: PORT, path: PATH });
  await new Promise<void>((resolve) => server.on('listening', () => resolve()));

  server.on('connection', (ws) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'hello') {
        ws.send(JSON.stringify({ type: 'connected', browser: true }));
      } else if (msg.type === 'run') {
        script(ws);
      }
    });
  });

  return { server, logs, errors, exitPromise };
}

async function stopHarness(h: Harness): Promise<void> {
  await new Promise<void>((resolve) => h.server.close(() => resolve()));
}

describe('cli run — failures recap', () => {
  let harness: Harness | undefined;

  beforeEach(() => {
    harness = undefined;
  });

  afterEach(async () => {
    if (harness) await stopHarness(harness);
    vi.restoreAllMocks();
  });

  it('prints the recap block when tests fail', async () => {
    harness = await startHarness((ws) => {
      ws.send(JSON.stringify({ type: 'run:start', testCount: 2 }));
      ws.send(
        JSON.stringify({ type: 'test:start', suite: 'Checkout', name: 'state dropdown' }),
      );
      ws.send(
        JSON.stringify({
          type: 'test:fail',
          suite: 'Checkout',
          name: 'state dropdown',
          duration: 70,
          error: 'waitFor timed out after 2000ms. Last error: No select items found',
        }),
      );
      ws.send(
        JSON.stringify({ type: 'test:start', suite: 'Checkout', name: 'province dropdown' }),
      );
      ws.send(
        JSON.stringify({
          type: 'test:fail',
          suite: 'Checkout',
          name: 'province dropdown',
          duration: 65,
          error: 'waitFor timed out after 2000ms. Last error: No select items found',
        }),
      );
      ws.send(
        JSON.stringify({
          type: 'run:complete',
          passed: 0,
          failed: 2,
          skipped: 0,
          duration: 1500,
        }),
      );
    });

    run({ port: PORT, host: HOST, path: PATH, timeout: 5000 });

    const code = await harness.exitPromise;
    const out = harness.logs.join('\n');

    expect(out).toContain('Failed tests (2):');
    expect(out).toContain('Checkout > state dropdown');
    expect(out).toContain('Checkout > province dropdown');
    expect(out).toContain('waitFor timed out after 2000ms');
    expect(code).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `npx vitest run src/tests/cli/run.spec.ts`

Expected: FAIL. The assertion `expect(out).toContain('Failed tests (2):')` fails because today's `run:complete` handler prints only the summary lines, no recap.

- [ ] **Step 3: Commit the failing test**

```bash
git add src/tests/cli/run.spec.ts
git commit -m "test: add failing test for end-of-run failures recap"
```

---

## Task 2: Implement the recap

**Files:**
- Modify: `src/cli/run.ts:62-84`

- [ ] **Step 1: Add the FailureRecord interface and failures array**

In `src/cli/run.ts`, after the existing `RunOptions` interface (around line 10) and before `export function run`, add:

```typescript
interface FailureRecord {
  suite: string;
  name: string;
  error?: string;
}
```

Inside `run()`, alongside the other local state declarations (`runSent`, `runComplete`, `failed`, currently lines 19–21), add:

```typescript
  const failures: FailureRecord[] = [];
```

- [ ] **Step 2: Append to failures in the `test:fail` handler**

Replace the `test:fail` case (currently lines 62–68):

```typescript
      case 'test:fail':
        failed = true;
        console.log(`  FAIL: ${msg.suite} > ${msg.name} (${msg.duration}ms)`);
        if (msg.error) {
          console.log(`    Error: ${msg.error}`);
        }
        break;
```

with:

```typescript
      case 'test:fail':
        failed = true;
        console.log(`  FAIL: ${msg.suite} > ${msg.name} (${msg.duration}ms)`);
        if (msg.error) {
          console.log(`    Error: ${msg.error}`);
        }
        failures.push({ suite: msg.suite, name: msg.name, error: msg.error });
        break;
```

- [ ] **Step 3: Render the recap block in `run:complete`**

Replace the `run:complete` case (currently lines 74–84):

```typescript
      case 'run:complete': {
        const duration = (msg.duration / 1000).toFixed(1);
        console.log(`\n--- Run complete ---`);
        console.log(`Passed: ${msg.passed} | Failed: ${msg.failed} | Skipped: ${msg.skipped}`);
        console.log(`Duration: ${duration}s`);
        runComplete = true;
        clearTimeout(timer);
        ws.close();
        process.exit(failed || msg.failed > 0 ? 1 : 0);
        break;
      }
```

with:

```typescript
      case 'run:complete': {
        const duration = (msg.duration / 1000).toFixed(1);
        console.log(`\n--- Run complete ---`);
        console.log(`Passed: ${msg.passed} | Failed: ${msg.failed} | Skipped: ${msg.skipped}`);
        console.log(`Duration: ${duration}s`);

        if (failures.length > 0) {
          console.log(`\nFailed tests (${failures.length}):`);
          for (const f of failures) {
            console.log(`  × ${f.suite} > ${f.name}`);
            if (f.error) {
              const indented = f.error.replace(/\n/g, '\n    ');
              console.log(`    ${indented}`);
            }
          }
        }

        runComplete = true;
        clearTimeout(timer);
        ws.close();
        process.exit(failed || msg.failed > 0 ? 1 : 0);
        break;
      }
```

- [ ] **Step 4: Run the failing test, confirm it now passes**

Run: `npx vitest run src/tests/cli/run.spec.ts`

Expected: PASS. The recap block is now printed and contains both failure entries plus the indented error lines.

- [ ] **Step 5: Run the full test suite to confirm no regressions**

Run: `npm test -- --run`

Expected: all tests pass (existing 26 tests + the new one).

- [ ] **Step 6: Commit**

```bash
git add src/cli/run.ts
git commit -m "feat: print failed-tests recap block at end of run"
```

---

## Task 3: Add the green-run regression test

**Files:**
- Modify: `src/tests/cli/run.spec.ts`

- [ ] **Step 1: Add the second test case**

Add this `it` block inside the existing `describe('cli run — failures recap', ...)`, after the first test:

```typescript
  it('does not print the recap on a green run', async () => {
    harness = await startHarness((ws) => {
      ws.send(JSON.stringify({ type: 'run:start', testCount: 1 }));
      ws.send(
        JSON.stringify({ type: 'test:start', suite: 'Smoke', name: 'works' }),
      );
      ws.send(
        JSON.stringify({
          type: 'test:pass',
          suite: 'Smoke',
          name: 'works',
          duration: 12,
        }),
      );
      ws.send(
        JSON.stringify({
          type: 'run:complete',
          passed: 1,
          failed: 0,
          skipped: 0,
          duration: 50,
        }),
      );
    });

    run({ port: PORT, host: HOST, path: PATH, timeout: 5000 });

    const code = await harness.exitPromise;
    const out = harness.logs.join('\n');

    expect(out).not.toContain('Failed tests');
    expect(out).toContain('--- Run complete ---');
    expect(code).toBe(0);
  });
```

- [ ] **Step 2: Run the file, confirm both tests pass**

Run: `npx vitest run src/tests/cli/run.spec.ts`

Expected: 2 passed.

- [ ] **Step 3: Run the full test suite once more**

Run: `npm test -- --run`

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/tests/cli/run.spec.ts
git commit -m "test: assert no recap is printed on green runs"
```

---

## Task 4: Document the recap in README

**Files:**
- Modify: `README.md` (end of `## CLI run command` section, around line 187)

- [ ] **Step 1: Append a short note after the existing flag table paragraph**

In `README.md`, after the line `When --test is used and no tests match, the CLI prints the available test names so you can correct the filter.` (around line 187) and before the `---` separator (line 189), insert a blank line and then:

```markdown
When any tests fail, the CLI prints a recap block at the very end of the output listing each failed test and its error. This survives `tail -N` truncation and is easy to copy as a single block.
```

- [ ] **Step 2: Verify by reading the updated section**

Confirm the new sentence sits between the `--test` paragraph and the `---` separator and that surrounding markdown still renders.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: mention end-of-run failures recap in README"
```

---

## Manual smoke (optional, post-merge)

Per the spec, run a real suite with one intentionally broken test against a local relay and confirm:

1. The recap appears at the very end of the output.
2. `npx twd-relay run | tail -10` still shows the recap.
3. A fully green run prints **no** recap header.

This is not a blocking step for merging; the unit tests cover the behavior. It is worth doing once before publishing a new version.

---

## Out of Scope (per spec)

- New CLI flags, reporter modes, color output.
- Changes to the abort path (`run:aborted` already prints a self-contained error).
- Cross-run aggregation, dedup/grouping, or truncation of long errors.
- Version bump / publish — handled separately on `main` per the project's existing workflow.
