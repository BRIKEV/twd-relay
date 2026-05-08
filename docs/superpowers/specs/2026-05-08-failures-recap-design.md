# End-of-Run Failures Recap

## Problem

`twd-relay run` prints test results in the order they happen — `RUN:` then `PASS:` / `FAIL:` / `SKIP:` per test, followed by a final 3-line summary (`Passed | Failed | Skipped`, `Duration`). When a run produces ~75+ tests, failures get buried in the stream:

```
  RUN:  Suite > test 1
  PASS: Suite > test 1 (42s)
  ... (74 more lines) ...
  FAIL: Suite > test 35 (70s)
    Error: waitFor timed out after 2000ms.
  ... (40 more lines) ...
--- Run complete ---
Passed: 75 | Failed: 2 | Skipped: 0
Duration: 65.7s
```

Two real consequences:

1. **Truncated logs lose failures.** Anyone (CI logs, terminal scrollback, AI agents piping through `tail -N`) who only sees the tail of the output gets the summary numbers but not the names of the failing tests. They have to re-run with `grep` or rerun the whole suite to find what failed. Observed in practice: an AI agent piped through `tail -80`, saw the `Failed: 2` count but only one of the two failure lines, and burned a second 65 s run just to extract the second name.
2. **No single block to act on.** Even with full output, mentally collating "which tests failed" requires scanning the whole stream and matching `FAIL:` lines against `Error:` lines. There's no terminal section that says "here's what to investigate."

## Solution

After the existing `--- Run complete ---` summary, when `failed > 0`, print a recap block listing every failed test with its error:

```
--- Run complete ---
Passed: 75 | Failed: 2 | Skipped: 0
Duration: 65.7s

Failed tests (2):
  × Checkout New — JSON Order Flow > should show state dropdown for USA
    waitFor timed out after 2000ms. Last error: No select items found
  × Checkout New — JSON Order Flow > should show province dropdown for Canada
    waitFor timed out after 2000ms. Last error: No select items found
```

Properties that matter:

- **At the very end of output.** Survives any `tail -N` with `N ≥ ~10` regardless of suite size.
- **One block, one purpose.** Easy to copy/paste into an issue, a chat message, or another tool's input.
- **Per-failure error preserved.** No need to scroll back to find `Error:` lines.
- **Not printed when nothing failed.** Zero noise on green runs.

## Why this and not a `--reporter` flag

A `--reporter=minimal` flag (suppress `RUN:`/`PASS:` lines) was discussed as an alternative. The recap block subsumes its main use case — "I just want to see what failed" — without losing the per-test progress stream that's useful for watching long runs interactively. A reporter flag is still worth considering as a follow-up for very large suites or strict CI logs, but it's a strictly separate change. This spec scopes to the recap block.

## Implementation

All changes in `src/cli/run.ts`. No protocol changes, no relay/browser changes, no new flags.

### Collect failures during the run

Add a module-local array, append on `test:fail`:

```ts
interface FailureRecord {
  suite: string;
  name: string;
  error?: string;
}

const failures: FailureRecord[] = [];
```

In the `test:fail` handler (currently lines 62–68), after the existing `console.log` calls:

```ts
case 'test:fail':
  failed = true;
  console.log(`  FAIL: ${msg.suite} > ${msg.name} (${msg.duration}ms)`);
  if (msg.error) {
    console.log(`    Error: ${msg.error}`);
  }
  failures.push({ suite: msg.suite, name: msg.name, error: msg.error });
  break;
```

### Print the recap block on `run:complete`

In the `run:complete` handler (currently lines 74–84), after the existing summary lines, before the `process.exit`:

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
        // Indent multi-line errors so they read as one block per failure
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

### Handle the abort path

When `run:aborted` fires (line 86), the run ends without a `run:complete` from the browser — the CLI exits via the abort handler. The recap is only useful when individual tests failed, not when the whole run was aborted (the abort message is already a clear single block). No change to the abort handler.

The currently-running test that triggered the abort is **not** added to `failures` (it never fires `test:fail` — abort short-circuits the runner). This matches the existing semantics: the abort message names that test directly.

## Output format details

| Aspect | Choice |
|---|---|
| Header | `Failed tests (N):` — `N` matches both the summary's `Failed:` count and the recap entries. |
| Marker | `×` (Unicode multiplication sign). Visually distinct from `>`/`-` already used in the stream. ASCII-only repos can swap to `*` or `X`; not parameterized initially. |
| Blank line before recap | Yes, separates from the summary. |
| Blank line after recap | No — the next thing is process exit; trailing newline only. |
| Multi-line errors | Re-indented so each `\n` lines up under the test name. Preserves stack-trace readability without breaking the per-failure visual block. |
| Long suite/test names | Not wrapped. The user's terminal handles wrapping; truncating would lose information. |
| Color | None for now. The existing CLI output is plain text; introducing color is a separate cross-cutting decision. |

## Files changed

| File | Change |
|---|---|
| `src/cli/run.ts` | Add `failures: FailureRecord[]` collected on `test:fail`; print recap block in `run:complete` handler when non-empty. |
| `src/tests/cli/run.spec.ts` (new or extended, depending on existing coverage) | Test: with two simulated `test:fail` events followed by `run:complete`, the captured stdout contains the `Failed tests (2):` header and both test names + error strings in order. Test: a green run (no `test:fail`) does not emit the recap header. |
| `README.md` | Short note in the run-output section: failed tests are repeated in a recap block at the end of the run for easy scanning. |

## Edge cases

| Scenario | Behavior |
|---|---|
| No failures | No recap block printed. |
| 1 failure | `Failed tests (1):` followed by one entry. Singular form not used (keep template uniform). |
| `test:fail` with no `error` field | Test name printed without an indented error line. |
| Multi-line `error` (stack trace) | Each line indented to align under the test name; reads as a block. |
| Test name contains `>` | Rendered as-is. The `Suite > Name` pattern is already established by `RUN:`/`PASS:` lines. |
| `run:complete` arrives before any `test:fail` events but reports `failed > 0` | Should not happen given the protocol, but the recap simply doesn't print (we go by collected events, not the count). The summary line still says `Failed: N`, so the discrepancy is visible. |
| Abort path (`run:aborted`) | No recap block — abort handler already prints a self-contained error and exits. Failures collected before the abort tick are not reported (run did not complete normally). |
| Same test fails twice in one run | Not possible with the current protocol; if it ever happens, both entries appear. No dedup. |

## Testing approach

Two tests in the existing CLI test harness pattern:

- **Recap on failures.** Drive the message switch with: `connected`/`browser:connected` → `run:start` → `test:start`/`test:fail` × 2 → `run:complete`. Capture stdout; assert it contains `Failed tests (2):`, both suite/name strings, and the error substrings.
- **No recap on green run.** Same but with `test:pass` events and `failed: 0`. Assert stdout does **not** contain `Failed tests`.

Manual smoke: run a real suite with one intentionally-broken test against the local relay; confirm the recap appears at the very end and survives `npx twd-relay run | tail -10`.

## Non-goals

- New CLI flags. The recap is unconditional when failures exist; no opt-out needed (it's additive and small).
- Reporter modes (`--reporter=minimal`, `--reporter=json`). Discussed above; separate change if pursued.
- Color output. Cross-cutting decision out of scope here.
- Aggregating failures across multiple runs. Single-run scope only.
- Dedup or grouping (e.g. "3 failures in suite X"). Flat list keeps the implementation trivial; group-by can be added later if real suites grow large enough that it matters.
- Truncating long error messages. Information loss isn't worth the savings for typical TWD failures (1–3 lines).
