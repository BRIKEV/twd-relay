#!/usr/bin/env node
/**
 * Connects to the relay as a "client" and sends a run command.
 * Use this to manually trigger tests when the relay and browser app are running.
 *
 * Usage: node scripts/send-run.js [--port 9876]
 * Default port: 9876
 */

import WebSocket from 'ws';

const args = process.argv.slice(2);
let port = 9876;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    port = parseInt(args[i + 1], 10);
    break;
  }
}

const url = `ws://localhost:${port}/__twd/ws`;
const ws = new WebSocket(url);

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'hello', role: 'client' }));
});

let runSent = false;
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('←', msg.type, msg.type === 'error' ? msg : '');
  if (msg.type === 'connected') {
    if (msg.browser && !runSent) {
      runSent = true;
      console.log('Browser connected. Sending run...');
      ws.send(JSON.stringify({ type: 'run', scope: 'all' }));
    } else if (!msg.browser) {
      console.log('Waiting for browser (open the app in a tab)...');
    }
  }
  if (msg.type === 'run:complete') {
    ws.close();
  }
});

ws.on('close', () => {
  console.log('Connection closed');
  process.exit(0);
});

ws.on('error', (err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

console.log('Connecting to', url, '...');
