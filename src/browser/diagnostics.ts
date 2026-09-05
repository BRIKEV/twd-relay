/**
 * Renderer for the failure-diagnostics block twd-js attaches to a failed test.
 *
 * This is a deliberate port of twd-js's `src/utils/diagnostics.ts`, not an import.
 * twd-js keeps `formatDiagnostics` internal, and its only public entry point pulls
 * in the sidebar, chai and the theme (~470 KB) — far too much to load into the page
 * for a pure string formatter. The relay already defines twd-js's handler shape
 * structurally (see `TwdHandler`), so this follows the same convention.
 *
 * The output must stay byte-identical to twd-js's, because the sidebar and
 * `runner-ci` render the same block. `src/tests/browser/diagnostics.spec.ts`
 * mirrors twd-js's own spec to keep the two honest.
 */

/** A snapshot of what TWD observed during a test, captured when the test fails. */
export interface TestDiagnostics {
  /** Path + search + hash at the moment of failure. */
  location: string;
  /** Omitted entirely when the test registered no mock rules. */
  mockRules?: {
    registered: number;
    triggered: number;
    untriggered: string[];
  };
}

const WIDTH = 56;
const HEADER = `── TWD diagnostics ${'─'.repeat(WIDTH - 19)}`;
const FOOTER = '─'.repeat(WIDTH);
const LABEL = '            ';
const LIST_CAP = 5;

/**
 * Renders the signal, not the data: a page with fifteen mocks must not produce
 * fifteen lines. The rules that did trigger are only interesting as a count — it
 * is the misses that name a bug.
 */
export function formatDiagnostics(diagnostics: TestDiagnostics): string[] {
  const lines = [HEADER, `location    ${diagnostics.location}`];
  const mockRules = diagnostics.mockRules;

  if (mockRules) {
    const { registered, triggered, untriggered } = mockRules;
    const summary = `${triggered}/${registered} triggered`;

    if (untriggered.length === 0) {
      lines.push(`mock rules  ${summary}`);
    } else if (untriggered.length === 1) {
      lines.push(`mock rules  ${summary} — ${untriggered[0]} never requested`);
    } else {
      lines.push(`mock rules  ${summary} — ${untriggered.length} never requested`);
      for (const alias of untriggered.slice(0, LIST_CAP)) lines.push(`${LABEL}✗ ${alias}`);
      const rest = untriggered.length - LIST_CAP;
      if (rest > 0) lines.push(`${LABEL}+${rest} more`);
    }
  }

  lines.push(FOOTER);
  return lines;
}

/**
 * Composes the `error` string sent on `test:fail`.
 *
 * The block goes *above* the message, matching the sidebar and `runner-ci`: the
 * accessible-roles dump lives inside `err.message` and would otherwise bury it.
 *
 * `diagnostics` is absent for an older twd-js that does not report it, and for a
 * test that failed one attempt then passed on retry — in both cases the message
 * is returned untouched.
 */
export function composeFailureError(
  message: string,
  diagnostics?: TestDiagnostics,
): string {
  if (!diagnostics) return message;
  return `${formatDiagnostics(diagnostics).join('\n')}\n\n${message}`;
}
