export interface PathHandler {
  id: string;
  name: string;
  parent?: string;
  type: 'suite' | 'test';
}

/**
 * Builds the full describe-path for a test, e.g.
 * "Login flow > validation > shows error on bad password".
 * Returns null if the starting id is not in the map.
 */
export function buildTestPath(
  testId: string,
  handlers: Map<string, PathHandler>,
): string | null {
  let current = handlers.get(testId);
  if (!current) return null;
  const parts: string[] = [];
  while (current) {
    parts.unshift(current.name);
    current = current.parent ? handlers.get(current.parent) : undefined;
  }
  return parts.join(' > ');
}
