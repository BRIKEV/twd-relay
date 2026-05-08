import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketServer, WebSocket as WsServerSocket } from 'ws';
import { run } from '../../cli/run';

const PORT = 9880;
const HOST = 'localhost';
const PATH = '/__twd/ws';

interface Harness {
  server: WebSocketServer;
  logs: string[];
  errors: string[];
  exitPromise: Promise<number>;
}

/**
 * Start a fake relay on PORT that, when the run() client sends `hello`,
 * replies with `{ type: 'connected', browser: true }` and then invokes
 * `script(ws)` so the test can stream lifecycle events.
 *
 * `process.exit` is mocked to resolve `exitPromise` with the exit code
 * instead of terminating the test runner. `console.log` / `console.error`
 * are captured into `logs` / `errors`.
 */
async function startHarness(
  script: (ws: WsServerSocket) => void,
): Promise<Harness> {
  const logs: string[] = [];
  const errors: string[] = [];

  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });

  let resolveExit!: (code: number) => void;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    resolveExit(code ?? 0);
    return undefined as never;
  }) as typeof process.exit);

  const server = new WebSocketServer({ port: PORT, path: PATH });
  await new Promise<void>((resolve) => server.on('listening', () => resolve()));

  server.on('connection', (ws) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'hello') {
        ws.send(JSON.stringify({ type: 'connected', browser: true }));
      } else if (msg.type === 'run') {
        script(ws);
      }
    });
  });

  return { server, logs, errors, exitPromise };
}

async function stopHarness(h: Harness): Promise<void> {
  await new Promise<void>((resolve) => h.server.close(() => resolve()));
}

describe('cli run — failures recap', () => {
  let harness: Harness | undefined;

  beforeEach(() => {
    harness = undefined;
  });

  afterEach(async () => {
    if (harness) await stopHarness(harness);
    vi.restoreAllMocks();
  });

  it('prints the recap block when tests fail', async () => {
    harness = await startHarness((ws) => {
      ws.send(JSON.stringify({ type: 'run:start', testCount: 2 }));
      ws.send(
        JSON.stringify({ type: 'test:start', suite: 'Checkout', name: 'state dropdown' }),
      );
      ws.send(
        JSON.stringify({
          type: 'test:fail',
          suite: 'Checkout',
          name: 'state dropdown',
          duration: 70,
          error: 'waitFor timed out after 2000ms. Last error: No select items found',
        }),
      );
      ws.send(
        JSON.stringify({ type: 'test:start', suite: 'Checkout', name: 'province dropdown' }),
      );
      ws.send(
        JSON.stringify({
          type: 'test:fail',
          suite: 'Checkout',
          name: 'province dropdown',
          duration: 65,
          error: 'waitFor timed out after 2000ms. Last error: No select items found',
        }),
      );
      ws.send(
        JSON.stringify({
          type: 'run:complete',
          passed: 0,
          failed: 2,
          skipped: 0,
          duration: 1500,
        }),
      );
    });

    run({ port: PORT, host: HOST, path: PATH, timeout: 5000 });

    const code = await harness.exitPromise;
    const out = harness.logs.join('\n');

    expect(out).toContain('Failed tests (2):');
    expect(out).toContain('Checkout > state dropdown');
    expect(out).toContain('Checkout > province dropdown');
    expect(out).toContain('waitFor timed out after 2000ms');
    expect(code).toBe(1);
  });
});
