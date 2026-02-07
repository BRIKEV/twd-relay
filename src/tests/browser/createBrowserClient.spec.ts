import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, Server } from 'http';
import WebSocket from 'ws';
import { createTwdRelay } from '../../relay';
import type { TwdRelay } from '../../relay';

/**
 * Browser client integration tests.
 *
 * Since createBrowserClient uses the native browser WebSocket API and
 * dynamic import('twd-js/runner'), we test through the relay by simulating
 * a browser-role connection that responds to commands the way the real
 * browser client would.
 */

const PORT = 9878;
const WS_URL = `ws://localhost:${PORT}/__twd/ws`;

interface TrackedWs {
  ws: WebSocket;
  nextMessage(): Promise<unknown>;
}

function createTrackedWs(url: string): TrackedWs {
  const ws = new WebSocket(url);
  const queue: unknown[] = [];
  const waiters: Array<(msg: unknown) => void> = [];

  ws.on('message', (data) => {
    const parsed = JSON.parse(data.toString());
    const waiter = waiters.shift();
    if (waiter) {
      waiter(parsed);
    } else {
      queue.push(parsed);
    }
  });

  return {
    ws,
    nextMessage() {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise<unknown>((resolve) => {
        waiters.push(resolve);
      });
    },
  };
}

function connectAs(role: 'browser' | 'client'): Promise<TrackedWs> {
  return new Promise((resolve, reject) => {
    const tracked = createTrackedWs(WS_URL);
    tracked.ws.on('open', () => {
      tracked.ws.send(JSON.stringify({ type: 'hello', role }));
      setTimeout(() => resolve(tracked), 50);
    });
    tracked.ws.on('error', reject);
  });
}

describe('Browser client protocol (integration via relay)', () => {
  let server: Server;
  let relay: TwdRelay;
  const connections: TrackedWs[] = [];

  beforeEach(async () => {
    server = createServer();
    relay = createTwdRelay(server);
    await new Promise<void>((resolve) => server.listen(PORT, resolve));
  });

  afterEach(async () => {
    for (const t of connections) {
      if (t.ws.readyState === WebSocket.OPEN) t.ws.close();
    }
    connections.length = 0;
    relay.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function track(t: TrackedWs): TrackedWs {
    connections.push(t);
    return t;
  }

  it('should receive run command and stream test events back to client', async () => {
    // Simulate a browser that responds to run commands
    const browser = track(await connectAs('browser'));
    const client = track(await connectAs('client'));
    // Drain connected message
    await client.nextMessage();

    // Browser listens for commands and simulates a test run
    browser.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'run') {
        browser.ws.send(JSON.stringify({ type: 'run:start', testCount: 2 }));
        browser.ws.send(JSON.stringify({ type: 'test:start', id: '1', name: 'adds numbers', suite: 'Math' }));
        browser.ws.send(JSON.stringify({ type: 'test:pass', id: '1', name: 'adds numbers', suite: 'Math', duration: 5 }));
        browser.ws.send(JSON.stringify({ type: 'test:start', id: '2', name: 'subtracts', suite: 'Math' }));
        browser.ws.send(JSON.stringify({ type: 'test:fail', id: '2', name: 'subtracts', suite: 'Math', error: 'Expected 3 but got 4', duration: 8 }));
        browser.ws.send(JSON.stringify({ type: 'run:complete', passed: 1, failed: 1, skipped: 0, duration: 13 }));
      }
    });

    // Client sends run command
    client.ws.send(JSON.stringify({ type: 'run', scope: 'all' }));

    // Collect all messages from client
    const messages: unknown[] = [];
    for (let i = 0; i < 6; i++) {
      messages.push(await client.nextMessage());
    }

    expect(messages[0]).toEqual({ type: 'run:start', testCount: 2 });
    expect(messages[1]).toEqual({ type: 'test:start', id: '1', name: 'adds numbers', suite: 'Math' });
    expect(messages[2]).toEqual({ type: 'test:pass', id: '1', name: 'adds numbers', suite: 'Math', duration: 5 });
    expect(messages[3]).toEqual({ type: 'test:start', id: '2', name: 'subtracts', suite: 'Math' });
    expect(messages[4]).toEqual({ type: 'test:fail', id: '2', name: 'subtracts', suite: 'Math', error: 'Expected 3 but got 4', duration: 8 });
    expect(messages[5]).toEqual({ type: 'run:complete', passed: 1, failed: 1, skipped: 0, duration: 13 });
  });

  it('should respond to status command', async () => {
    const browser = track(await connectAs('browser'));
    const client = track(await connectAs('client'));
    // Drain connected message
    await client.nextMessage();

    browser.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'status') {
        browser.ws.send(JSON.stringify({
          type: 'status:result',
          tests: [
            { id: '1', name: 'adds numbers', suite: 'Math', status: 'pass' },
            { id: '2', name: 'subtracts', suite: 'Math', status: 'fail' },
          ],
        }));
      }
    });

    client.ws.send(JSON.stringify({ type: 'status' }));
    const msg = await client.nextMessage();

    expect(msg).toEqual({
      type: 'status:result',
      tests: [
        { id: '1', name: 'adds numbers', suite: 'Math', status: 'pass' },
        { id: '2', name: 'subtracts', suite: 'Math', status: 'fail' },
      ],
    });
  });

  it('should handle browser reconnection', async () => {
    const browser1 = track(await connectAs('browser'));
    const client = track(await connectAs('client'));
    // Drain connected message (browser: true)
    await client.nextMessage();

    // Browser disconnects
    browser1.ws.close();
    const disconnectMsg = await client.nextMessage();
    expect(disconnectMsg).toEqual({ type: 'connected', browser: false });

    // New browser connects
    const browser2 = track(await connectAs('browser'));
    const reconnectMsg = await client.nextMessage();
    expect(reconnectMsg).toEqual({ type: 'connected', browser: true });

    // Client can now run commands again
    client.ws.send(JSON.stringify({ type: 'run', scope: 'all' }));
    const msg = await browser2.nextMessage();
    expect(msg).toEqual({ type: 'run', scope: 'all' });
  });
});
