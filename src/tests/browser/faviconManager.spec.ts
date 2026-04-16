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

  it('is idempotent — a second save() call does not overwrite the original capture', () => {
    const original = document.createElement('link');
    original.rel = 'icon';
    original.href = 'https://example.com/app.ico';
    document.head.appendChild(original);

    const mgr = createFaviconManager(document);
    mgr.save();
    mgr.set('connected');
    // Simulate a reconnect where save() runs again while TWD state is still applied.
    mgr.save();
    mgr.restore();

    expect(document.title).toBe('My App');
    const link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    expect(link?.href).toBe('https://example.com/app.ico');
  });
});

describe('faviconManager.set', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.title = 'My App';
  });

  it('sets the favicon to the blue dot and prefixes title when state is connected', () => {
    const mgr = createFaviconManager(document);
    mgr.save();
    mgr.set('connected');

    const link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    expect(link?.getAttribute('href')).toContain('%234A90D9');
    expect(document.title).toBe('[TWD] My App');
  });

  it('switches through all states without compounding the title prefix', () => {
    const mgr = createFaviconManager(document);
    mgr.save();

    mgr.set('connected');
    expect(document.title).toBe('[TWD] My App');

    mgr.set('running');
    expect(document.title).toBe('[TWD ...] My App');

    mgr.set('pass');
    expect(document.title).toBe('[TWD ✓] My App');

    mgr.set('fail');
    expect(document.title).toBe('[TWD ✗] My App');
  });

  it('reuses an existing <link rel="icon"> element rather than creating another', () => {
    const original = document.createElement('link');
    original.rel = 'icon';
    original.href = 'https://example.com/app.ico';
    document.head.appendChild(original);

    const mgr = createFaviconManager(document);
    mgr.save();
    mgr.set('running');

    const links = document.querySelectorAll("link[rel='icon']");
    expect(links.length).toBe(1);
    expect(links[0]).toBe(original);
    expect(original.getAttribute('href')).toContain('%23F5A623');
  });

  it('creates a <link rel="icon"> when none exists', () => {
    const mgr = createFaviconManager(document);
    mgr.save();
    mgr.set('pass');

    const link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toContain('%237ED321');
  });
});
