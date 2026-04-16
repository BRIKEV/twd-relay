export interface RunMonitor {
  onTestStart(name: string): void;
  /**
   * Records the end of the current test. Returns breach info if the test's
   * elapsed duration exceeded the threshold; otherwise null. Always clears
   * the in-flight slot regardless of return value.
   */
  onTestEnd(): { testName: string; durationMs: number } | null;
  checkThreshold(): { testName: string; durationMs: number } | null;
  markAborted(): void;
  isAborted(): boolean;
}

export interface RunMonitorOptions {
  /** Max wall-clock ms any single test may run. Any non-positive value (0 or negative) disables detection. */
  thresholdMs: number;
  /** Clock function; defaults to performance.now. Override for testing. */
  now?: () => number;
}

export function createRunMonitor(options: RunMonitorOptions): RunMonitor {
  const now = options.now ?? (() => performance.now());
  const thresholdMs = options.thresholdMs;

  let currentTestStart: number | null = null;
  let currentTestName: string | null = null;
  let aborted = false;

  return {
    onTestStart(name: string): void {
      currentTestStart = now();
      currentTestName = name;
    },
    onTestEnd() {
      if (currentTestStart === null || currentTestName === null) {
        return null;
      }
      const name = currentTestName;
      const durationMs = now() - currentTestStart;
      currentTestStart = null;
      currentTestName = null;
      if (thresholdMs <= 0) return null;
      if (durationMs <= thresholdMs) return null;
      return { testName: name, durationMs };
    },
    checkThreshold() {
      if (thresholdMs <= 0) return null;
      if (currentTestStart === null || currentTestName === null) return null;
      const durationMs = now() - currentTestStart;
      if (durationMs <= thresholdMs) return null;
      return { testName: currentTestName, durationMs };
    },
    markAborted(): void {
      aborted = true;
    },
    isAborted(): boolean {
      return aborted;
    },
  };
}
