import type { BrowserClient, BrowserClientOptions } from './types';

declare global {
  interface Window {
    __TWD_STATE__?: {
      handlers: Map<string, {
        id: string;
        name: string;
        parent?: string;
        handler: () => void | Promise<void>;
        children?: string[];
        type: 'suite' | 'test';
        status?: 'idle' | 'pass' | 'fail' | 'skip' | 'running';
        logs: string[];
        depth: number;
        only?: boolean;
        skip?: boolean;
      }>;
    };
  }
}

interface TwdHandler {
  id: string;
  name: string;
  parent?: string;
  handler: () => void | Promise<void>;
  children?: string[];
  type: 'suite' | 'test';
  status?: 'idle' | 'pass' | 'fail' | 'skip' | 'running';
  logs: string[];
  depth: number;
  only?: boolean;
  skip?: boolean;
}

interface TwdRunnerEvents {
  onStart: (test: TwdHandler) => void;
  onPass: (test: TwdHandler) => void;
  onFail: (test: TwdHandler, error: Error) => void;
  onSkip: (test: TwdHandler) => void;
  onSuiteStart?: (suite: TwdHandler) => void;
  onSuiteEnd?: (suite: TwdHandler) => void;
}

function getDefaultUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/__twd/ws`;
}

function getSuiteName(handler: TwdHandler, handlers: Map<string, TwdHandler>): string {
  if (!handler.parent) return '';
  const parent = handlers.get(handler.parent);
  return parent ? parent.name : '';
}

export function createBrowserClient(options?: BrowserClientOptions): BrowserClient {
  const url = options?.url ?? getDefaultUrl();
  const reconnect = options?.reconnect ?? true;
  const reconnectInterval = options?.reconnectInterval ?? 2000;
  const enableLog = options?.log ?? false;
  const logPrefix = '[twd-relay]';

  function log(...args: unknown[]): void {
    if (enableLog) console.info(logPrefix, ...args);
  }

  let ws: WebSocket | null = null;
  let intentionalClose = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function send(data: unknown): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  function dispatchStateChange(): void {
    window.dispatchEvent(new CustomEvent('twd:state-change'));
  }

  async function handleRunCommand(): Promise<void> {
    const twdState = window.__TWD_STATE__;
    if (!twdState) {
      send({ type: 'error', code: 'NO_TWD', message: 'TWD not initialized' });
      return;
    }

    const handlers = twdState.handlers;
    const testCount = Array.from(handlers.values()).filter(h => h.type === 'test').length;
    send({ type: 'run:start', testCount });

    let passed = 0;
    let failed = 0;
    let skipped = 0;
    const runStart = performance.now();

    const events: TwdRunnerEvents = {
      onStart(test: TwdHandler) {
        test.status = 'running';
        dispatchStateChange();
        send({
          type: 'test:start',
          id: test.id,
          name: test.name,
          suite: getSuiteName(test, handlers),
        });
      },
      onPass(test: TwdHandler) {
        passed++;
        test.status = 'pass';
        dispatchStateChange();
        send({
          type: 'test:pass',
          id: test.id,
          name: test.name,
          suite: getSuiteName(test, handlers),
          duration: performance.now() - runStart,
        });
      },
      onFail(test: TwdHandler, error: Error) {
        failed++;
        test.status = 'fail';
        test.logs = [error.message];
        dispatchStateChange();
        send({
          type: 'test:fail',
          id: test.id,
          name: test.name,
          suite: getSuiteName(test, handlers),
          error: error.message,
          duration: performance.now() - runStart,
        });
      },
      onSkip(test: TwdHandler) {
        skipped++;
        test.status = 'skip';
        dispatchStateChange();
        send({
          type: 'test:skip',
          id: test.id,
          name: test.name,
          suite: getSuiteName(test, handlers),
        });
      },
      onSuiteStart(suite: TwdHandler) {
        suite.status = 'running';
        dispatchStateChange();
      },
      onSuiteEnd(suite: TwdHandler) {
        suite.status = 'idle';
        dispatchStateChange();
      },
    };

    // Dynamically import TestRunner from twd-js/runner
    try {
      const { TestRunner } = await import('twd-js/runner');
      const runner = new TestRunner(events);
      await runner.runAll();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      send({ type: 'error', code: 'RUNNER_ERROR', message: errorMsg });
    }

    const duration = performance.now() - runStart;
    send({ type: 'run:complete', passed, failed, skipped, duration });
    dispatchStateChange();
  }

  function handleStatusCommand(): void {
    const twdState = window.__TWD_STATE__;
    if (!twdState) {
      send({ type: 'error', code: 'NO_TWD', message: 'TWD not initialized' });
      return;
    }

    const handlers = twdState.handlers;
    const tests: Array<{ id: string; name: string; suite: string; status: string }> = [];

    for (const [, handler] of handlers) {
      if (handler.type === 'test') {
        tests.push({
          id: handler.id,
          name: handler.name,
          suite: getSuiteName(handler, handlers),
          status: handler.status ?? 'idle',
        });
      }
    }

    send({ type: 'status:result', tests });
  }

  function handleMessage(event: MessageEvent): void {
    let parsed: { type?: string };
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return;
    }

    if (parsed.type === 'run') {
      log('Received run command — running tests...');
      handleRunCommand();
    } else if (parsed.type === 'status') {
      handleStatusCommand();
    }
  }

  function scheduleReconnect(): void {
    if (reconnect && !intentionalClose) {
      log(`Reconnecting in ${reconnectInterval}ms...`);
      reconnectTimer = setTimeout(() => {
        connect();
      }, reconnectInterval);
    }
  }

  function connect(): void {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    intentionalClose = false;
    log('Connecting to', url);
    ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      send({ type: 'hello', role: 'browser' });
      log('Connected to relay — ready to receive run/status commands');
    });

    ws.addEventListener('message', handleMessage);

    ws.addEventListener('close', (event) => {
      ws = null;

      // If replaced by another browser instance, don't reconnect — the relay
      // only supports one browser and this instance has been evicted.
      if (event.reason === 'Replaced by new browser') {
        log('Another browser instance connected — this instance will not reconnect');
        return;
      }

      if (!intentionalClose) {
        log('Disconnected', event.code ? `(code ${event.code})` : '', event.reason || '');
      }
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // Error is followed by close, so reconnect is handled there
    });
  }

  function disconnect(): void {
    intentionalClose = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      ws.close(1000, 'Client disconnecting');
      ws = null;
    }
  }

  return {
    connect,
    disconnect,
    get connected() {
      return ws !== null && ws.readyState === WebSocket.OPEN;
    },
  };
}
