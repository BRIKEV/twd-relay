import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, Server } from 'http';
import WebSocket from 'ws';
import { createTwdRelay } from '../../relay';
import type { TwdRelay } from '../../relay';

const PORT = 9885;
const WS_URL = `ws://localhost:${PORT}/__twd/ws`; // 9885 avoids conflicts: 9877=relay, 9878=browser, 9879-9884=vite

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

describe('heartbeat run recovery', () => {
  let server: Server;
  let relay: TwdRelay;
  const tracked: TrackedWs[] = [];

  function track(t: TrackedWs): TrackedWs {
    tracked.push(t);
    return t;
  }

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
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
    vi.useRealTimers();
  });

  it('should not forward heartbeat messages to clients', async () => {
    const browser = track(await connectAs('browser'));
    const client = track(await connectAs('client'));
    // Drain connected message
    await client.nextMessage();

    // Start a run
    client.ws.send(JSON.stringify({ type: 'run', scope: 'all' }));
    await browser.nextMessage(); // browser gets the run command

    // Browser sends heartbeat
    browser.ws.send(JSON.stringify({ type: 'heartbeat' }));

    // Browser sends a real event after the heartbeat
    browser.ws.send(JSON.stringify({ type: 'run:start', testCount: 1 }));

    // Client should get run:start, NOT the heartbeat
    const msg = await client.nextMessage();
    expect(msg).toEqual({ type: 'run:start', testCount: 1 });
  });

  it('should send run:abandoned after heartbeat timeout', async () => {
    const browser = track(await connectAs('browser'));
    const client = track(await connectAs('client'));
    // Drain connected message
    await client.nextMessage();

    // Start a run (no heartbeats will be sent)
    client.ws.send(JSON.stringify({ type: 'run', scope: 'all' }));
    await browser.nextMessage(); // browser gets the run command

    // Advance past the 120s heartbeat timeout + one check interval
    vi.advanceTimersByTime(130_000);

    const msg = await client.nextMessage();
    expect(msg).toEqual({ type: 'run:abandoned', reason: 'heartbeat_timeout' });
  });

  it('should reset run lock after abandonment, allowing new runs', async () => {
    const browser = track(await connectAs('browser'));
    const client = track(await connectAs('client'));
    // Drain connected message
    await client.nextMessage();

    // Start a run
    client.ws.send(JSON.stringify({ type: 'run', scope: 'all' }));
    await browser.nextMessage();

    // Trigger abandonment
    vi.advanceTimersByTime(130_000);
    await client.nextMessage(); // drain run:abandoned

    // Should be able to start a new run
    client.ws.send(JSON.stringify({ type: 'run', scope: 'all' }));
    const msg = await browser.nextMessage();
    expect(msg).toEqual({ type: 'run', scope: 'all' });
  });

  it('should not abandon when heartbeats keep arriving', async () => {
    const browser = track(await connectAs('browser'));
    const client = track(await connectAs('client'));
    // Drain connected message
    await client.nextMessage();

    // Start a run
    client.ws.send(JSON.stringify({ type: 'run', scope: 'all' }));
    await browser.nextMessage();

    // Send heartbeats at regular intervals for 130s total
    for (let elapsed = 0; elapsed < 130_000; elapsed += 3_000) {
      vi.advanceTimersByTime(3_000);
      browser.ws.send(JSON.stringify({ type: 'heartbeat' }));
      // Allow event loop tick for message processing
      await vi.advanceTimersByTimeAsync(0);
    }

    // Complete the run normally
    browser.ws.send(JSON.stringify({
      type: 'run:complete', passed: 1, failed: 0, skipped: 0, duration: 130_000,
    }));

    const msg = await client.nextMessage();
    expect(msg).toEqual({
      type: 'run:complete', passed: 1, failed: 0, skipped: 0, duration: 130_000,
    });
  });

  it('should stop heartbeat tracking on run:complete', async () => {
    const browser = track(await connectAs('browser'));
    const client = track(await connectAs('client'));
    // Drain connected message
    await client.nextMessage();

    // Start a run
    client.ws.send(JSON.stringify({ type: 'run', scope: 'all' }));
    await browser.nextMessage();

    // Send heartbeat then complete
    browser.ws.send(JSON.stringify({ type: 'heartbeat' }));
    browser.ws.send(JSON.stringify({
      type: 'run:complete', passed: 1, failed: 0, skipped: 0, duration: 100,
    }));
    await client.nextMessage(); // drain run:complete

    // Advance way past timeout — should NOT get run:abandoned
    vi.advanceTimersByTime(200_000);

    // Start another run to confirm no stale state
    client.ws.send(JSON.stringify({ type: 'run', scope: 'all' }));
    const msg = await browser.nextMessage();
    expect(msg).toEqual({ type: 'run', scope: 'all' });
  });

  it('should broadcast run:abandoned to all connected clients', async () => {
    const browser = track(await connectAs('browser'));
    const client1 = track(await connectAs('client'));
    const client2 = track(await connectAs('client'));
    // Drain connected messages
    await client1.nextMessage();
    await client2.nextMessage();

    // Start a run
    client1.ws.send(JSON.stringify({ type: 'run', scope: 'all' }));
    await browser.nextMessage();

    // Trigger abandonment
    vi.advanceTimersByTime(130_000);

    const [msg1, msg2] = await Promise.all([
      client1.nextMessage(),
      client2.nextMessage(),
    ]);
    expect(msg1).toEqual({ type: 'run:abandoned', reason: 'heartbeat_timeout' });
    expect(msg2).toEqual({ type: 'run:abandoned', reason: 'heartbeat_timeout' });
  });
});
