import { createTwdRelay } from '../relay';
import type { Server } from 'http';

export interface TwdRemoteOptions {
  /** WebSocket path. Default: '/__twd/ws' (relative to Vite `base`). */
  path?: string;

  /**
   * Auto-inject the browser client connect script into index.html in dev.
   * Set to `false` to opt out (e.g. when wiring `createBrowserClient`
   * manually in your entry file).
   *
   * Pass an object to forward options to the injected `createBrowserClient`
   * call. Useful overrides: `reconnect`, `reconnectInterval`, `log`,
   * `maxTestDurationMs`.
   *
   * Default: `true` (auto-connect with default client options).
   */
  autoConnect?: boolean | AutoConnectOptions;
}

export interface AutoConnectOptions {
  /** See `BrowserClientOptions.reconnect`. */
  reconnect?: boolean;
  /** See `BrowserClientOptions.reconnectInterval`. */
  reconnectInterval?: number;
  /** See `BrowserClientOptions.log`. */
  log?: boolean;
  /** See `BrowserClientOptions.maxTestDurationMs`. */
  maxTestDurationMs?: number;
}

interface HtmlTagDescriptor {
  tag: string;
  attrs?: Record<string, string>;
  injectTo?: 'head' | 'body' | 'head-prepend' | 'body-prepend';
}

interface VitePlugin {
  name: string;
  apply?: 'serve' | 'build';
  configResolved?: (config: { base: string }) => void;
  configureServer?: (server: { httpServer: Server | null }) => void;
  resolveId?: (id: string) => string | null;
  load?: (id: string) => string | null;
  transformIndexHtml?: () => HtmlTagDescriptor[] | undefined;
}

const VIRTUAL_ID = 'virtual:twd-relay/connect';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

export function twdRemote(options?: TwdRemoteOptions): VitePlugin {
  let resolvedBase = '/';
  let resolvedPath = '/__twd/ws';

  const autoConnectEnabled = options?.autoConnect !== false;
  const autoConnectOptions: AutoConnectOptions =
    typeof options?.autoConnect === 'object' && options.autoConnect !== null
      ? options.autoConnect
      : {};

  return {
    name: 'twd-relay',
    apply: 'serve',
    configResolved(config) {
      resolvedBase = config.base;
      resolvedPath =
        options?.path ?? resolvedBase.replace(/\/$/, '') + '/__twd/ws';
    },
    configureServer(server) {
      if (!server.httpServer) return;
      const path =
        options?.path ?? resolvedBase.replace(/\/$/, '') + '/__twd/ws';
      const relay = createTwdRelay(server.httpServer, { path });
      server.httpServer.on('close', () => relay.close());
    },
    resolveId(id) {
      if (!autoConnectEnabled) return null;
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    load(id) {
      if (!autoConnectEnabled || id !== RESOLVED_ID) return null;
      const opts = JSON.stringify({ path: resolvedPath, ...autoConnectOptions });
      return [
        "import { createBrowserClient } from 'twd-relay/browser';",
        `createBrowserClient(${opts}).connect();`,
      ].join('\n');
    },
    transformIndexHtml() {
      if (!autoConnectEnabled) return undefined;
      return [
        {
          tag: 'script',
          attrs: {
            type: 'module',
            src: `${resolvedBase}@id/${VIRTUAL_ID}`,
          },
          injectTo: 'head',
        },
      ];
    },
  };
}
