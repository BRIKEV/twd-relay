export type FaviconState = 'connected' | 'running' | 'pass' | 'fail';

export interface FaviconManager {
  save(): void;
  restore(): void;
  set(state: FaviconState): void;
}

// Inline SVG data URIs — a filled circle, 32x32 viewBox. '%23' is URL-encoded '#'.
// Colors chosen for contrast at 16x16 favicon size:
//   blue   #4A90D9 — connected/idle
//   orange #F5A623 — running
//   green  #7ED321 — pass
//   red    #D0021B — fail
export const FAVICON_DATA_URIS: Record<FaviconState, string> = {
  connected: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><circle cx='16' cy='16' r='14' fill='%234A90D9'/></svg>",
  running:   "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><circle cx='16' cy='16' r='14' fill='%23F5A623'/></svg>",
  pass:      "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><circle cx='16' cy='16' r='14' fill='%237ED321'/></svg>",
  fail:      "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><circle cx='16' cy='16' r='14' fill='%23D0021B'/></svg>",
};

export const TITLE_PREFIXES: Record<FaviconState, string> = {
  connected: '[TWD] ',
  running:   '[TWD ...] ',
  pass:      '[TWD ✓] ',
  fail:      '[TWD ✗] ',
};

export function createFaviconManager(doc: Document): FaviconManager {
  let savedHref: string | null = null;
  let savedTitle: string | null = null;
  let hadIconLink = false;

  return {
    save() {
      const existing = doc.querySelector<HTMLLinkElement>("link[rel='icon']");
      hadIconLink = existing !== null;
      savedHref = existing?.href ?? null;
      savedTitle = doc.title;
    },
    restore() {
      if (savedTitle !== null) {
        doc.title = savedTitle;
      }
      if (hadIconLink && savedHref !== null) {
        const link = doc.querySelector<HTMLLinkElement>("link[rel='icon']");
        if (link) link.href = savedHref;
      }
      savedHref = null;
      savedTitle = null;
      hadIconLink = false;
    },
    set() {
      // Implemented in Task 4
      throw new Error('not implemented');
    },
  };
}
