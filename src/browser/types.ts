export interface BrowserClientOptions {
  /** WebSocket URL. Default: auto-detected from window.location */
  url?: string;
  /** Auto-reconnect on disconnect. Default: true */
  reconnect?: boolean;
  /** Milliseconds between reconnect attempts. Default: 2000 */
  reconnectInterval?: number;
}

export interface BrowserClient {
  connect(): void;
  disconnect(): void;
  readonly connected: boolean;
}
