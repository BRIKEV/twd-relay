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
  /**
   * Maximum wall-clock ms any single test may run before the browser
   * aborts the run with reason 'throttled'. Typically triggered when the
   * tab is backgrounded and Chrome throttles timers. Default: 10000.
   * Set to 0 to disable detection.
   */
  maxTestDurationMs?: number;
}

export interface BrowserClient {
  connect(): void;
  disconnect(): void;
  readonly connected: boolean;
}
