import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, Server } from 'http';
import WebSocket from 'ws';
import { twdRemote } from '../../vite';

let portCounter = 9879;

describe('twdRemote Vite plugin', () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    port = portCounter++;
    server = createServer();
    await new Promise<void>((resolve) => server.listen(port, resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  it('should return a Vite plugin with name "twd-relay"', () => {
    const plugin = twdRemote();
    expect(plugin.name).toBe('twd-relay');
    expect(typeof plugin.configureServer).toBe('function');
  });

  it('should attach relay to http server via configureServer hook', async () => {
    const plugin = twdRemote();

    const mockViteServer = { httpServer: server };
    (plugin.configureServer as Function)(mockViteServer);

    const ws = new WebSocket(`ws://localhost:${port}/__twd/ws`);
    const msg = await new Promise<unknown>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'hello', role: 'client' }));
      });
      ws.on('message', (data) => {
        resolve(JSON.parse(data.toString()));
      });
      ws.on('error', reject);
    });

    expect(msg).toEqual({ type: 'connected', browser: false });
    ws.close();
    // Wait for ws to close before server teardown
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it('should support custom path', async () => {
    const plugin = twdRemote({ path: '/custom/ws' });

    const mockViteServer = { httpServer: server };
    (plugin.configureServer as Function)(mockViteServer);

    // Custom path SHOULD work
    const ws = new WebSocket(`ws://localhost:${port}/custom/ws`);
    const msg = await new Promise<unknown>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'hello', role: 'client' }));
      });
      ws.on('message', (data) => {
        resolve(JSON.parse(data.toString()));
      });
      ws.on('error', reject);
    });

    expect(msg).toEqual({ type: 'connected', browser: false });
    ws.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it('should handle missing httpServer gracefully', () => {
    const plugin = twdRemote();
    const mockViteServer = { httpServer: null };

    // Should not throw
    expect(() => {
      (plugin.configureServer as Function)(mockViteServer);
    }).not.toThrow();
  });

  it('should auto-detect base path from configResolved', async () => {
    const plugin = twdRemote();

    // Simulate Vite calling configResolved with a custom base
    (plugin.configResolved as Function)({ base: '/my-path/' });

    const mockViteServer = { httpServer: server };
    (plugin.configureServer as Function)(mockViteServer);

    // Relay should be reachable at /my-path/__twd/ws
    const ws = new WebSocket(`ws://localhost:${port}/my-path/__twd/ws`);
    const msg = await new Promise<unknown>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'hello', role: 'client' }));
      });
      ws.on('message', (data) => {
        resolve(JSON.parse(data.toString()));
      });
      ws.on('error', reject);
    });

    expect(msg).toEqual({ type: 'connected', browser: false });
    ws.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it('should use explicit path option over configResolved base', async () => {
    const plugin = twdRemote({ path: '/explicit/ws' });

    // configResolved sets a base, but explicit path should win
    (plugin.configResolved as Function)({ base: '/my-path/' });

    const mockViteServer = { httpServer: server };
    (plugin.configureServer as Function)(mockViteServer);

    // Explicit path should work
    const ws = new WebSocket(`ws://localhost:${port}/explicit/ws`);
    const msg = await new Promise<unknown>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'hello', role: 'client' }));
      });
      ws.on('message', (data) => {
        resolve(JSON.parse(data.toString()));
      });
      ws.on('error', reject);
    });

    expect(msg).toEqual({ type: 'connected', browser: false });
    ws.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});

describe('twdRemote auto-connect', () => {
  const VIRTUAL_ID = 'virtual:twd-relay/connect';
  const RESOLVED_ID = `\0${VIRTUAL_ID}`;

  function withResolvedConfig(
    plugin: ReturnType<typeof twdRemote>,
    base = '/',
  ): void {
    (plugin.configResolved as (c: { base: string }) => void)({ base });
  }

  it('injects a script tag pointing at the virtual id by default', () => {
    const plugin = twdRemote();
    withResolvedConfig(plugin);

    const tags =
      (plugin.transformIndexHtml as () => Array<{
        tag: string;
        attrs?: Record<string, string>;
        injectTo?: string;
      }>)();

    expect(tags).toHaveLength(1);
    const [tag] = tags;
    expect(tag.tag).toBe('script');
    expect(tag.attrs?.type).toBe('module');
    expect(tag.attrs?.src).toBe(`/@id/${VIRTUAL_ID}`);
    expect(tag.injectTo).toBe('head');
  });

  it('respects a non-default Vite base when constructing the script src', () => {
    const plugin = twdRemote();
    withResolvedConfig(plugin, '/my-app/');

    const tags =
      (plugin.transformIndexHtml as () => Array<{
        attrs?: Record<string, string>;
      }>)();

    expect(tags[0].attrs?.src).toBe(`/my-app/@id/${VIRTUAL_ID}`);
  });

  it('resolveId claims the virtual id and returns the prefixed form', () => {
    const plugin = twdRemote();
    const resolveId = plugin.resolveId as (id: string) => string | null;

    expect(resolveId(VIRTUAL_ID)).toBe(RESOLVED_ID);
    expect(resolveId('some-other-id')).toBeNull();
  });

  it('load() returns a module that imports createBrowserClient and connects on the configured path', () => {
    const plugin = twdRemote();
    withResolvedConfig(plugin);

    const code = (plugin.load as (id: string) => string | null)(RESOLVED_ID);

    expect(code).not.toBeNull();
    expect(code).toContain("from 'twd-relay/browser'");
    expect(code).toContain('createBrowserClient(');
    expect(code).toContain('.connect()');
    expect(code).toContain('"path":"/__twd/ws"');
  });

  it('load() reflects an explicit path option', () => {
    const plugin = twdRemote({ path: '/custom/relay' });
    withResolvedConfig(plugin);

    const code = (plugin.load as (id: string) => string | null)(RESOLVED_ID);

    expect(code).toContain('"path":"/custom/relay"');
  });

  it('load() reflects a non-default Vite base', () => {
    const plugin = twdRemote();
    withResolvedConfig(plugin, '/my-app/');

    const code = (plugin.load as (id: string) => string | null)(RESOLVED_ID);

    expect(code).toContain('"path":"/my-app/__twd/ws"');
  });

  it('load() forwards AutoConnectOptions into the createBrowserClient call', () => {
    const plugin = twdRemote({
      autoConnect: { reconnect: false, log: true, maxTestDurationMs: 5000 },
    });
    withResolvedConfig(plugin);

    const code = (plugin.load as (id: string) => string | null)(RESOLVED_ID);

    expect(code).toContain('"reconnect":false');
    expect(code).toContain('"log":true');
    expect(code).toContain('"maxTestDurationMs":5000');
  });

  it('autoConnect: false makes resolveId, load, and transformIndexHtml no-ops', () => {
    const plugin = twdRemote({ autoConnect: false });
    withResolvedConfig(plugin);

    expect(
      (plugin.resolveId as (id: string) => string | null)(VIRTUAL_ID),
    ).toBeNull();
    expect((plugin.load as (id: string) => string | null)(RESOLVED_ID)).toBeNull();
    expect((plugin.transformIndexHtml as () => unknown)()).toBeUndefined();
  });

  it('plugin opts out of production builds via apply: "serve"', () => {
    const plugin = twdRemote();
    expect(plugin.apply).toBe('serve');
  });
});
