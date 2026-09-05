import { describe, it, expect } from 'vitest';
import { formatDiagnostics, composeFailureError } from '../../browser/diagnostics';

/**
 * The rendered format must stay byte-identical to twd-js's own
 * `src/utils/diagnostics.ts`, so these cases mirror its spec.
 */
describe('formatDiagnostics', () => {
  const body = (lines: string[]) => lines.slice(1, -1);

  it('opens and closes with a rule', () => {
    const lines = formatDiagnostics({ location: '/t-1' });

    expect(lines[0]).toBe(`── TWD diagnostics ${'─'.repeat(37)}`);
    expect(lines[lines.length - 1]).toBe('─'.repeat(56));
  });

  it('renders location alone when no rule was registered', () => {
    expect(body(formatDiagnostics({ location: '/t-1/settings/catalog' }))).toEqual([
      'location    /t-1/settings/catalog',
    ]);
  });

  it('renders a summary only when every rule triggered', () => {
    const lines = formatDiagnostics({
      location: '/t-1',
      mockRules: { registered: 3, triggered: 3, untriggered: [] },
    });

    expect(body(lines)).toEqual(['location    /t-1', 'mock rules  3/3 triggered']);
  });

  it('names a single miss inline', () => {
    const lines = formatDiagnostics({
      location: '/t-1',
      mockRules: { registered: 7, triggered: 6, untriggered: ['catalog'] },
    });

    expect(body(lines)[1]).toBe('mock rules  6/7 triggered — catalog never requested');
  });

  it('lists several misses under the summary', () => {
    const lines = formatDiagnostics({
      location: '/t-1',
      mockRules: {
        registered: 7,
        triggered: 4,
        untriggered: ['catalog', 'products', 'connections'],
      },
    });

    expect(body(lines).slice(1)).toEqual([
      'mock rules  4/7 triggered — 3 never requested',
      '            ✗ catalog',
      '            ✗ products',
      '            ✗ connections',
    ]);
  });

  it('caps the list at five and counts the rest', () => {
    const lines = formatDiagnostics({
      location: '/t-1',
      mockRules: {
        registered: 7,
        triggered: 0,
        untriggered: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      },
    });

    expect(body(lines).slice(1)).toEqual([
      'mock rules  0/7 triggered — 7 never requested',
      '            ✗ a',
      '            ✗ b',
      '            ✗ c',
      '            ✗ d',
      '            ✗ e',
      '            +2 more',
    ]);
  });
});

describe('composeFailureError', () => {
  it('returns the message unchanged when there are no diagnostics', () => {
    expect(composeFailureError('expected true to be false', undefined)).toBe(
      'expected true to be false',
    );
  });

  it('puts the block above the message, separated by a blank line', () => {
    const out = composeFailureError('expected true to be false', { location: '/t-1' });
    const lines = out.split('\n');

    expect(lines[0]).toBe(`── TWD diagnostics ${'─'.repeat(37)}`);
    expect(lines[1]).toBe('location    /t-1');
    expect(lines[2]).toBe('─'.repeat(56));
    expect(lines[3]).toBe('');
    expect(lines[4]).toBe('expected true to be false');
  });

  it('keeps a multi-line message intact below the block', () => {
    const message = 'expected true to be false\n\nAccessible roles:\n  button "Save"';
    const out = composeFailureError(message, { location: '/t-1' });

    expect(out.endsWith(`\n\n${message}`)).toBe(true);
  });
});
