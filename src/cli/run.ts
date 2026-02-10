import WebSocket from 'ws';

export interface RunOptions {
  port: number;
  timeout: number;
}

export function run(options: RunOptions): void {
  const { port, timeout } = options;
  const url = `ws://localhost:${port}/__twd/ws`;

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
          ws.send(JSON.stringify({ type: 'run', scope: 'all' }));
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
