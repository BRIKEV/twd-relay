import WebSocket from 'ws';

export interface RunOptions {
  port: number;
  timeout: number;
  path: string;
  host: string;
  testNames?: string[];
  maxTestDurationMs?: number;
}

export function run(options: RunOptions): void {
  const { port, timeout, path, host, testNames, maxTestDurationMs } = options;
  const url = `ws://${host}:${port}${path}`;

  console.log(`Connecting to ${url}...`);

  const ws = new WebSocket(url);
  let runSent = false;
  let runComplete = false;
  let failed = false;

  const timer = setTimeout(() => {
    console.error(`\nTimeout: no run:complete received within ${timeout / 1000}s`);
    ws.close();
    process.exit(1);
  }, timeout);

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'hello', role: 'client' }));
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());

    switch (msg.type) {
      case 'connected':
        if (msg.browser && !runSent) {
          runSent = true;
          console.log('Browser connected, triggering test run...\n');
          const runMsg: Record<string, unknown> = { type: 'run', scope: 'all' };
          if (testNames?.length) runMsg.testNames = testNames;
          if (maxTestDurationMs !== undefined) runMsg.maxTestDurationMs = maxTestDurationMs;
          ws.send(JSON.stringify(runMsg));
        } else if (!msg.browser) {
          console.log('Waiting for browser to connect...');
        }
        break;

      case 'run:start':
        console.log(`Running ${msg.testCount} test(s)...\n`);
        break;

      case 'test:start':
        console.log(`  RUN:  ${msg.suite} > ${msg.name}`);
        break;

      case 'test:pass':
        console.log(`  PASS: ${msg.suite} > ${msg.name} (${msg.duration}ms)`);
        break;

      case 'test:fail':
        failed = true;
        console.log(`  FAIL: ${msg.suite} > ${msg.name} (${msg.duration}ms)`);
        if (msg.error) {
          console.log(`    Error: ${msg.error}`);
        }
        break;

      case 'test:skip':
        console.log(`  SKIP: ${msg.suite} > ${msg.name}`);
        break;

      case 'run:complete': {
        const duration = (msg.duration / 1000).toFixed(1);
        console.log(`\n--- Run complete ---`);
        console.log(`Passed: ${msg.passed} | Failed: ${msg.failed} | Skipped: ${msg.skipped}`);
        console.log(`Duration: ${duration}s`);
        runComplete = true;
        clearTimeout(timer);
        ws.close();
        process.exit(failed || msg.failed > 0 ? 1 : 0);
        break;
      }

      case 'run:aborted': {
        failed = true;
        const seconds = typeof msg.durationMs === 'number' ? (msg.durationMs / 1000).toFixed(1) : '?';
        console.error(
          `\nRun aborted: test "${msg.testName ?? '?'}" ran for ${seconds}s — threshold exceeded.\n` +
            `The TWD browser tab is likely backgrounded and throttled by the browser.\n` +
            `Foreground the TWD tab (identified by the "[TWD …]" title prefix) and keep it active, then retry.\n` +
            `For unattended runs, prefer \`twd-cli\` which drives a headless browser with no tab throttling.`
        );
        break;
      }

      case 'run:abandoned':
        console.error(
          '\nRun abandoned — browser tab appears frozen. Refresh the browser tab and retry.'
        );
        clearTimeout(timer);
        ws.close();
        process.exit(1);
        break;

      case 'error':
        console.error(`Error [${msg.code}]: ${msg.message}`);
        break;
    }
  });

  ws.on('close', () => {
    clearTimeout(timer);
    if (!runComplete) {
      console.error('Connection closed before run completed');
      process.exit(1);
    }
  });

  ws.on('error', (err) => {
    clearTimeout(timer);
    console.error(`Connection error: ${err.message}`);
    process.exit(1);
  });
}
