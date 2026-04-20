import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { WakeDeliveryExecutor, wakeDeliveryExecutorInternals } from "../src/wake-delivery-executor";

describe("WakeDeliveryExecutor", () => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalConsoleError = console.error;

  afterEach(() => {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    console.error = originalConsoleError;
  });

  it("times out hung promise dispatches and exhausts retries", async () => {
    const executor = new WakeDeliveryExecutor();
    const errors: string[] = [];
    let finalFailureCount = 0;

    global.setTimeout = (((fn: (...args: any[]) => void, _delay?: number) => {
      queueMicrotask(() => fn());
      return { fake: true } as any;
    }) as typeof setTimeout);
    global.clearTimeout = ((() => {}) as typeof clearTimeout);
    console.error = (message?: unknown, ...rest: unknown[]) => {
      errors.push([message, ...rest].map((value) => String(value)).join(" "));
    };

    executor.executePromise(
      () => new Promise<void>(() => {}),
      {
        label: "discord-components",
        sessionId: "session-timeout",
        target: "discord.components",
        phase: "notify",
        routeSummary: "discord|channel:123",
        messageKind: "notify",
        onFinalFailure: () => {
          finalFailureCount += 1;
        },
      },
    );

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(finalFailureCount, 1);
    assert.ok(errors.some((line) => line.includes("Dispatch timed out after 30000ms")));
  });

  it("treats direct message.send timeouts as terminal ambiguous results without retrying", async (t) => {
    const executor = new WakeDeliveryExecutor();
    const errors: string[] = [];
    let attempts = 0;
    let ambiguousResultCount = 0;
    let finalFailureCount = 0;

    console.error = (message?: unknown, ...rest: unknown[]) => {
      errors.push([message, ...rest].map((value) => String(value)).join(" "));
    };

    t.mock.method(wakeDeliveryExecutorInternals, "execFile", ((_file, _args, _options, callback) => {
      attempts += 1;
      const error = new Error("Command failed: openclaw message send --channel telegram --target 123") as Error & {
        killed: boolean;
        signal: NodeJS.Signals;
      };
      error.killed = true;
      error.signal = "SIGTERM";
      callback?.(error, "", "");
      return {} as any;
    }) as typeof wakeDeliveryExecutorInternals.execFile);

    executor.execute(
      ["message", "send", "--channel", "telegram", "--target", "123", "--message", "🚀 launched"],
      {
        label: "launch-notify",
        sessionId: "session-direct-timeout",
        target: "message.send",
        phase: "notify",
        routeSummary: "telegram|bot|123",
        messageKind: "notify",
        onAmbiguousResult: () => {
          ambiguousResultCount += 1;
        },
        onFinalFailure: () => {
          finalFailureCount += 1;
        },
      },
    );

    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(attempts, 1);
    assert.equal(ambiguousResultCount, 1);
    assert.equal(finalFailureCount, 0);
    assert.ok(errors.some((line) => line.includes("\"ambiguousResult\":true")));
    assert.ok(!errors.some((line) => line.includes("\"event\":\"dispatch_retry_scheduled\"")));
  });

  it("does not classify non-SIGTERM process failures as ambiguous direct-send timeouts", async (t) => {
    const executor = new WakeDeliveryExecutor();
    const errors: string[] = [];
    let attempts = 0;
    let ambiguousResultCount = 0;
    let finalFailureCount = 0;

    global.setTimeout = (((fn: (...args: any[]) => void, _delay?: number) => {
      queueMicrotask(() => fn());
      return { fake: true, unref() { return this; } } as any;
    }) as typeof setTimeout);
    global.clearTimeout = ((() => {}) as typeof clearTimeout);
    console.error = (message?: unknown, ...rest: unknown[]) => {
      errors.push([message, ...rest].map((value) => String(value)).join(" "));
    };

    t.mock.method(wakeDeliveryExecutorInternals, "execFile", ((_file, _args, _options, callback) => {
      attempts += 1;
      const error = new Error("Command failed: openclaw message send --channel telegram --target 123") as Error & {
        killed: boolean;
        signal: NodeJS.Signals;
      };
      error.killed = true;
      error.signal = "SIGKILL";
      callback?.(error, "", "forced failure");
      return {} as any;
    }) as typeof wakeDeliveryExecutorInternals.execFile);

    executor.execute(
      ["message", "send", "--channel", "telegram", "--target", "123", "--message", "🚀 launched"],
      {
        label: "launch-notify",
        sessionId: "session-direct-sigkill",
        target: "message.send",
        phase: "notify",
        routeSummary: "telegram|bot|123",
        messageKind: "notify",
        onAmbiguousResult: () => {
          ambiguousResultCount += 1;
        },
        onFinalFailure: () => {
          finalFailureCount += 1;
        },
      },
    );

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(attempts, 4);
    assert.equal(ambiguousResultCount, 0);
    assert.equal(finalFailureCount, 1);
    assert.ok(errors.some((line) => line.includes("\"event\":\"dispatch_retry_scheduled\"")));
  });

  it("keeps retrying non-timeout direct message.send failures", async (t) => {
    const executor = new WakeDeliveryExecutor();
    const errors: string[] = [];
    let attempts = 0;
    let finalFailureCount = 0;

    global.setTimeout = (((fn: (...args: any[]) => void, _delay?: number) => {
      queueMicrotask(() => fn());
      return { fake: true, unref() { return this; } } as any;
    }) as typeof setTimeout);
    global.clearTimeout = ((() => {}) as typeof clearTimeout);
    console.error = (message?: unknown, ...rest: unknown[]) => {
      errors.push([message, ...rest].map((value) => String(value)).join(" "));
    };

    t.mock.method(wakeDeliveryExecutorInternals, "execFile", ((_file, _args, _options, callback) => {
      attempts += 1;
      callback?.(new Error("gateway unavailable"), "", "forced failure");
      return {} as any;
    }) as typeof wakeDeliveryExecutorInternals.execFile);

    executor.execute(
      ["message", "send", "--channel", "telegram", "--target", "123", "--message", "🚀 launched"],
      {
        label: "launch-notify",
        sessionId: "session-direct-failure",
        target: "message.send",
        phase: "notify",
        routeSummary: "telegram|bot|123",
        messageKind: "notify",
        onFinalFailure: () => {
          finalFailureCount += 1;
        },
      },
    );

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(attempts, 4);
    assert.equal(finalFailureCount, 1);
    assert.ok(errors.some((line) => line.includes("\"event\":\"dispatch_retry_scheduled\"")));
    assert.ok(!errors.some((line) => line.includes("\"ambiguousResult\":true")));
  });

  it("does not start queued ordered dispatches after dispose clears a pending retry", async () => {
    const executor = new WakeDeliveryExecutor();
    const scheduledTimers: Array<{ cleared: boolean; unref?: () => void }> = [];
    let firstAttempts = 0;
    let secondDispatchRuns = 0;

    global.setTimeout = (((fn: (...args: any[]) => void, _delay?: number) => {
      const timer = {
        cleared: false,
        unref: () => timer,
      };
      scheduledTimers.push(timer);
      return timer as any;
    }) as typeof setTimeout);
    global.clearTimeout = (((timer: { cleared?: boolean }) => {
      if (timer) timer.cleared = true;
    }) as typeof clearTimeout);

    executor.executePromise(
      () => {
        firstAttempts += 1;
        if (firstAttempts === 1) {
          return Promise.reject(new Error("retry once"));
        }
        return Promise.resolve();
      },
      {
        label: "first",
        sessionId: "session-ordered-dispose",
        target: "discord.components",
        phase: "notify",
        routeSummary: "discord|channel:123",
        messageKind: "notify",
        orderingKey: "notify:discord|channel:123",
      },
    );

    executor.executePromise(
      () => {
        secondDispatchRuns += 1;
        return Promise.resolve();
      },
      {
        label: "second",
        sessionId: "session-ordered-dispose",
        target: "discord.components",
        phase: "notify",
        routeSummary: "discord|channel:123",
        messageKind: "notify",
        orderingKey: "notify:discord|channel:123",
      },
    );

    await Promise.resolve();
    await Promise.resolve();

    executor.dispose();

    await Promise.resolve();
    await Promise.resolve();

    assert.ok(scheduledTimers.length > 0, "expected the first dispatch to schedule a retry");
    assert.equal(firstAttempts, 1);
    assert.equal(secondDispatchRuns, 0);
  });

  it("clears pending non-ordered retries without throwing during dispose", async () => {
    const executor = new WakeDeliveryExecutor();
    const scheduledTimers: Array<{ cleared: boolean; unref?: () => void }> = [];
    let attempts = 0;

    global.setTimeout = (((fn: (...args: any[]) => void, _delay?: number) => {
      const timer = {
        cleared: false,
        unref: () => timer,
      };
      scheduledTimers.push(timer);
      return timer as any;
    }) as typeof setTimeout);
    global.clearTimeout = (((timer: { cleared?: boolean }) => {
      if (timer) timer.cleared = true;
    }) as typeof clearTimeout);

    executor.executePromise(
      () => {
        attempts += 1;
        return Promise.reject(new Error("retry once"));
      },
      {
        label: "wake-retry",
        sessionId: "session-wake-dispose",
        target: "message.send",
        phase: "wake",
        routeSummary: "telegram|bot|12345",
        messageKind: "wake",
      },
    );

    await Promise.resolve();
    await Promise.resolve();

    assert.equal(attempts, 1);
    assert.ok(scheduledTimers.length > 0, "expected a non-ordered dispatch retry to be scheduled");
    assert.doesNotThrow(() => executor.dispose());
  });
});
