import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { WakeDeliveryExecutor } from "../src/wake-delivery-executor";

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
