import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, Server } from 'http';
import WebSocket from 'ws';
import { createTwdRelay } from '../../relay';
import type { TwdRelay } from '../../relay';

const PORT = 9877;
const WS_URL = `ws://localhost:${PORT}/__twd/ws`;

/**
 * A WebSocket wrapper that buffers incoming messages so none are lost
 * between connection setup and test assertions.
 */
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
      // Give server a tick to process hello and register the role
      setTimeout(() => resolve(tracked), 50);
    });
    tracked.ws.on('error', reject);
  });
}

describe('createTwdRelay', () => {
  let server: Server;
  let relay: TwdRelay;
  const tracked: TrackedWs[] = [];

  beforeEach(async () => {
    server = createServer();
    relay = createTwdRelay(server);
    await new Promise<void>((resolve) => server.listen(PORT, resolve));
  });

  afterEach(async () => {
    for (const t of tracked) {
      if (t.ws.readyState === WebSocket.OPEN) t.ws.close();
    }
    tracked.length = 0;
    relay.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function track(t: TrackedWs): TrackedWs {
    tracked.push(t);
    return t;
  }

  it('should start with no browser connected and zero clients', () => {
    expect(relay.browserConnected).toBe(false);
    expect(relay.clientCount).toBe(0);
  });

  it('should accept a browser connection', async () => {
    const browser = track(await connectAs('browser'));
    expect(relay.browserConnected).toBe(true);
    expect(relay.clientCount).toBe(0);
    browser.ws.close();
  });

  it('should accept a client connection and send connected status', async () => {
    track(await connectAs('browser'));
    const client = track(await connectAs('client'));

    const msg = await client.nextMessage();
    expect(msg).toEqual({ type: 'connected', browser: true });
    expect(relay.clientCount).toBe(1);
  });

  it('should notify clients when browser disconnects', async () => {
    const browser = track(await connectAs('browser'));
    const client = track(await connectAs('client'));
    // Drain the connected message
    await client.nextMessage();

    browser.ws.close();
    const msg = await client.nextMessage();

    expect(msg).toEqual({ type: 'connected', browser: false });
  });

  it('should return NO_BROWSER error when no browser is connected', async () => {
    const client = track(await connectAs('client'));
    // Drain connected message (browser: false)
    await client.nextMessage();

    client.ws.send(JSON.stringify({ type: 'run', scope: 'all' }));
    const msg = await client.nextMessage();

    expect(msg).toEqual({
      type: 'error',
      code: 'NO_BROWSER',
      message: 'No browser connected',
    });
  });

  it('should forward run command to browser', async () => {
    const browser = track(await connectAs('browser'));
    const client = track(await connectAs('client'));
    // Drain connected message
    await client.nextMessage();

    client.ws.send(JSON.stringify({ type: 'run', scope: 'all' }));
    const msg = await browser.nextMessage();

    expect(msg).toEqual({ type: 'run', scope: 'all' });
  });

  it('should return RUN_IN_PROGRESS when a run is active', async () => {
    const browser = track(await connectAs('browser'));
    const client = track(await connectAs('client'));
    // Drain connected message
    await client.nextMessage();

    // Start a run
    client.ws.send(JSON.stringify({ type: 'run', scope: 'all' }));
    await browser.nextMessage(); // browser gets the run command

    // Try to start another run
    client.ws.send(JSON.stringify({ type: 'run', scope: 'all' }));
    const msg = await client.nextMessage();

    expect(msg).toEqual({
      type: 'error',
      code: 'RUN_IN_PROGRESS',
      message: 'A test run is already in progress',
    });
  });

  it('should reset run lock when run:complete is received from browser', async () => {
    const browser = track(await connectAs('browser'));
    const client = track(await connectAs('client'));
    // Drain connected message
    await client.nextMessage();

    // Start a run
    client.ws.send(JSON.stringify({ type: 'run', scope: 'all' }));
    await browser.nextMessage();

    // Browser sends run:complete
    browser.ws.send(JSON.stringify({ type: 'run:complete', passed: 1, failed: 0, skipped: 0, duration: 100 }));
    // Client receives run:complete
    await client.nextMessage();

    // Now we should be able to start another run
    client.ws.send(JSON.stringify({ type: 'run', scope: 'all' }));
    const msg = await browser.nextMessage();

    expect(msg).toEqual({ type: 'run', scope: 'all' });
  });

  it('should broadcast browser events to all clients', async () => {
    const browser = track(await connectAs('browser'));
    const client1 = track(await connectAs('client'));
    const client2 = track(await connectAs('client'));
    // Drain connected messages
    await client1.nextMessage();
    await client2.nextMessage();

    browser.ws.send(JSON.stringify({ type: 'test:pass', id: '1', name: 'test1', suite: 'suite1', duration: 10 }));

    const [msg1, msg2] = await Promise.all([client1.nextMessage(), client2.nextMessage()]);
    expect(msg1).toEqual({ type: 'test:pass', id: '1', name: 'test1', suite: 'suite1', duration: 10 });
    expect(msg2).toEqual({ type: 'test:pass', id: '1', name: 'test1', suite: 'suite1', duration: 10 });
  });

  it('should send UNKNOWN_COMMAND for unrecognized command types', async () => {
    track(await connectAs('browser'));
    const client = track(await connectAs('client'));
    // Drain connected message
    await client.nextMessage();

    client.ws.send(JSON.stringify({ type: 'foo' }));
    const msg = await client.nextMessage();

    expect(msg).toEqual({
      type: 'error',
      code: 'UNKNOWN_COMMAND',
      message: 'Unknown command: foo',
    });
  });

  it('should send INVALID_MESSAGE for malformed JSON', async () => {
    const client = track(await connectAs('client'));
    // Drain connected message
    await client.nextMessage();

    client.ws.send('not json');
    const msg = await client.nextMessage();

    expect(msg).toEqual({
      type: 'error',
      code: 'INVALID_MESSAGE',
      message: 'Invalid JSON',
    });
  });

  it('should replace existing browser when new one connects', async () => {
    const browser1 = track(await connectAs('browser'));
    expect(relay.browserConnected).toBe(true);

    const closePromise = new Promise<void>((resolve) => {
      browser1.ws.on('close', () => resolve());
    });

    const browser2 = track(await connectAs('browser'));
    await closePromise;

    expect(relay.browserConnected).toBe(true);
    expect(browser1.ws.readyState).toBe(WebSocket.CLOSED);
    browser2.ws.close();
  });

  it('should forward status command to browser', async () => {
    const browser = track(await connectAs('browser'));
    const client = track(await connectAs('client'));
    // Drain connected message
    await client.nextMessage();

    client.ws.send(JSON.stringify({ type: 'status' }));
    const msg = await browser.nextMessage();

    expect(msg).toEqual({ type: 'status' });
  });

  it('should clean up on close()', async () => {
    const browser = track(await connectAs('browser'));
    const client = track(await connectAs('client'));

    relay.close();

    // Wait for connections to close
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(relay.browserConnected).toBe(false);
    expect(relay.clientCount).toBe(0);
    expect(browser.ws.readyState).toBe(WebSocket.CLOSED);
    expect(client.ws.readyState).toBe(WebSocket.CLOSED);
  });
});
