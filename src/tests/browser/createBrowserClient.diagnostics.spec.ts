// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, Server } from 'http';
import WebSocket from 'ws';
import { createTwdRelay } from '../../relay';
import type { TwdRelay } from '../../relay';

/**
 * Drives the real `createBrowserClient` against a real relay, so the wiring
 * between `onFail` and the diagnostics block is actually exercised. The rest of
 * the browser suite simulates a browser-role connection instead, which cannot
 * catch the composition being removed from `onFail`.
 *
 * `twd-js/runner` is mocked because it is a peer dependency that only resolves
 * in a page; the fake runner drives `events.onFail` the way the real one does.
 */

const PORT = 9890;
const WS_URL = `ws://localhost:${PORT}/__twd/ws`;

const failure = {
  message: 'expected 0 to be 3',
  diagnostics: {
    location: '/cg-1/settings/catalog',
    mockRules: { registered: 7, triggered: 6, untriggered: ['catalog'] },
  },
};

vi.mock('twd-js/runner', () => ({
  TestRunner: class {
    private events: {
      onStart: (t: unknown) => void;
      onFail: (t: unknown, e: Error) => void;
    };

    constructor(events: { onStart: (t: unknown) => void; onFail: (t: unknown, e: Error) => void }) {
      this.events = events;
    }

    async runAll(): Promise<void> {
      const test = {
        id: 't1',
        name: 'lists products',
        parent: 's1',
        type: 'test' as const,
        logs: [],
        depth: 1,
        diagnostics: failure.diagnostics,
      };
      this.events.onStart(test);
      this.events.onFail(test, new Error(failure.message));
    }

    async runByIds(): Promise<void> {
      await this.runAll();
    }
  },
}));

function trackedClient(): {
  ws: WebSocket;
  messages: () => unknown[];
  ready: Promise<void>;
} {
  const ws = new WebSocket(WS_URL);
  const received: unknown[] = [];
  ws.on('message', (data) => received.push(JSON.parse(data.toString())));
  const ready = new Promise<void>((resolve, reject) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', role: 'client' }));
      setTimeout(resolve, 50);
    });
    ws.on('error', reject);
  });
  return { ws, messages: () => received, ready };
}

describe('createBrowserClient — failure diagnostics', () => {
  let server: Server;
  let relay: TwdRelay;

  beforeEach(async () => {
    // The browser client uses the global WebSocket; happy-dom's does not open
    // real sockets, so use the `ws` implementation against the local relay.
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = WebSocket;
    window.__TWD_STATE__ = {
      handlers: new Map([
        ['s1', { id: 's1', name: 'Catalog', type: 'suite', logs: [], depth: 0, handler: () => {} }],
        [
          't1',
          {
            id: 't1',
            name: 'lists products',
            parent: 's1',
            type: 'test',
            logs: [],
            depth: 1,
            handler: () => {},
          },
        ],
      ]),
    } as Window['__TWD_STATE__'];

    server = createServer();
    relay = createTwdRelay(server);
    await new Promise<void>((resolve) => server.listen(PORT, resolve));
  });

  afterEach(async () => {
    relay.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.resetModules();
  });

  it('sends the diagnostics block above the message on test:fail', async () => {
    const { createBrowserClient } = await import('../../browser/createBrowserClient');
    const client = trackedClient();
    await client.ready;

    const browser = createBrowserClient({ url: WS_URL });
    browser.connect();
    await new Promise((r) => setTimeout(r, 150));

    client.ws.send(JSON.stringify({ type: 'run', scope: 'all' }));
    await new Promise((r) => setTimeout(r, 250));

    const fail = client.messages().find(
      (m): m is { type: string; error: string } =>
        typeof m === 'object' && m !== null && (m as { type?: string }).type === 'test:fail',
    );

    expect(fail).toBeDefined();
    expect(fail!.error).toBe(
      [
        `── TWD diagnostics ${'─'.repeat(37)}`,
        'location    /cg-1/settings/catalog',
        'mock rules  6/7 triggered — catalog never requested',
        '─'.repeat(56),
        '',
        'expected 0 to be 3',
      ].join('\n'),
    );

    browser.disconnect();
    client.ws.close();
  });
});
