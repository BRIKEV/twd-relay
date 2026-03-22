# Run Tests Filtered by Name via CLI

## Problem

AI agents using twd-relay have no way to run specific tests. The only option is `it.only` which requires editing the test file, running, then editing back. This slows down AI loops significantly.

## Goal

Add `--test` flag to the CLI to filter tests by name substring match.

```
npx twd-relay run --test "should show error"
npx twd-relay run --test "should show error" --test "payment fails"
```

Repeat `--test` to filter multiple tests. CLI collects them into an array.

## Architecture

This is 100% a twd-relay feature. No changes needed in the twd-js repo:
- `twd-js/runner` already has `runByIds(ids: string[])` (runner.ts:284)
- Browser client already has access to `window.__TWD_STATE__.handlers` with all test names and IDs

The relay (`createTwdRelay.ts`) needs zero changes — it already forwards raw JSON `data` to the browser on line 80.

## Design

### 1. Protocol change — `src/relay/types.ts`

Extend `RunCommand` with an optional `testNames` field:

```ts
export interface RunCommand {
  type: 'run';
  scope: 'all';
  testNames?: string[];  // substring-match filter
}
```

Add `'NO_MATCH'` to `TwdErrorCode`:

```ts
export type TwdErrorCode =
  | 'NO_BROWSER'
  | 'RUN_IN_PROGRESS'
  | 'UNKNOWN_COMMAND'
  | 'INVALID_MESSAGE'
  | 'NO_MATCH';
```

### 2. Browser client — `src/browser/createBrowserClient.ts`

**`handleRunCommand(testNames?: string[])`** — when `testNames` is present:

1. Filter `handlers` for entries where `type === 'test'` and `name` contains any of the provided substrings (case-insensitive via `.toLowerCase()`)
2. If no matches, send error and return early (no `run:start` or `run:complete`):
   ```json
   { "type": "error", "code": "NO_MATCH", "message": "No tests matched: [\"foo\"]. Available tests: [\"test A\", \"test B\"]" }
   ```
3. If matches found, update `testCount` in `run:start` to reflect only matched tests
4. Call `runner.runByIds(matchedIds)` instead of `runner.runAll()`

**`handleMessage(event)`** — extract `testNames` from parsed message and pass to `handleRunCommand`:

```ts
if (parsed.type === 'run') {
  const testNames = Array.isArray(parsed.testNames) ? parsed.testNames : undefined;
  handleRunCommand(testNames);
}
```

### 3. CLI — `src/cli/standalone.ts` + `src/cli/run.ts`

**`standalone.ts`:**
- Add `parseFlagAll(name)` helper that collects all occurrences of a repeated flag into an array
- Parse `--test` flags: `const testNames = parseFlagAll('--test')`
- Pass `testNames` into `run({ port, timeout, path, host, testNames })`
- Update help text to document the `--test` flag

**`run.ts`:**
- Add `testNames?: string[]` to `RunOptions`
- Include `testNames` in the WebSocket run message when present:
  ```ts
  const runMsg: any = { type: 'run', scope: 'all' };
  if (testNames?.length) runMsg.testNames = testNames;
  ws.send(JSON.stringify(runMsg));
  ```
- When no `--test` flags, message is identical to today: `{ type: 'run', scope: 'all' }`

### 4. Matching logic

- Substring, case-insensitive: `"show error"` matches `"should show error when payment fails"`
- A test matches if **any** of the provided names is a substring of the test's `it()` name
- No describe-level filtering — if two tests across different describes have similar names, both run

## Error handling

- **NO_MATCH**: Browser sends error with available test names. CLI prints it via existing error handler. Connection stays open until timeout. AI agent sees the error with the full test list and can retry with corrected names.
- **Runner errors**: Existing try/catch in `handleRunCommand` sends `RUNNER_ERROR` — covers `runByIds` failures naturally.

## Files to modify

| File | Change |
|------|--------|
| `src/relay/types.ts` | Add `testNames?` to `RunCommand`, `'NO_MATCH'` to `TwdErrorCode` |
| `src/browser/createBrowserClient.ts` | Add filtering + `runByIds` to `handleRunCommand()`, extract `testNames` in `handleMessage()` |
| `src/cli/run.ts` | Add `testNames?` to `RunOptions`, include in WS message |
| `src/cli/standalone.ts` | Add `parseFlagAll`, parse `--test` flags, update help text |

## Files NOT modified

| File | Reason |
|------|--------|
| `src/relay/createTwdRelay.ts` | Already forwards raw JSON — no changes needed |
