import { createServer } from 'http';
import { createTwdRelay } from '../relay';
import { run } from './run';

const args = process.argv.slice(2);

// Find first non-flag argument as subcommand
const subcommand = args.find((a) => !a.startsWith('--'));

function parseFlag(name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return undefined;
}

function parseFlagAll(name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1] && !args[i + 1].startsWith('--')) {
      values.push(args[i + 1]);
    }
  }
  return values;
}

function printHelp() {
  console.log(`Usage: twd-relay [command] [options]

Commands:
  (none), serve   Start the standalone relay server (default)
  run             Connect to a relay and trigger a test run

Options for serve:
  --port <port>   Port to listen on (default: 9876)
  --path <path>   WebSocket path (default: /__twd/ws)

Options for run:
  --port <port>                   Relay port to connect to (default: 5173)
  --host <host>                   Relay host to connect to (default: localhost)
  --path <path>                   WebSocket path (default: /__twd/ws)
  --timeout <ms>                  Timeout in ms (default: 180000)
  --test <name>                   Filter tests by name substring (repeatable)
  --max-test-duration <ms>        Abort if any single test exceeds this many
                                  ms (default from browser client, typically
                                  5000; 0 disables)

Examples:
  twd-relay                     # start relay on port 9876
  twd-relay serve --path /app/__twd/ws
  twd-relay run                 # trigger run via Vite dev server on 5173
  twd-relay run --port 9876     # trigger run on custom port
  twd-relay run --host 192.168.1.10 --path /app/__twd/ws
  twd-relay run --timeout 30000 # custom timeout
  twd-relay run --test "login"           # run tests matching "login"
  twd-relay run --test "login" --test "signup"  # run multiple
  twd-relay run --max-test-duration 30000         # raise abort threshold to 30s
  twd-relay run --max-test-duration 0             # disable abort detection`);
}

if (args.includes('--help') || args.includes('-h')) {
  printHelp();
  process.exit(0);
}

if (subcommand === 'run') {
  const portStr = parseFlag('--port');
  const timeoutStr = parseFlag('--timeout');
  const pathFlag = parseFlag('--path') ?? '/__twd/ws';
  const hostFlag = parseFlag('--host') ?? 'localhost';

  const port = portStr ? parseInt(portStr, 10) : 5173;
  if (isNaN(port)) {
    console.error('Invalid port number:', portStr);
    process.exit(1);
  }

  const timeout = timeoutStr ? parseInt(timeoutStr, 10) : 180_000;
  if (isNaN(timeout)) {
    console.error('Invalid timeout value:', timeoutStr);
    process.exit(1);
  }

  const testNames = parseFlagAll('--test');

  const maxDurationStr = parseFlag('--max-test-duration');
  let maxTestDurationMs: number | undefined;
  if (maxDurationStr !== undefined) {
    maxTestDurationMs = parseInt(maxDurationStr, 10);
    if (isNaN(maxTestDurationMs)) {
      console.error('Invalid --max-test-duration value:', maxDurationStr);
      process.exit(1);
    }
  }

  run({
    port,
    timeout,
    path: pathFlag,
    host: hostFlag,
    testNames: testNames.length > 0 ? testNames : undefined,
    maxTestDurationMs,
  });
} else if (!subcommand || subcommand === 'serve') {
  // Existing relay server logic
  const portStr = parseFlag('--port');
  const pathFlag = parseFlag('--path') ?? '/__twd/ws';
  let port = 9876;
  if (portStr) {
    port = parseInt(portStr, 10);
    if (isNaN(port)) {
      console.error('Invalid port number:', portStr);
      process.exit(1);
    }
  }

  const server = createServer();
  const relay = createTwdRelay(server, {
    path: pathFlag,
    onError(err) {
      console.error('[twd-relay] Error:', err.message);
    },
  });

  server.listen(port, () => {
    console.log(`TWD Relay running on ws://localhost:${port}${pathFlag}`);
    console.log('Waiting for connections...');
  });

  function shutdown() {
    console.log('\nShutting down...');
    relay.close();
    server.close(() => {
      process.exit(0);
    });
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} else {
  console.error(`Unknown command: ${subcommand}`);
  printHelp();
  process.exit(1);
}
