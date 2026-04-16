// --- Hello handshake ---

export interface HelloBrowserMessage {
  type: 'hello';
  role: 'browser';
}

export interface HelloClientMessage {
  type: 'hello';
  role: 'client';
}

export type HelloMessage = HelloBrowserMessage | HelloClientMessage;

// --- Commands (client → browser via relay) ---

export interface RunCommand {
  type: 'run';
  scope: 'all';
  testNames?: string[];
  /** Max wall-clock ms any single test may run before the browser aborts
   *  the run with reason 'throttled'. 0 disables detection. Omit to let
   *  the browser use its own default (10000). */
  maxTestDurationMs?: number;
}

export interface StatusCommand {
  type: 'status';
}

export type Command = RunCommand | StatusCommand;

// --- Heartbeat (browser -> relay, not forwarded) ---

export interface HeartbeatMessage {
  type: 'heartbeat';
}

// --- Events (browser → clients via relay) ---

export interface ConnectedEvent {
  type: 'connected';
  browser: boolean;
}

export interface RunStartEvent {
  type: 'run:start';
  testCount: number;
}

export interface TestStartEvent {
  type: 'test:start';
  id: string;
  name: string;
  suite: string;
}

export interface TestPassEvent {
  type: 'test:pass';
  id: string;
  name: string;
  suite: string;
  duration: number;
}

export interface TestFailEvent {
  type: 'test:fail';
  id: string;
  name: string;
  suite: string;
  error: string;
  duration: number;
}

export interface TestSkipEvent {
  type: 'test:skip';
  id: string;
  name: string;
  suite: string;
}

export interface RunCompleteEvent {
  type: 'run:complete';
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
}

export interface RunAbandonedEvent {
  type: 'run:abandoned';
  reason: 'heartbeat_timeout';
}

export interface RunAbortedEvent {
  type: 'run:aborted';
  reason: 'throttled';
  durationMs: number;
  testName: string;
}

export type BrowserEvent =
  | ConnectedEvent
  | RunStartEvent
  | TestStartEvent
  | TestPassEvent
  | TestFailEvent
  | TestSkipEvent
  | RunCompleteEvent
  | RunAbandonedEvent
  | RunAbortedEvent;

// --- Errors ---

export type TwdErrorCode =
  | 'NO_BROWSER'
  | 'RUN_IN_PROGRESS'
  | 'UNKNOWN_COMMAND'
  | 'INVALID_MESSAGE'
  | 'NO_MATCH';

export interface TwdErrorMessage {
  type: 'error';
  code: TwdErrorCode;
  message: string;
}

// --- Aggregate types ---

export type InboundMessage = HelloMessage | Command | HeartbeatMessage | BrowserEvent;

// --- Relay options & return ---

export interface TwdRelayOptions {
  path?: string;
  onError?: (error: Error) => void;
}

export interface TwdRelay {
  close(): void;
  readonly browserConnected: boolean;
  readonly clientCount: number;
}
