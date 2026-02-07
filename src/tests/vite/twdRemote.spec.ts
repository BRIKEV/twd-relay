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
});
