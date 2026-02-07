import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { Server } from 'http';
import type { TwdRelay, TwdRelayOptions, TwdErrorCode } from './types';

const DEFAULT_PATH = '/__twd/ws';

export function createTwdRelay(server: Server, options?: TwdRelayOptions): TwdRelay {
  const path = options?.path ?? DEFAULT_PATH;
  const onError = options?.onError;

  const wss = new WebSocketServer({ noServer: true });

  let browser: WebSocket | null = null;
  const clients = new Set<WebSocket>();
  let runInProgress = false;

  function sendError(ws: WebSocket, code: TwdErrorCode, message: string): void {
    const msg = { type: 'error', code, message };
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function broadcastToClients(data: string): void {
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  function sendConnectedStatus(ws: WebSocket): void {
    const msg = { type: 'connected', browser: browser !== null && browser.readyState === WebSocket.OPEN };
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function notifyBrowserDisconnected(): void {
    broadcastToClients(JSON.stringify({ type: 'connected', browser: false }));
  }

  function handleBrowserMessage(data: string): void {
    let parsed: { type?: string };
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (parsed.type === 'run:complete') {
      runInProgress = false;
    }
    broadcastToClients(data);
  }

  function handleClientMessage(ws: WebSocket, data: string): void {
    let parsed: { type?: string };
    try {
      parsed = JSON.parse(data);
    } catch {
      sendError(ws, 'INVALID_MESSAGE', 'Invalid JSON');
      return;
    }

    if (!parsed.type) {
      sendError(ws, 'INVALID_MESSAGE', 'Missing "type" field');
      return;
    }

    if (parsed.type === 'run') {
      if (!browser || browser.readyState !== WebSocket.OPEN) {
        sendError(ws, 'NO_BROWSER', 'No browser connected');
        return;
      }
      if (runInProgress) {
        sendError(ws, 'RUN_IN_PROGRESS', 'A test run is already in progress');
        return;
      }
      runInProgress = true;
      browser.send(data);
      return;
    }

    if (parsed.type === 'status') {
      if (!browser || browser.readyState !== WebSocket.OPEN) {
        sendError(ws, 'NO_BROWSER', 'No browser connected');
        return;
      }
      browser.send(data);
      return;
    }

    sendError(ws, 'UNKNOWN_COMMAND', `Unknown command: ${parsed.type}`);
  }

  function handleConnection(ws: WebSocket): void {
    let identified = false;

    const identifyHandler = (raw: RawData): void => {
      const data = typeof raw === 'string' ? raw : raw.toString();

      if (!identified) {
        let parsed: { type?: string; role?: string };
        try {
          parsed = JSON.parse(data);
        } catch {
          sendError(ws, 'INVALID_MESSAGE', 'Invalid JSON');
          return;
        }

        if (parsed.type !== 'hello' || (parsed.role !== 'browser' && parsed.role !== 'client')) {
          sendError(ws, 'INVALID_MESSAGE', 'First message must be a hello with role "browser" or "client"');
          return;
        }

        identified = true;

        if (parsed.role === 'browser') {
          // Replace existing browser connection
          if (browser && browser.readyState === WebSocket.OPEN) {
            browser.close(1000, 'Replaced by new browser');
          }
          browser = ws;
          runInProgress = false;

          ws.on('close', () => {
            if (browser === ws) {
              browser = null;
              runInProgress = false;
              notifyBrowserDisconnected();
            }
          });

          // Notify all clients that browser is connected
          broadcastToClients(JSON.stringify({ type: 'connected', browser: true }));

          // Forward browser messages to clients
          ws.on('message', (raw: RawData) => {
            const msg = typeof raw === 'string' ? raw : raw.toString();
            handleBrowserMessage(msg);
          });
        } else {
          // Client role
          clients.add(ws);

          ws.on('close', () => {
            clients.delete(ws);
          });

          // Send current browser status
          sendConnectedStatus(ws);

          // Handle client commands
          ws.on('message', (raw: RawData) => {
            const msg = typeof raw === 'string' ? raw : raw.toString();
            handleClientMessage(ws, msg);
          });
        }

        // Remove the identify handler — role-specific handlers are now active
        ws.removeListener('message', identifyHandler);
      }
    };

    ws.on('message', identifyHandler);
    ws.on('error', (err: Error) => {
      if (onError) onError(err);
    });
  }

  const upgradeHandler = (request: import('http').IncomingMessage, socket: import('stream').Duplex, head: Buffer): void => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname === path) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        handleConnection(ws);
      });
    }
  };

  server.on('upgrade', upgradeHandler);

  wss.on('error', (err: Error) => {
    if (onError) onError(err);
  });

  return {
    close() {
      server.removeListener('upgrade', upgradeHandler);

      for (const client of clients) {
        client.close(1000, 'Relay shutting down');
      }
      clients.clear();

      if (browser && browser.readyState === WebSocket.OPEN) {
        browser.close(1000, 'Relay shutting down');
      }
      browser = null;
      runInProgress = false;
      wss.close();
    },
    get browserConnected() {
      return browser !== null && browser.readyState === WebSocket.OPEN;
    },
    get clientCount() {
      return clients.size;
    },
  };
}
