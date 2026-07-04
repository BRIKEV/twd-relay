# Describe-Aware `--test` Filtering — Design

**Date:** 2026-07-04
**Status:** Approved

## Problem

`--test "name"` (and the `testNames` field of the `run` command) only substring-matches
`it(...)` test names. Filtering by a `describe(...)` name silently matches nothing.
This creates friction for developers and especially for AI agents, since most models
assume describe-name matching is the default behavior (as in Vitest/Jest). twd-cli
already implements describe-aware matching; twd-relay should match its semantics.

## Approach (chosen)

Full-path matching, identical to twd-cli: for each test, build the path
`"Describe > nested describe > test name"` by walking `parent` links in
`window.__TWD_STATE__.handlers`, then substring-match each lowercased filter against
the lowercased path. A filter equal to a describe name selects all tests under it;
cross-boundary filters like `"login > error"` also work.

Rejected alternative: matching test name OR any ancestor name individually — slightly
stricter, but diverges from twd-cli and blocks cross-boundary filters.

## Scope

Only the browser client's matching logic changes. Relay server, message protocol, and
CLI flag parsing are untouched — `testNames: string[]` already flows through as-is.

## Changes

### 1. New helper `buildTestPath` (`src/browser/buildTestPath.ts`)

Port of twd-cli's `buildTestPath`, adapted to the `Map<string, Handler>` the browser
client already reads from `__TWD_STATE__`. Walks `handler.parent` up through suites,
joins names with `" > "`, returns `null` if the starting id is missing. Pure function.

### 2. Matching in `handleRunCommand` (`src/browser/createBrowserClient.ts`)

Replace the current name-only loop (~lines 149–177): for each handler with
`type === 'test'`, build its full path and match each filter as a lowercased substring
of the lowercased path.

### 3. NO_MATCH message lists full paths

The existing `NO_MATCH` error lists available tests by bare name; change it to list
full paths (`"Login flow > shows error"`), so an agent can construct a working retry.

### 4. Docs

Update README's `--test` description (relay and `run` subcommand sections): matches
against the full describe-path, with an example showing filtering by describe name.

## Testing

- Unit tests for `buildTestPath`: root-level test, nested describes, missing parent id.
- Browser-client tests via the existing pattern (unique port, `TrackedWs` wrapper):
  - filter by describe name selects all tests under it
  - filter by test name still works
  - `run` message with `testNames` containing a `" > "` cross-boundary filter matches
  - no-match case emits `NO_MATCH` listing full paths

## Not included (YAGNI)

twd-cli's per-filter "matched nothing (others did)" warning — the relay protocol has
no warning channel and the all-or-nothing `NO_MATCH` covers the agent-facing failure
mode. Revisit if friction shows up.
