export interface BrowserClientOptions {
  /** WebSocket URL. Default: auto-detected from window.location */
  url?: string;
  /** WebSocket path. Default: '/__twd/ws'. Ignored when `url` is set. */
  path?: string;
  /** Auto-reconnect on disconnect. Default: true */
  reconnect?: boolean;
  /** Milliseconds between reconnect attempts. Default: 2000 */
  reconnectInterval?: number;
  /** Enable console logging. Default: false */
  log?: boolean;
}

export interface BrowserClient {
  connect(): void;
  disconnect(): void;
  readonly connected: boolean;
}
