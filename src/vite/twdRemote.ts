import { createTwdRelay } from '../relay';
import type { Server } from 'http';

export interface TwdRemoteOptions {
  /** WebSocket path. Default: '/__twd/ws' */
  path?: string;
}

interface VitePlugin {
  name: string;
  configureServer?: (server: { httpServer: Server | null }) => void;
}

export function twdRemote(options?: TwdRemoteOptions): VitePlugin {
  return {
    name: 'twd-relay',
    configureServer(server) {
      if (!server.httpServer) return;

      const relay = createTwdRelay(server.httpServer, {
        path: options?.path ?? '/__twd/ws',
      });

      server.httpServer.on('close', () => relay.close());
    },
  };
}
