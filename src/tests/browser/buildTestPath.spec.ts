import { describe, it, expect } from 'vitest';
import { buildTestPath, type PathHandler } from '../../browser/buildTestPath';

function makeHandlers(list: PathHandler[]): Map<string, PathHandler> {
  return new Map(list.map((h) => [h.id, h]));
}

describe('buildTestPath', () => {
  it('returns the bare name for a root-level test', () => {
    const handlers = makeHandlers([
      { id: 't1', name: 'adds numbers', type: 'test' },
    ]);
    expect(buildTestPath('t1', handlers)).toBe('adds numbers');
  });

  it('joins nested describe names with " > "', () => {
    const handlers = makeHandlers([
      { id: 's1', name: 'Login flow', type: 'suite' },
      { id: 's2', name: 'validation', type: 'suite', parent: 's1' },
      { id: 't1', name: 'shows error on bad password', type: 'test', parent: 's2' },
    ]);
    expect(buildTestPath('t1', handlers)).toBe(
      'Login flow > validation > shows error on bad password'
    );
  });

  it('returns null for an unknown id', () => {
    const handlers = makeHandlers([
      { id: 't1', name: 'adds numbers', type: 'test' },
    ]);
    expect(buildTestPath('missing', handlers)).toBeNull();
  });

  it('stops walking when a parent id is missing from the map', () => {
    const handlers = makeHandlers([
      { id: 't1', name: 'orphan test', type: 'test', parent: 'gone' },
    ]);
    expect(buildTestPath('t1', handlers)).toBe('orphan test');
  });
});
