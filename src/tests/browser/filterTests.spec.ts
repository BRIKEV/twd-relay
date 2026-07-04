import { describe, it, expect } from 'vitest';
import { selectTestIds, listTestPaths } from '../../browser/filterTests';
import type { PathHandler } from '../../browser/buildTestPath';

function makeHandlers(list: PathHandler[]): Map<string, PathHandler> {
  return new Map(list.map((h) => [h.id, h]));
}

const handlers = makeHandlers([
  { id: 's1', name: 'Login flow', type: 'suite' },
  { id: 't1', name: 'shows error on bad password', type: 'test', parent: 's1' },
  { id: 't2', name: 'redirects on success', type: 'test', parent: 's1' },
  { id: 's2', name: 'Signup', type: 'suite' },
  { id: 't3', name: 'shows error on taken email', type: 'test', parent: 's2' },
  { id: 't4', name: 'root-level smoke test', type: 'test' },
]);

describe('selectTestIds', () => {
  it('matches by test name substring (existing behavior)', () => {
    expect(selectTestIds(handlers, ['redirects'])).toEqual(['t2']);
  });

  it('matches all tests under a describe by its name', () => {
    expect(selectTestIds(handlers, ['login flow'])).toEqual(['t1', 't2']);
  });

  it('is case-insensitive', () => {
    expect(selectTestIds(handlers, ['LOGIN FLOW'])).toEqual(['t1', 't2']);
  });

  it('supports cross-boundary filters spanning describe and test', () => {
    expect(selectTestIds(handlers, ['login flow > shows error'])).toEqual(['t1']);
  });

  it('unions multiple filters without duplicating ids', () => {
    expect(selectTestIds(handlers, ['login flow', 'shows error'])).toEqual([
      't1', 't2', 't3',
    ]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(selectTestIds(handlers, ['nonexistent'])).toEqual([]);
  });

  it('never returns suite ids', () => {
    const ids = selectTestIds(handlers, ['login flow']);
    expect(ids).not.toContain('s1');
  });
});

describe('listTestPaths', () => {
  it('lists full paths of all tests, skipping suites', () => {
    expect(listTestPaths(handlers)).toEqual([
      'Login flow > shows error on bad password',
      'Login flow > redirects on success',
      'Signup > shows error on taken email',
      'root-level smoke test',
    ]);
  });
});
