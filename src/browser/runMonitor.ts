export interface RunMonitor {
  onTestStart(name: string): void;
  onTestEnd(): void;
  checkThreshold(): { testName: string; durationMs: number } | null;
  markAborted(): void;
  isAborted(): boolean;
}

export interface RunMonitorOptions {
  /** Max wall-clock ms any single test may run. 0 disables detection. */
  thresholdMs: number;
  /** Clock function; defaults to performance.now. Override for testing. */
  now?: () => number;
}

export function createRunMonitor(options: RunMonitorOptions): RunMonitor {
  // Implemented in Task 4.
  void options;
  return {
    onTestStart() {},
    onTestEnd() {},
    checkThreshold() {
      return null;
    },
    markAborted() {},
    isAborted() {
      return false;
    },
  };
}
