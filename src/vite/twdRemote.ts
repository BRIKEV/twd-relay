import { createTwdRelay } from '../relay';
import type { Server } from 'http';

export interface TwdRemoteOptions {
  /** WebSocket path. Default: '/__twd/ws' */
  path?: string;
}

interface VitePlugin {
  name: string;
  configResolved?: (config: { base: string }) => void;
  configureServer?: (server: { httpServer: Server | null }) => void;
}

export function twdRemote(options?: TwdRemoteOptions): VitePlugin {
  let resolvedBase = '/';

  return {
    name: 'twd-relay',
    configResolved(config) {
      resolvedBase = config.base;
    },
    configureServer(server) {
      if (!server.httpServer) return;

      const path =
        options?.path ?? resolvedBase.replace(/\/$/, '') + '/__twd/ws';

      const relay = createTwdRelay(server.httpServer, { path });

      server.httpServer.on('close', () => relay.close());
    },
  };
}
