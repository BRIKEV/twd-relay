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

function printHelp() {
  console.log(`Usage: twd-relay [command] [options]

Commands:
  (none), serve   Start the standalone relay server (default)
  run             Connect to a relay and trigger a test run

Options for serve:
  --port <port>   Port to listen on (default: 9876)

Options for run:
  --port <port>      Relay port to connect to (default: 5173)
  --timeout <ms>     Timeout in ms (default: 180000)

Examples:
  twd-relay                     # start relay on port 9876
  twd-relay run                 # trigger run via Vite dev server on 5173
  twd-relay run --port 9876     # trigger run on custom port
  twd-relay run --timeout 30000 # custom timeout`);
}

if (args.includes('--help') || args.includes('-h')) {
  printHelp();
  process.exit(0);
}

if (subcommand === 'run') {
  const portStr = parseFlag('--port');
  const timeoutStr = parseFlag('--timeout');

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

  run({ port, timeout });
} else if (!subcommand || subcommand === 'serve') {
  // Existing relay server logic
  const portStr = parseFlag('--port');
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
    onError(err) {
      console.error('[twd-relay] Error:', err.message);
    },
  });

  server.listen(port, () => {
    console.log(`TWD Relay running on ws://localhost:${port}/__twd/ws`);
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
