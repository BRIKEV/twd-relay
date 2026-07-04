import { buildTestPath, type PathHandler } from './buildTestPath';

/**
 * Returns ids of tests whose full describe-path contains any filter
 * as a case-insensitive substring. Mirrors twd-cli's selectTestIds.
 */
export function selectTestIds(
  handlers: Map<string, PathHandler>,
  filters: string[],
): string[] {
  const needles = filters.map((f) => f.toLowerCase());
  const ids: string[] = [];

  for (const [, handler] of handlers) {
    if (handler.type !== 'test') continue;
    const path = buildTestPath(handler.id, handlers);
    if (!path) continue;
    const haystack = path.toLowerCase();
    if (needles.some((n) => haystack.includes(n))) {
      ids.push(handler.id);
    }
  }

  return ids;
}

/** Full describe-paths of all tests — used in the NO_MATCH error message. */
export function listTestPaths(handlers: Map<string, PathHandler>): string[] {
  const paths: string[] = [];
  for (const [, handler] of handlers) {
    if (handler.type !== 'test') continue;
    const path = buildTestPath(handler.id, handlers);
    if (path) paths.push(path);
  }
  return paths;
}
