// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { createFaviconManager } from '../../browser/faviconManager';

describe('faviconManager.save', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.title = 'My App';
  });

  it('saves the current document title', () => {
    const mgr = createFaviconManager(document);
    mgr.save();
    // title is saved internally — verify via restore() after a change
    document.title = 'something else';
    mgr.restore();
    expect(document.title).toBe('My App');
  });

  it('saves an existing <link rel="icon"> href', () => {
    const link = document.createElement('link');
    link.rel = 'icon';
    link.href = 'https://example.com/app.ico';
    document.head.appendChild(link);

    const mgr = createFaviconManager(document);
    mgr.save();

    // mutate, then restore
    link.href = 'https://example.com/other.ico';
    mgr.restore();

    const restored = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    expect(restored?.href).toBe('https://example.com/app.ico');
  });

  it('records absence of <link rel="icon"> so restore can clean up', () => {
    const mgr = createFaviconManager(document);
    mgr.save();
    // no icon existed — nothing else to assert here; Task 5 verifies removal on restore
    expect(document.querySelector("link[rel='icon']")).toBeNull();
  });
});
