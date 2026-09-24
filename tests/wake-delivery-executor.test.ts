import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { WakeDeliveryExecutor, wakeDeliveryExecutorInternals } from "../src/wake-delivery-executor";
import { WakeTransport } from "../src/wake-transport";

/** The only CLI dispatch production still runs: `openclaw gateway call chat.send`. */
function chatSendArgs(message: string): string[] {
  return new WakeTransport().buildChatSendArgs("agent:main:main", message, true, `idem-${message}`);
}

function chatSendMessage(args: readonly string[]): string {
  return String((JSON.parse(args[7] ?? "{}") as { message?: unknown }).message ?? "");
}

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
        label: "interactive-notify",
        sessionId: "session-timeout",
        target: "message.send",
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

  it("retries failed chat.send CLI dispatches, including killed timeouts, up to the attempt limit", async (t) => {
    const executor = new WakeDeliveryExecutor();
    const errors: string[] = [];
    let attempts = 0;
    let finalFailureCount = 0;

    global.setTimeout = (((fn: (...args: any[]) => void, _delay?: number) => {
      queueMicrotask(() => fn());
      return { fake: true, unref() { return this; } } as any;
    }) as typeof setTimeout);
    global.clearTimeout = ((() => {}) as typeof clearTimeout);
    const warnings: string[] = [];
    console.error = (message?: unknown, ...rest: unknown[]) => {
      errors.push([message, ...rest].map((value) => String(value)).join(" "));
    };
    t.mock.method(console, "warn", (message?: unknown, ...rest: unknown[]) => {
      warnings.push([message, ...rest].map((value) => String(value)).join(" "));
    });

    const attemptedArgs: string[][] = [];
    t.mock.method(wakeDeliveryExecutorInternals, "execFile", ((file, args, _options, callback) => {
      assert.equal(file, "openclaw");
      attemptedArgs.push([...(args as string[])]);
      attempts += 1;
      const error = new Error(attempts === 1 ? "Command timed out" : "gateway unavailable") as Error & { killed?: boolean; signal?: NodeJS.Signals };
      if (attempts === 1) {
        // chat.send carries an idempotency key, so a killed attempt is safe to retry.
        error.killed = true;
        error.signal = "SIGKILL";
      }
      callback?.(error, "", "forced failure");
      return {} as any;
    }) as typeof wakeDeliveryExecutorInternals.execFile);

    executor.execute(
      chatSendArgs("launch wake"),
      {
        label: "launch-notify",
        sessionId: "session-direct-failure",
        target: "chat.send",
        phase: "wake",
        routeSummary: "session:agent:main:main",
        messageKind: "wake",
        onFinalFailure: () => {
          finalFailureCount += 1;
        },
      },
    );

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(attempts, 4);
    // Every retry re-sends the identical argv, so the chat.send idempotency key is stable.
    assert.ok(attemptedArgs.every((args) => JSON.stringify(args) === JSON.stringify(chatSendArgs("launch wake"))));
    assert.equal(finalFailureCount, 1);
    // Scheduled retries are transient (warn); only the terminal failure is an error.
    assert.ok(warnings.some((line) => line.includes("\"event\":\"dispatch_retry_scheduled\"")));
    assert.ok(!errors.some((line) => line.includes("\"event\":\"dispatch_retry_scheduled\"")));
    assert.ok(errors.some((line) => line.includes("\"event\":\"dispatch_failed\"")));
  });

  it("reports a timed-out promise dispatch as ambiguous without retrying or failing over", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const executor = new WakeDeliveryExecutor();
    const errors: string[] = [];
    console.error = (message?: unknown, ...rest: unknown[]) => {
      errors.push([message, ...rest].map((value) => String(value)).join(" "));
    };
    let attempts = 0;
    let ambiguous = 0;
    let finalFailures = 0;

    executor.executePromise(() => {
      attempts += 1;
      return new Promise<void>(() => {});
    }, {
      label: "launch-notify",
      sessionId: "session-durable-timeout",
      target: "message.send",
      phase: "notify",
      routeSummary: "telegram|bot|123",
      messageKind: "notify",
      terminalOnFailure: true,
      onAmbiguousResult: () => { ambiguous += 1; },
      onFinalFailure: () => { finalFailures += 1; },
    });

    await Promise.resolve();
    t.mock.timers.tick(30_000);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(attempts, 1);
    assert.equal(ambiguous, 1);
    assert.equal(finalFailures, 0);
    assert.ok(errors.some((line) => line.includes("\"ambiguousResult\":true")));
    executor.dispose();
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
        target: "message.send",
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
        target: "message.send",
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

  it("does not hold an ordered chat.send lane on retry when shouldContinue becomes false after failure", async (t) => {
    const executor = new WakeDeliveryExecutor();
    const retryDelays: number[] = [];
    let shouldDeliverFirst = true;
    let secondDispatchRuns = 0;

    global.setTimeout = (((_fn: (...args: any[]) => void, delay?: number) => {
      if ((delay ?? 0) < 30_000) retryDelays.push(delay ?? 0);
      return { fake: true, unref() { return this; } } as any;
    }) as typeof setTimeout);
    global.clearTimeout = ((() => {}) as typeof clearTimeout);

    const dispatchedMessages: string[] = [];
    t.mock.method(wakeDeliveryExecutorInternals, "execFile", ((file, args, _options, callback) => {
      assert.equal(file, "openclaw");
      assert.deepEqual((args as string[]).slice(0, 3), ["gateway", "call", "chat.send"]);
      dispatchedMessages.push(chatSendMessage(args as string[]));
      if (chatSendMessage(args as string[]) === "first") {
        shouldDeliverFirst = false;
        callback?.(new Error("stale delivery failed"), "", "stale delivery failed");
        return {} as any;
      }
      secondDispatchRuns += 1;
      callback?.(null, "", "");
      return {} as any;
    }) as typeof wakeDeliveryExecutorInternals.execFile);

    executor.execute(
      chatSendArgs("first"),
      {
        label: "first",
        sessionId: "session-ordered-stale",
        target: "chat.send",
        phase: "wake",
        routeSummary: "session:agent:main:main",
        messageKind: "wake",
        orderingKey: "wake:agent:main:main",
        shouldContinue: () => shouldDeliverFirst,
      },
    );

    executor.execute(
      chatSendArgs("second"),
      {
        label: "second",
        sessionId: "session-ordered-stale",
        target: "chat.send",
        phase: "wake",
        routeSummary: "session:agent:main:main",
        messageKind: "wake",
        orderingKey: "wake:agent:main:main",
      },
    );

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(dispatchedMessages, ["first", "second"]);
    assert.equal(secondDispatchRuns, 1);
    assert.equal(retryDelays.length, 0);
  });

  it("does not hold an ordered promise lane on retry when shouldContinue becomes false after failure", async () => {
    const executor = new WakeDeliveryExecutor();
    const retryDelays: number[] = [];
    let shouldDeliverFirst = true;
    let firstDispatchRuns = 0;
    let secondDispatchRuns = 0;

    global.setTimeout = (((_fn: (...args: any[]) => void, delay?: number) => {
      if ((delay ?? 0) < 30_000) retryDelays.push(delay ?? 0);
      return { fake: true, unref() { return this; } } as any;
    }) as typeof setTimeout);
    global.clearTimeout = ((() => {}) as typeof clearTimeout);

    executor.executePromise(
      () => {
        firstDispatchRuns += 1;
        shouldDeliverFirst = false;
        return Promise.reject(new Error("stale promise delivery failed"));
      },
      {
        label: "first",
        sessionId: "session-ordered-promise-stale",
        target: "message.send",
        phase: "notify",
        routeSummary: "discord|channel:123",
        messageKind: "notify",
        orderingKey: "notify:discord|channel:123",
        shouldContinue: () => shouldDeliverFirst,
      },
    );

    executor.executePromise(
      () => {
        secondDispatchRuns += 1;
        return Promise.resolve();
      },
      {
        label: "second",
        sessionId: "session-ordered-promise-stale",
        target: "message.send",
        phase: "notify",
        routeSummary: "discord|channel:123",
        messageKind: "notify",
        orderingKey: "notify:discord|channel:123",
      },
    );

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(firstDispatchRuns, 1);
    assert.equal(secondDispatchRuns, 1);
    assert.equal(retryDelays.length, 0);
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
        target: "system.event",
        phase: "wake",
        routeSummary: "system",
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
