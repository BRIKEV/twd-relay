import { createServer } from 'http';
import { createTwdRelay } from '../relay';

const args = process.argv.slice(2);
let port = 9876;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    port = parseInt(args[i + 1], 10);
    if (isNaN(port)) {
      console.error('Invalid port number:', args[i + 1]);
      process.exit(1);
    }
    i++;
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
