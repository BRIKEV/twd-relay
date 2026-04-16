import type { BrowserClient, BrowserClientOptions } from './types';
import { createFaviconManager } from './faviconManager';
import { createRunMonitor } from './runMonitor';

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

function getDefaultUrl(path: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${path}`;
}

function getSuiteName(handler: TwdHandler, handlers: Map<string, TwdHandler>): string {
  if (!handler.parent) return '';
  const parent = handlers.get(handler.parent);
  return parent ? parent.name : '';
}

export function createBrowserClient(options?: BrowserClientOptions): BrowserClient {
  const url = options?.url ?? getDefaultUrl(options?.path ?? '/__twd/ws');
  const reconnect = options?.reconnect ?? true;
  const reconnectInterval = options?.reconnectInterval ?? 2000;
  const enableLog = options?.log ?? false;
  const defaultMaxTestDurationMs = options?.maxTestDurationMs ?? 10_000;
  const logPrefix = '[twd-relay]';

  function log(...args: unknown[]): void {
    if (enableLog) console.info(logPrefix, ...args);
  }

  function warn(...args: unknown[]): void {
    console.warn(logPrefix, ...args);
  }

  const faviconManager = createFaviconManager(document);
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

  async function handleRunCommand(
    testNames?: string[],
    parsed: { maxTestDurationMs?: number } = {},
  ): Promise<void> {
    const thresholdMs =
      typeof parsed.maxTestDurationMs === 'number'
        ? parsed.maxTestDurationMs
        : defaultMaxTestDurationMs;
    const monitor = createRunMonitor({ thresholdMs });

    let passed = 0;
    let failed = 0;
    let skipped = 0;
    const runStart = performance.now();

    const heartbeatInterval = setInterval(() => {
      send({ type: 'heartbeat' });
      const breach = monitor.checkThreshold();
      if (!breach || monitor.isAborted()) return;
      monitor.markAborted();
      send({
        type: 'run:aborted',
        reason: 'throttled',
        durationMs: breach.durationMs,
        testName: breach.testName,
      });
      send({
        type: 'run:complete',
        passed,
        failed,
        skipped,
        duration: performance.now() - runStart,
      });
      // Paint the tab indicator to match the wire state now; otherwise the
      // favicon stays 'running' until the (possibly hung) runner promise resolves.
      faviconManager.set('fail');
      dispatchStateChange();
      clearInterval(heartbeatInterval);
    }, 3000);

    faviconManager.set('running');

    try {
      const twdState = window.__TWD_STATE__;
      if (!twdState) {
        warn('TWD not initialized — make sure twd-js is loaded before running tests');
        send({ type: 'error', code: 'NO_TWD', message: 'TWD not initialized' });
        return;
      }

      const handlers = twdState.handlers;
      let testIds: string[] | undefined;

      if (testNames && testNames.length > 0) {
        const lowerNames = testNames.map(n => n.toLowerCase());
        const matched: string[] = [];
        for (const [, handler] of handlers) {
          if (handler.type === 'test') {
            const lowerName = handler.name.toLowerCase();
            if (lowerNames.some(n => lowerName.includes(n))) {
              matched.push(handler.id);
            }
          }
        }

        if (matched.length === 0) {
          const available = Array.from(handlers.values())
            .filter(h => h.type === 'test')
            .map(h => h.name);
          send({ type: 'run:start', testCount: 0 });
          send({
            type: 'error',
            code: 'NO_MATCH',
            message: `No tests matched: ${JSON.stringify(testNames)}. Available tests: ${JSON.stringify(available)}`,
          });
          send({ type: 'run:complete', passed: 0, failed: 0, skipped: 0, duration: 0 });
          faviconManager.set('pass');
          return;
        }

        testIds = matched;
      }

      const testCount = testIds
        ? testIds.length
        : Array.from(handlers.values()).filter(h => h.type === 'test').length;
      send({ type: 'run:start', testCount });

      const events: TwdRunnerEvents = {
        onStart(test: TwdHandler) {
          if (monitor.isAborted()) return;
          monitor.onTestStart(test.name);
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
          monitor.onTestEnd();
          if (monitor.isAborted()) return;
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
          monitor.onTestEnd();
          if (monitor.isAborted()) return;
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
          monitor.onTestEnd();
          if (monitor.isAborted()) return;
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
          if (monitor.isAborted()) return;
          suite.status = 'running';
          dispatchStateChange();
        },
        onSuiteEnd(suite: TwdHandler) {
          if (monitor.isAborted()) return;
          suite.status = 'idle';
          dispatchStateChange();
        },
      };

      try {
        const { TestRunner } = await import('twd-js/runner');
        const runner = new TestRunner(events);
        if (testIds) {
          await runner.runByIds(testIds);
        } else {
          await runner.runAll();
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        warn('Runner error:', errorMsg);
        send({ type: 'error', code: 'RUNNER_ERROR', message: errorMsg });
        // A runner crash is a failure, not a pass — count it so the downstream
        // set(failed > 0 ? 'fail' : 'pass') lands on red and run:complete
        // accurately reflects that something went wrong.
        failed++;
        // Clear the monitor's in-flight slot so a stale test name can't trip
        // a threshold breach after the crash.
        monitor.onTestEnd();
      }

      const duration = performance.now() - runStart;
      if (!monitor.isAborted()) {
        send({ type: 'run:complete', passed, failed, skipped, duration });
        faviconManager.set(failed > 0 ? 'fail' : 'pass');
      } else {
        // Abort already sent its own run:complete; paint the tab as failed
        // so the user sees the abnormal termination.
        faviconManager.set('fail');
      }
      dispatchStateChange();
    } finally {
      clearInterval(heartbeatInterval);
    }
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
    let parsed: { type?: string; testNames?: string[]; maxTestDurationMs?: number };
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return;
    }

    if (parsed.type === 'run') {
      log('Received run command — running tests...');
      const testNames = Array.isArray(parsed.testNames) ? parsed.testNames : undefined;
      handleRunCommand(testNames, parsed);
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
      faviconManager.save();
      faviconManager.set('connected');
      log('Connected to relay — ready to receive run/status commands');
    });

    ws.addEventListener('message', handleMessage);

    ws.addEventListener('close', (event) => {
      ws = null;
      faviconManager.restore();

      // If replaced by another browser instance, don't reconnect — the relay
      // only supports one browser and this instance has been evicted.
      if (event.reason === 'Replaced by new browser') {
        warn('Another browser instance connected — this instance will not reconnect');
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
