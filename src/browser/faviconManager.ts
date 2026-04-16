export type FaviconState = 'connected' | 'running' | 'pass' | 'fail';

export interface FaviconManager {
  save(): void;
  restore(): void;
  set(state: FaviconState): void;
}

// Inline SVG data URIs — a TWD-style "browser window with check" silhouette,
// 32x32 viewBox. '%23' is URL-encoded '#'. Shape is identical across states so
// the tab is always recognizable as TWD; color (the window fill) carries state.
//   blue   #4A90D9 — connected/idle
//   orange #F5A623 — running
//   green  #7ED321 — pass
//   red    #D0021B — fail
const faviconSvg = (hex: string): string =>
  `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>` +
  `<rect x='3' y='4' width='26' height='24' rx='4' fill='${hex}'/>` +
  `<circle cx='7' cy='9' r='1' fill='white'/>` +
  `<circle cx='11' cy='9' r='1' fill='white'/>` +
  `<circle cx='15' cy='9' r='1' fill='white'/>` +
  `<path d='M9 20l4 4 10-10' stroke='white' stroke-width='3.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/>` +
  `</svg>`;

export const FAVICON_DATA_URIS: Record<FaviconState, string> = {
  connected: faviconSvg('%234A90D9'),
  running:   faviconSvg('%23F5A623'),
  pass:      faviconSvg('%237ED321'),
  fail:      faviconSvg('%23D0021B'),
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
  let linkElement: HTMLLinkElement | null = null;

  function getOrCreateLink(): HTMLLinkElement {
    if (linkElement && linkElement.isConnected) return linkElement;
    const existing = doc.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (existing) {
      linkElement = existing;
    } else {
      const link = doc.createElement('link');
      link.rel = 'icon';
      doc.head.appendChild(link);
      linkElement = link;
    }
    return linkElement;
  }

  return {
    save() {
      // Idempotent: if a save is already active, ignore — otherwise on reconnect
      // we'd capture the TWD-modified favicon/title as the "original".
      if (savedTitle !== null) return;
      const existing = doc.querySelector<HTMLLinkElement>("link[rel='icon']");
      hadIconLink = existing !== null;
      savedHref = existing?.href ?? null;
      savedTitle = doc.title;
      linkElement = existing;
    },
    restore() {
      if (savedTitle !== null) {
        doc.title = savedTitle;
      }
      if (!hadIconLink && linkElement && linkElement.isConnected) {
        linkElement.remove();
      } else if (hadIconLink && savedHref !== null && linkElement) {
        linkElement.setAttribute('href', savedHref);
      }
      savedHref = null;
      savedTitle = null;
      hadIconLink = false;
      linkElement = null;
    },
    set(state) {
      const link = getOrCreateLink();
      // Use setAttribute rather than link.href = — some DOM impls (happy-dom,
      // jsdom) normalize the .href getter to an absolute URL, which would turn
      // "data:image/svg+xml,…" into "about:blank/data:…" when read back.
      link.setAttribute('href', FAVICON_DATA_URIS[state]);
      // Always prefix against the saved (pre-TWD) title so rapid state changes
      // do not compound prefixes (e.g. "[TWD ...] [TWD] My App").
      const baseTitle = savedTitle ?? doc.title;
      doc.title = TITLE_PREFIXES[state] + baseTitle;
    },
  };
}
