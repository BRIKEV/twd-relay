import { describe, it, expect } from 'vitest';
import { createRunMonitor } from '../../browser/runMonitor';

function makeClock() {
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

describe('runMonitor', () => {
  it('is not aborted on construction', () => {
    const monitor = createRunMonitor({ thresholdMs: 1000 });
    expect(monitor.isAborted()).toBe(false);
  });

  it('checkThreshold returns null when no test is in flight', () => {
    const monitor = createRunMonitor({ thresholdMs: 1000 });
    expect(monitor.checkThreshold()).toBeNull();
  });

  it('checkThreshold returns null when the current test is under threshold', () => {
    const clock = makeClock();
    const monitor = createRunMonitor({ thresholdMs: 1000, now: clock.now });
    monitor.onTestStart('fast test');
    clock.advance(500);
    expect(monitor.checkThreshold()).toBeNull();
  });

  it('checkThreshold returns test name + duration when threshold is exceeded', () => {
    const clock = makeClock();
    const monitor = createRunMonitor({ thresholdMs: 1000, now: clock.now });
    monitor.onTestStart('slow test');
    clock.advance(1500);
    const result = monitor.checkThreshold();
    expect(result).not.toBeNull();
    expect(result?.testName).toBe('slow test');
    expect(result?.durationMs).toBe(1500);
  });

  it('checkThreshold returns null when duration exactly equals threshold', () => {
    const clock = makeClock();
    const monitor = createRunMonitor({ thresholdMs: 1000, now: clock.now });
    monitor.onTestStart('boundary test');
    clock.advance(1000);
    expect(monitor.checkThreshold()).toBeNull();
    clock.advance(1);
    expect(monitor.checkThreshold()).not.toBeNull();
  });

  it('onTestEnd clears the current test — checkThreshold then returns null', () => {
    const clock = makeClock();
    const monitor = createRunMonitor({ thresholdMs: 1000, now: clock.now });
    monitor.onTestStart('test');
    clock.advance(2000);
    monitor.onTestEnd();
    expect(monitor.checkThreshold()).toBeNull();
  });

  it('markAborted flips isAborted to true', () => {
    const monitor = createRunMonitor({ thresholdMs: 1000 });
    monitor.markAborted();
    expect(monitor.isAborted()).toBe(true);
  });

  it('thresholdMs 0 disables detection even for arbitrarily long tests', () => {
    const clock = makeClock();
    const monitor = createRunMonitor({ thresholdMs: 0, now: clock.now });
    monitor.onTestStart('forever');
    clock.advance(1_000_000);
    expect(monitor.checkThreshold()).toBeNull();
  });

  it('consecutive onTestStart replaces the tracked test', () => {
    const clock = makeClock();
    const monitor = createRunMonitor({ thresholdMs: 1000, now: clock.now });
    monitor.onTestStart('first');
    clock.advance(500);
    monitor.onTestStart('second');
    clock.advance(600);
    // 600 ms since 'second' started, under threshold
    expect(monitor.checkThreshold()).toBeNull();
    clock.advance(500);
    const result = monitor.checkThreshold();
    expect(result?.testName).toBe('second');
    expect(result?.durationMs).toBe(1100);
  });

  it('onTestEnd returns breach info when the just-ended test exceeded threshold', () => {
    const clock = makeClock();
    const monitor = createRunMonitor({ thresholdMs: 1000, now: clock.now });
    monitor.onTestStart('slow');
    clock.advance(1500);
    const breach = monitor.onTestEnd();
    expect(breach).toEqual({ testName: 'slow', durationMs: 1500 });
  });

  it('onTestEnd returns null when the just-ended test was under threshold', () => {
    const clock = makeClock();
    const monitor = createRunMonitor({ thresholdMs: 1000, now: clock.now });
    monitor.onTestStart('fast');
    clock.advance(500);
    expect(monitor.onTestEnd()).toBeNull();
  });

  it('onTestEnd returns null when called with no test in flight', () => {
    const monitor = createRunMonitor({ thresholdMs: 1000 });
    expect(monitor.onTestEnd()).toBeNull();
  });

  it('onTestEnd returns null when detection is disabled even if duration was large', () => {
    const clock = makeClock();
    const monitor = createRunMonitor({ thresholdMs: 0, now: clock.now });
    monitor.onTestStart('huge');
    clock.advance(1_000_000);
    expect(monitor.onTestEnd()).toBeNull();
  });
});
