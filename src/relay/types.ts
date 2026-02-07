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
}

export interface StatusCommand {
  type: 'status';
}

export type Command = RunCommand | StatusCommand;

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

export type BrowserEvent =
  | ConnectedEvent
  | RunStartEvent
  | TestStartEvent
  | TestPassEvent
  | TestFailEvent
  | TestSkipEvent
  | RunCompleteEvent;

// --- Errors ---

export type TwdErrorCode =
  | 'NO_BROWSER'
  | 'RUN_IN_PROGRESS'
  | 'UNKNOWN_COMMAND'
  | 'INVALID_MESSAGE';

export interface TwdErrorMessage {
  type: 'error';
  code: TwdErrorCode;
  message: string;
}

// --- Aggregate types ---

export type InboundMessage = HelloMessage | Command | BrowserEvent;

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
