# Trim `twd-relay run` CLI Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the streaming per-test output in `npx twd-relay run` with a tight startup + summary format, reducing token cost for the `twd` AI skill which consumes this output as context.

**Architecture:** Single-file edit to `src/cli/run.ts` — drop per-test event handlers' output (RUN/PASS/SKIP/FAIL streaming), compress the connect line, and indent the run-complete summary. No new flags, no test infrastructure changes, no wire-protocol changes. Doc paragraph in `CLAUDE.md` is refreshed to match.

**Tech Stack:** TypeScript, `ws` (WebSocket client), Vite build. Built by `npm run build`, distributed as `dist/cli.js`.

**Spec:** `docs/superpowers/specs/2026-05-24-cli-run-output-trim-design.md` (commit `1dbbf0c`).

**Why no unit tests:** `src/cli/run.ts` has no existing test coverage (`src/tests/cli/` does not exist). Adding stdout-capture test infrastructure for a tightly-scoped formatting change is premature; the spec explicitly opts for manual smoke verification. The wire-protocol contract that the AI skill depends on (`--- Run complete ---`, `Passed: X | Failed: Y | Skipped: Z`, `Failed tests (N):` markers) is preserved verbatim.

**Integration approach:** Work happens on a feature branch (`feat/cli-run-output-trim`) and lands via PR (matching the recent `#6`–`#9` pattern in `twd-relay`). Not direct-to-main.

---

## File Map

- **Modify:** `src/cli/run.ts` — the only source file changed. All event-handler bodies that produce per-test output are rewritten or removed; the `connected` and `run:complete` handlers are reformatted.
- **Modify:** `CLAUDE.md` — the "Architecture > CLI" paragraph currently says the `run` subcommand "streams test output"; update to reflect the new silent-during-run behavior.
- **Build artifact (regenerated, not hand-edited):** `dist/cli.js`. Confirmed clean by `npm run build`.

No new files. No tests. No README / twd-ai sibling-repo doc edits — grep confirmed neither contains sample output that would go stale.

---

### Task 0: Create the feature branch

**Files:**
- No edits. Branch off `main`.

- [ ] **Step 1: Confirm `main` is clean and up to date**

```bash
cd /Users/kevinccbsg/brikev/twd-relay
git status
git fetch origin
git log --oneline origin/main..HEAD
```

Expected: working tree clean (modulo untracked spec files from earlier in this session, which is fine), and no unpushed commits ahead of `origin/main` other than the spec commit `1dbbf0c` (`docs: spec for trimming CLI run output`).

- [ ] **Step 2: Create and switch to the feature branch**

```bash
git checkout -b feat/cli-run-output-trim
```

Expected: `Switched to a new branch 'feat/cli-run-output-trim'`. All subsequent tasks happen on this branch.

---

### Task 1: Update connect-line and remove "Browser connected" line

**Files:**
- Modify: `src/cli/run.ts` (lines 22, 47)

The first user-visible string `Connecting to <url>...` is logged synchronously at line 22, before the WebSocket actually opens. The spec moves this into `ws.on('open')` and rewords it to `Connected to <url>` (no trailing ellipsis). Separately, the standalone line `Browser connected, triggering test run...\n` at line 47 is dropped — the next `Running N test(s)...` line implicitly conveys the same.

- [ ] **Step 1: Remove the synchronous "Connecting to" log**

In `src/cli/run.ts`, find:

```ts
const url = `ws://${host}:${port}${path}`;

console.log(`Connecting to ${url}...`);

const ws = new WebSocket(url);
```

Replace with:

```ts
const url = `ws://${host}:${port}${path}`;

const ws = new WebSocket(url);
```

- [ ] **Step 2: Log "Connected to" on `ws.open`**

In the same file, find:

```ts
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'hello', role: 'client' }));
});
```

Replace with:

```ts
ws.on('open', () => {
  console.log(`Connected to ${url}`);
  ws.send(JSON.stringify({ type: 'hello', role: 'client' }));
});
```

- [ ] **Step 3: Drop the "Browser connected, triggering test run..." line**

In the `case 'connected':` branch, find:

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

Replace with:

```ts
case 'connected':
  if (msg.browser && !runSent) {
    runSent = true;
    const runMsg: Record<string, unknown> = { type: 'run', scope: 'all' };
    if (testNames?.length) runMsg.testNames = testNames;
    if (maxTestDurationMs !== undefined) runMsg.maxTestDurationMs = maxTestDurationMs;
    ws.send(JSON.stringify(runMsg));
  } else if (!msg.browser) {
    console.log('Waiting for browser to connect...');
  }
  break;
```

Note: the `Waiting for browser to connect...` branch is preserved unchanged — it's still useful when no browser is open yet.

---

### Task 2: Drop per-test streaming output

**Files:**
- Modify: `src/cli/run.ts` (lines 57–80)

`test:start`, `test:pass`, `test:skip` produce no output in the new format. `test:fail` produces no inline output but **still pushes to `failures[]`** so the summary block at end-of-run renders correctly. The `failed` boolean is also still flipped so the exit code path is unchanged.

- [ ] **Step 1: Replace the per-test handlers with no-output versions**

In `src/cli/run.ts`, find the block:

```ts
      case 'run:start':
        console.log(`Running ${msg.testCount} test(s)...\n`);
        break;

      case 'test:start':
        console.log(`  RUN:  ${msg.suite} > ${msg.name}`);
        break;

      case 'test:pass':
        console.log(`  PASS: ${msg.suite} > ${msg.name} (${msg.duration}ms)`);
        break;

      case 'test:fail':
        failed = true;
        console.log(`  FAIL: ${msg.suite} > ${msg.name} (${msg.duration}ms)`);
        if (msg.error) {
          console.log(`    Error: ${msg.error}`);
        }
        failures.push({ suite: msg.suite, name: msg.name, error: msg.error });
        break;

      case 'test:skip':
        console.log(`  SKIP: ${msg.suite} > ${msg.name}`);
        break;
```

Replace with:

```ts
      case 'run:start':
        console.log(`Running ${msg.testCount} test(s)...`);
        break;

      case 'test:start':
        break;

      case 'test:pass':
        break;

      case 'test:fail':
        failed = true;
        failures.push({ suite: msg.suite, name: msg.name, error: msg.error });
        break;

      case 'test:skip':
        break;
```

Two notes:
- The trailing `\n` on the `run:start` log is dropped because the `run:complete` block now starts with its own leading blank line (see Task 3) — keeping both would produce a double blank.
- The empty `case` blocks are intentional. They make it explicit to a future reader that these events arrive on the wire but are deliberately not logged. A grep for `case 'test:fail':` should still match — useful when debugging.

---

### Task 3: Indent the run-complete summary

**Files:**
- Modify: `src/cli/run.ts` (lines 82–97)

The summary block currently prints flush-left. The spec moves it to 2-space indentation for the data lines and the failure block. The `--- Run complete ---` header itself stays flush-left.

- [ ] **Step 1: Reformat the `run:complete` handler**

In `src/cli/run.ts`, find:

```ts
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

Replace with:

```ts
      case 'run:complete': {
        const duration = (msg.duration / 1000).toFixed(1);
        console.log(`\n--- Run complete ---`);
        console.log(`  Passed: ${msg.passed} | Failed: ${msg.failed} | Skipped: ${msg.skipped}`);
        console.log(`  Duration: ${duration}s`);

        if (failures.length > 0) {
          console.log(`\n  Failed tests (${failures.length}):`);
          for (const f of failures) {
            console.log(`    × ${f.suite} > ${f.name}`);
            if (f.error) {
              const indented = f.error.replace(/\n/g, '\n      ');
              console.log(`      ${indented}`);
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

Indent changes (relative to flush-left):
- `Passed: ...` line: 0 → 2 spaces
- `Duration: ...` line: 0 → 2 spaces
- `Failed tests (N):` header: 0 → 2 spaces
- `× <suite> > <name>` line: 2 → 4 spaces
- First line of error and continuation indent: 4 → 6 spaces (the `replace(/\n/g, '\n      ')` is now 6 spaces to keep multi-line errors aligned with their first line)

---

### Task 4: Build and verify TypeScript compiles cleanly

**Files:**
- No edits. Runs the existing build.

- [ ] **Step 1: Run the full build**

```bash
cd /Users/kevinccbsg/brikev/twd-relay
npm run build
```

Expected: build completes with no errors. The two stages (`vite build` for the three library entry points, `vite build -c vite.cli.config.ts` for the CLI) both produce output. `dist/cli.js` is regenerated with the `#!/usr/bin/env node` shebang injected by the postbuild script.

- [ ] **Step 2: Run the existing test suite to confirm nothing collateral broke**

```bash
npm run test:ci
```

Expected: all 26 tests across the 3 existing spec files pass. None of them exercise `src/cli/run.ts`, so they should pass unchanged — this step is paranoia, not coverage.

---

### Task 5: Manual smoke test — green path

**Files:**
- No edits. Exercises the local build against a running example app.

We use the local `dist/cli.js` against any example app's already-running Vite dev server. The example app uses the NPM-published `twd-relay/vite` plugin from its own `node_modules` — that's fine, since the wire protocol is unchanged; only the CLI's stdout formatting changed.

- [ ] **Step 1: Start an example app's dev server (in a separate terminal)**

Pick any example app — `twd-react-router-example` is the most minimal. From its directory:

```bash
cd /Users/kevinccbsg/brikev/twd-react-router-example
npm run dev
```

Note the Vite port from its startup output (typically 5173).

- [ ] **Step 2: Open the example app in a browser tab**

Visit the URL the dev server printed (e.g. `http://localhost:5173`). This makes the browser connect to the relay as the "browser" role so a run can actually be dispatched. Leave the tab in the foreground.

- [ ] **Step 3: Trigger a run via the local CLI**

From the `twd-relay` directory:

```bash
cd /Users/kevinccbsg/brikev/twd-relay
node dist/cli.js run --port 5173
```

(Adjust `--port` to match the dev server.)

- [ ] **Step 4: Confirm the green-path output matches the spec**

Expected output shape (test count and duration will vary):

```
Connected to ws://localhost:5173/__twd/ws
Running N test(s)...

--- Run complete ---
  Passed: N | Failed: 0 | Skipped: 0
  Duration: X.Xs
```

Specifically verify:
- No `Connecting to ...` line (synchronous one is gone)
- No `Browser connected, triggering test run...` line
- No per-test `RUN:` / `PASS:` / `SKIP:` lines
- The summary lines (`Passed:`, `Duration:`) are indented 2 spaces
- Exit code is 0 (`echo $?` after the command)

If the output differs, return to Task 1–3 and fix before continuing.

---

### Task 6: Manual smoke test — failing path

**Files:**
- Temporarily edits one test in the example app, then reverts.

- [ ] **Step 1: Introduce one synthetic failure in any test file**

Pick any test in the example app. In `twd-react-router-example` open one of the `*.twd.ts` test files (or whatever extension the app uses; `grep -r "describe\|test(" --include='*.ts' /Users/kevinccbsg/brikev/twd-react-router-example/src` will surface them). In one test, change an assertion so it must fail — for example, change an expected string to a value the page won't contain.

Save the file. The Vite HMR will reload the test runner.

- [ ] **Step 2: Re-run the CLI**

```bash
cd /Users/kevinccbsg/brikev/twd-relay
node dist/cli.js run --port 5173
```

- [ ] **Step 3: Confirm the failing-path output matches the spec**

Expected output shape:

```
Connected to ws://localhost:5173/__twd/ws
Running N test(s)...

--- Run complete ---
  Passed: N-1 | Failed: 1 | Skipped: 0
  Duration: X.Xs

  Failed tests (1):
    × <suite> > <test name>
      <error message>
```

Specifically verify:
- The `Failed tests (1):` header is indented 2 spaces
- The `×` bullet line is indented 4 spaces
- The error message is indented 6 spaces and multi-line errors keep their alignment
- Exit code is 1 (`echo $?` after the command)

- [ ] **Step 4: Revert the synthetic failure**

`git checkout` or undo the edit to the example app's test file. Confirm it's clean:

```bash
cd /Users/kevinccbsg/brikev/twd-react-router-example
git status
```

Expected: working tree clean (or unchanged from before Step 1).

---

### Task 7: Update `CLAUDE.md` architecture paragraph

**Files:**
- Modify: `CLAUDE.md` (the "CLI" paragraph in the Architecture section)

- [ ] **Step 1: Update the wording**

In `/Users/kevinccbsg/brikev/twd-relay/CLAUDE.md`, find:

```
**CLI** (`src/cli/`, bin: `twd-relay`) — Two subcommands: `serve` (default) starts a standalone HTTP server with the relay on port 9876; `run` connects to an existing relay as a client, sends a `run` command, streams test output, and exits with code 0/1 based on results. The `run` subcommand defaults to port 5173 (Vite dev server) and has a 180s timeout. Use `--test "name"` (repeatable) to filter tests by name substring match.
```

Replace with:

```
**CLI** (`src/cli/`, bin: `twd-relay`) — Two subcommands: `serve` (default) starts a standalone HTTP server with the relay on port 9876; `run` connects to an existing relay as a client, sends a `run` command, stays silent during the run, and prints a single summary block at the end (passed/failed/skipped counts plus failure details) before exiting with code 0/1. The `run` subcommand defaults to port 5173 (Vite dev server) and has a 180s timeout. Use `--test "name"` (repeatable) to filter tests by name substring match. The output format is optimised for AI-agent consumption — every line printed costs context tokens.
```

The change: `streams test output, and exits with code 0/1 based on results.` → `stays silent during the run, and prints a single summary block at the end (passed/failed/skipped counts plus failure details) before exiting with code 0/1.` Plus a closing sentence on the why.

---

### Task 8: Commit, push, and open the PR

**Files:**
- Stages: `src/cli/run.ts`, `CLAUDE.md`, `dist/` (if `dist/` is tracked — check git status).

- [ ] **Step 1: Check what's staged vs. unstaged**

```bash
cd /Users/kevinccbsg/brikev/twd-relay
git status --short
```

If `dist/` shows changes, check whether prior commits include `dist/`:

```bash
git log --oneline -5 -- dist/
```

If `dist/` is tracked, include it in the commit. If it's ignored, leave it.

- [ ] **Step 2: Stage the intentional changes**

```bash
git add src/cli/run.ts CLAUDE.md
```

(Add `dist/` only if step 1 showed it's tracked.)

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(cli): drop streaming run output, emit summary only

Reduces token cost for AI consumers of `npx twd-relay run`. The CLI now
prints the connect line plus a single end-of-run summary block (with
failure details when failures exist) — no per-test RUN/PASS/SKIP lines,
no inline FAIL lines. The wire protocol and exit codes are unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Confirm the commit landed clean**

```bash
git log --oneline -3
git status
```

Expected: the new commit at HEAD on `feat/cli-run-output-trim`, working tree clean (modulo `dist/` if untracked, and any pre-existing untracked spec files).

- [ ] **Step 5: Push the branch**

```bash
git push -u origin feat/cli-run-output-trim
```

Expected: new remote-tracking branch created.

- [ ] **Step 6: Open the PR with `gh`**

```bash
gh pr create --title "feat(cli): drop streaming run output, emit summary only" --body "$(cat <<'EOF'
## Summary

- Replaces per-test streaming (`RUN:` / `PASS:` / `SKIP:` / inline `FAIL:`) with a single end-of-run summary block.
- Compresses connect output: drops the synchronous `Connecting to ...` line and the `Browser connected, triggering test run...` line; logs `Connected to <url>` on `ws.open`.
- Indents the run-complete summary 2 spaces to match the desired AI-friendly format.
- Doc paragraph in `CLAUDE.md` refreshed to reflect the silent-during-run behavior.

The wire protocol, exit codes, and CLI flags are unchanged. Sample outputs and rationale: see `docs/superpowers/specs/2026-05-24-cli-run-output-trim-design.md`.

## Test plan

- [ ] `npm run build` succeeds (both stages: library entry points and CLI).
- [ ] `npm run test:ci` passes (existing 26 tests untouched).
- [ ] Manual smoke against an example app's Vite dev server: green run produces only `Connected to ...` + `Running N test(s)...` + the indented summary block. Exit code 0.
- [ ] Manual smoke with one synthetic failing test: summary block ends with the indented `Failed tests (1):` section showing `× <suite> > <name>` and the multi-line error preserved. Exit code 1.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: `gh` prints the new PR URL. Return it to the user.

---

## Self-review notes (for the implementer)

- **Spec coverage:** Every change in the spec's "Changes in `src/cli/run.ts`" section is implemented by Tasks 1–3. The "Documentation impact" entry for `CLAUDE.md` is Task 7. The spec confirmed README and twd-ai docs do not need updates (verified via grep at plan-writing time).
- **Type consistency:** No new types are introduced. The `FailureRecord` interface, the `failures` array, the `failed` boolean, and the `runMsg` shape are all unchanged. Wire-protocol message types (`test:start`, `test:pass`, `test:fail`, `test:skip`, `run:complete`, `run:start`, `run:aborted`, `run:abandoned`, `error`, `connected`) all keep their existing field names.
- **What's intentionally not touched:** `run:aborted`, `run:abandoned`, `error`, the timeout handler, and the `ws.on('close')` / `ws.on('error')` handlers. The spec explicitly leaves these alone.
- **One file, three tasks:** Tasks 1, 2, and 3 all edit the same file (`src/cli/run.ts`). They're split for review granularity, not because the file is committed three times. The commit happens once at Task 8.
