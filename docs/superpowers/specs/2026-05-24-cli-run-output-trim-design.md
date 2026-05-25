# Trim `twd-relay run` CLI Output for AI Consumers

## Problem

`npx twd-relay run` is the primary mechanism the `twd` AI skill uses to drive browser test runs. Its stdout is fed straight into Claude's context, so every printed line costs tokens and forces the model to grep for the actionable bits.

A typical 16-test run currently prints ~36 lines of body before the summary:

```
Connecting to ws://localhost:5173/__twd/ws...
Browser connected, triggering test run...

Running 16 test(s)...

  RUN:  Car Details > should load the details page and render the car specifications
  PASS: Car Details > should load the details page and render the car specifications (209.5ms)
  RUN:  Car Details > should navigate from the car list to a detail page when a row is clicked
  PASS: Car Details > should navigate from the car list to a detail page when a row is clicked (625.7999999523163ms)
  ...
  RUN:  Cars Delete > should open the confirm dialog, delete the car, and remove the row from the list
  FAIL: Cars Delete > should open the confirm dialog, delete the car, and remove the row from the list (2077.0999999046326ms)
    Error: Assertion failed: Expected text to contain "with i1", but got "ConfirmAre you sure you want to delete this item? with id 1? This action can not be undone.CancelDeleteClose"
  ...

--- Run complete ---
Passed: 15 | Failed: 1 | Skipped: 0
Duration: 5.3s

Failed tests (1):
  × Cars Delete > should open the confirm dialog, delete the car, and remove the row from the list
    Assertion failed: Expected text to contain "with i1", but got "ConfirmAre you sure you want to delete this item? with id 1? This action can not be undone.CancelDeleteClose"
```

Three kinds of waste:

1. **Per-test `RUN:` lines** — immediately followed by a `PASS:` or `FAIL:` for the same test. The `RUN:` line carries no information that the next line doesn't.
2. **Per-test `PASS:` lines** — the final summary already reports the pass count. For an AI consumer that only needs to know what failed and what's still passing in aggregate, the individual lines are pure noise.
3. **Float durations like `625.7999999523163ms`** — raw `performance.now()` deltas leaked into the output.

The failure detail is also duplicated: once inline (`FAIL: ... + Error: ...`) and once in the trailing `Failed tests` block. An AI parser hits the same content twice.

## Solution

Drop streaming output entirely. The CLI prints a tight startup block, stays silent during the run, and emits a single summary block at the end.

This is the new default — no `--verbose` / `--quiet` flag. The CLI's primary consumer is now AI agents; humans watching a run can refresh on the summary or use `twd-js`'s in-browser sidebar for live progress.

### Output: green run

```
Connected to ws://localhost:5173/__twd/ws
Running 16 test(s)...

--- Run complete ---
  Passed: 16 | Failed: 0 | Skipped: 0
  Duration: 5.3s
```

### Output: failures

```
Connected to ws://localhost:5173/__twd/ws
Running 16 test(s)...

--- Run complete ---
  Passed: 15 | Failed: 1 | Skipped: 0
  Duration: 5.3s

  Failed tests (1):
    × Cars Delete > should open the confirm dialog, delete the car, and remove the row from the list
      Assertion failed: Expected text to contain "with i1", but got "ConfirmAre you sure you want to delete this item? with id 1? This action can not be undone.CancelDeleteClose"
```

### Output: browser not yet connected

```
Connected to ws://localhost:5173/__twd/ws
Waiting for browser to connect...
Running 16 test(s)...

--- Run complete ---
  Passed: 16 | Failed: 0 | Skipped: 0
  Duration: 5.3s
```

## Changes in `src/cli/run.ts`

### Event handlers — output removed

| Event         | Old                                          | New                          |
|---------------|----------------------------------------------|------------------------------|
| `test:start`  | `  RUN:  <suite> > <name>`                   | no log                       |
| `test:pass`   | `  PASS: <suite> > <name> (<ms>)`            | no log                       |
| `test:skip`   | `  SKIP: <suite> > <name>`                   | no log                       |
| `test:fail`   | `  FAIL: ... ` + `    Error: ...` inline     | no inline log; still pushes to `failures[]` |

The `failures[]` array is still populated on `test:fail` so the summary block renders unchanged.

### Connection lines — compressed

| Old                                                  | New                                    |
|------------------------------------------------------|----------------------------------------|
| `Connecting to <url>...`                             | `Connected to <url>` (on `ws.open`)    |
| `Browser connected, triggering test run...` + blank  | removed (the next `Running …` line implies it) |
| `Waiting for browser to connect...`                  | unchanged                              |

The transition from `Connecting to` (before connect) to `Connected to` (after `ws.open`) is the meaningful change. The current code prints `Connecting to` synchronously before the WebSocket opens; we move that line into the `ws.on('open')` handler and reword it.

### `run:complete` formatting

The summary block is indented two spaces to match the desired output. Failure details preserve multi-line errors using the existing `indented` transform.

```
--- Run complete ---
  Passed: <n> | Failed: <n> | Skipped: <n>
  Duration: <s>s

  Failed tests (<n>):
    × <suite> > <name>
      <error first line>
      <error second line>
```

The blank `Failed tests` block is only emitted when `failures.length > 0`.

### Unchanged

- `run:aborted`, `run:abandoned`, `error`, timeout, and connection-error paths — already terse and actionable.
- Exit codes (0 on green, 1 on any failure / timeout / abort).
- The `--test`, `--max-test-duration`, `--timeout`, `--port`, `--host`, `--path` flags.
- The WebSocket message protocol on the wire — only the CLI's stdout formatting changes.

## Out of scope

- Adding a `--verbose` flag to restore the old streaming output. Decided against: the CLI's primary consumer is AI agents, and humans wanting live progress can use the in-browser TWD sidebar.
- Dumping partial results on `timeout`. The timeout path stays as-is (`Timeout: no run:complete received within Xs`). If this becomes a real pain point we can revisit, but the current behavior matches what we had before.
- Touching `twd-cli` (separate package, headless Puppeteer runner) — its output is governed by `twd-js`'s runner and is a separate concern.
- Changing `twd-js`'s sidebar or runner output.

## Risk

Low.

- The `run` subcommand has no unit tests (`src/tests/cli/` does not exist), so no test churn.
- The `twd` AI skill consumes the summary block, not the streaming progress; the contract it relies on (`--- Run complete ---`, `Passed: X | Failed: Y | Skipped: Z`, `Failed tests (N):` …) is preserved verbatim.
- Manual smoke test: run against `twd-react-router-example` for the green path and one synthetic failing test for the failure path.

## Documentation impact

- `twd-relay/CLAUDE.md` — the "Architecture > CLI" paragraph mentions streaming test output. Update to reflect the silent-during-run behavior.
- `twd-relay/README.md` — if it shows sample `twd-relay run` output, refresh the example.
- `twd-ai/skills/twd/references/running-tests.md` — check for example output blocks and update to match the new format. (Lives in a sibling repo; flag in the implementation plan.)
