import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ChildProcess, ExecFileException } from "node:child_process";
import { WakeDeliveryExecutor, wakeDeliveryExecutorInternals } from "../src/wake-delivery-executor";
import { WakeTransport } from "../src/wake-transport";

type ExecFileCallback = (error: ExecFileException | null, stdout: string, stderr: string) => void;

/** A stand-in for the `execFile(file, args, options, callback)` form the executor uses. */
function fakeExecFile(run: (file: string, args: string[], callback: ExecFileCallback) => void): typeof wakeDeliveryExecutorInternals.execFile {
  const fake = (file: string, args: readonly string[], _options: unknown, callback: ExecFileCallback): ChildProcess => {
    run(file, [...args], callback);
    return {} as ChildProcess;
  };
  // execFile's overload set cannot be implemented by one function signature.
  return fake as unknown as typeof wakeDeliveryExecutorInternals.execFile;
}

function execError(message: string): ExecFileException {
  return Object.assign(new Error(message), { cmd: "openclaw gateway call chat.send" });
}

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
    t.mock.method(wakeDeliveryExecutorInternals, "execFile", fakeExecFile((file, args, callback) => {
      assert.equal(file, "openclaw");
      attemptedArgs.push(args);
      attempts += 1;
      const error = execError(attempts === 1 ? "Command timed out" : "gateway unavailable");
      if (attempts === 1) {
        // chat.send carries an idempotency key, so a killed attempt is safe to retry.
        error.killed = true;
        error.signal = "SIGKILL";
      }
      callback(error, "", "forced failure");
    }));

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
    t.mock.method(wakeDeliveryExecutorInternals, "execFile", fakeExecFile((file, args, callback) => {
      assert.equal(file, "openclaw");
      assert.deepEqual(args.slice(0, 3), ["gateway", "call", "chat.send"]);
      dispatchedMessages.push(chatSendMessage(args));
      if (chatSendMessage(args) === "first") {
        shouldDeliverFirst = false;
        callback(execError("stale delivery failed"), "", "stale delivery failed");
        return;
      }
      secondDispatchRuns += 1;
      callback(null, "", "");
    }));

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

  it("reports a wake the validator skipped as skipped: neither success nor failure", async (t) => {
    const executor = new WakeDeliveryExecutor();
    t.mock.property(wakeDeliveryExecutorInternals, "execFile", fakeExecFile((_file, _args, callback) => {
      queueMicrotask(() => callback(null, "{\"final\":\"NO_REPLY\"}", ""));
    }));
    const outcomes: string[] = [];
    executor.execute(chatSendArgs("skip me"), {
      label: "completion-wake",
      sessionId: "session-skip",
      target: "chat.send",
      phase: "wake",
      routeSummary: "session:agent:main:main",
      messageKind: "wake",
      successValidator: () => ({ outcome: "skipped", reason: "the orchestrator already replied" }),
      onSuccess: () => { outcomes.push("success"); },
      onSkipped: (reason) => { outcomes.push(`skipped: ${reason}`); },
      onFinalFailure: () => { outcomes.push("failure"); },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(outcomes, ["skipped: the orchestrator already replied"]);
  });

  it("distinguishes a proven pre-admission rejection from transport ambiguity", async (t) => {
    for (const failure of ["ENOENT", "originating route fields require admin scope"]) {
      const executor = new WakeDeliveryExecutor();
      t.mock.property(wakeDeliveryExecutorInternals, "execFile", fakeExecFile((_file, _args, callback) => {
        const error = execError(failure);
        if (failure === "ENOENT") error.code = "ENOENT";
        queueMicrotask(() => callback(error, "", failure));
      }));
      const outcomes: string[] = [];
      executor.execute(chatSendArgs("rejected"), {
        label: "completion-wake", sessionId: "session-rejected", target: "chat.send", phase: "wake",
        routeSummary: "session:agent:main:main", messageKind: "wake",
        onAdmissionRejected: () => { outcomes.push("rejected"); },
        onFinalFailure: () => { outcomes.push("fallback"); },
        onAmbiguousResult: () => { outcomes.push("ambiguous"); },
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(outcomes, ["rejected", "fallback"]);
      executor.dispose();
      t.mock.restoreAll();
    }
  });

  it("requests authenticated admin scope for explicit-origin wakes and validates the acknowledgement before success", async (t) => {
    const executor = new WakeDeliveryExecutor();
    const params = new WakeTransport().buildChatSendParams("agent:main:custom-peer", "Summary", false, "origin-run", {
      channel: "telegram", target: "chat", accountId: "second-bot", threadId: "topic",
    });
    t.mock.method(wakeDeliveryExecutorInternals, "execFile", fakeExecFile(() => assert.fail("explicit origins must not use the write-only CLI")));
    let invoked = false;
    t.mock.method(wakeDeliveryExecutorInternals, "callGatewayFromCli", async (...[method, opts, submitted, extra]: Parameters<typeof wakeDeliveryExecutorInternals.callGatewayFromCli>) => {
      invoked = true;
      assert.equal(method, "chat.send");
      assert.deepEqual(submitted, params);
      assert.deepEqual(opts, { json: true, timeout: "30000" });
      assert.deepEqual(extra?.scopes, ["operator.admin"]);
      assert.equal(extra?.sharedStateMode, "read-only");
      assert.equal(extra?.progress, false);
      assert.equal(extra?.signal?.aborted, false);
      return { runId: "origin-run", status: "started" };
    });
    const outcomes: string[] = [];
    executor.execute([], {
      label: "completion-wake", sessionId: "session-origin", target: "chat.send", phase: "wake",
      routeSummary: "session:agent:main:custom-peer", messageKind: "wake", gatewayRpc: { method: "chat.send", params },
      successValidator: (stdout) => {
        assert.deepEqual(JSON.parse(stdout), { runId: "origin-run", status: "started" });
        return { outcome: "ambiguous", reason: "admission alone cannot prove the summary was delivered" };
      },
      onSuccess: () => { outcomes.push("completed"); },
      onFinalFailure: () => { outcomes.push("fallback"); },
      onAmbiguousResult: () => { outcomes.push("pending"); },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(invoked, true);
    assert.deepEqual(outcomes, ["pending"]);
    executor.dispose();
  });

  it("keeps a timed-out authenticated SDK submission unknown and ignores its late result", async (t) => {
    const executor = new WakeDeliveryExecutor();
    let finish!: (result: Record<string, unknown>) => void;
    let signal: AbortSignal | undefined;
    t.mock.method(wakeDeliveryExecutorInternals, "callGatewayFromCli", async (...[_method, _opts, _params, extra]: Parameters<typeof wakeDeliveryExecutorInternals.callGatewayFromCli>) => {
      signal = extra?.signal;
      return await new Promise<Record<string, unknown>>((resolve) => { finish = resolve; });
    });
    global.setTimeout = (((callback: () => void) => {
      setImmediate(callback);
      return { unref() {} } as never;
    }) as unknown as typeof setTimeout);
    global.clearTimeout = (() => {}) as typeof clearTimeout;
    const outcomes: string[] = [];
    executor.execute([], {
      label: "completion-wake", sessionId: "session-timeout", target: "chat.send", phase: "wake",
      routeSummary: "session:custom", messageKind: "wake", gatewayRpc: { method: "chat.send", params: {} },
      onAdmissionRejected: () => { outcomes.push("not-submitted"); },
      onSuccess: () => { outcomes.push("completed"); },
      onFinalFailure: () => { outcomes.push("fallback"); },
      onAmbiguousResult: () => { outcomes.push("pending"); },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(outcomes, ["pending"]);
    assert.equal(signal?.aborted, true);
    finish({ runId: "late", status: "started" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(outcomes, ["pending"]);
    executor.dispose();
  });

  it("aborts an in-flight SDK client on disposal without proving its run was unsubmitted", async (t) => {
    const executor = new WakeDeliveryExecutor();
    let signal: AbortSignal | undefined;
    let finish!: () => void;
    t.mock.method(wakeDeliveryExecutorInternals, "callGatewayFromCli", async (...[_method, _opts, _params, extra]: Parameters<typeof wakeDeliveryExecutorInternals.callGatewayFromCli>) => {
      signal = extra?.signal;
      return await new Promise<Record<string, unknown>>((resolve) => { finish = () => resolve({ runId: "stopping", status: "started" }); });
    });
    const outcomes: string[] = [];
    executor.execute([], {
      label: "completion-wake", sessionId: "session-disposed", target: "chat.send", phase: "wake",
      routeSummary: "session:custom", messageKind: "wake", gatewayRpc: { method: "chat.send", params: {} },
      onAdmissionRejected: () => { outcomes.push("not-submitted"); },
      onSuccess: () => { outcomes.push("completed"); },
      onFinalFailure: () => { outcomes.push("fallback"); },
      onAmbiguousResult: () => { outcomes.push("pending"); },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(signal?.aborted, false);
    executor.dispose();
    assert.equal(signal?.aborted, true);
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(outcomes, [], "the pending journal remains unknown after client abort");
  });

  it("marks SDK work unsubmitted if its guard changes before the public helper is called", async (t) => {
    const executor = new WakeDeliveryExecutor();
    let current = true;
    const sdk = t.mock.method(wakeDeliveryExecutorInternals, "callGatewayFromCli", async () => assert.fail("cancelled submission must not connect"));
    const outcomes: string[] = [];
    executor.execute([], {
      label: "completion-wake", sessionId: "session-cancelled", target: "chat.send", phase: "wake",
      routeSummary: "session:custom", messageKind: "wake", gatewayRpc: { method: "chat.send", params: {} },
      shouldContinue: () => current,
      onAdmissionRejected: () => { outcomes.push("not-submitted"); },
      onAmbiguousResult: () => { outcomes.push("pending"); },
    });
    current = false;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sdk.mock.callCount(), 0);
    assert.deepEqual(outcomes, ["not-submitted", "pending"]);
    executor.dispose();
  });

  it("releases a retained candidate if the final executor preflight prevents submission", (t) => {
    let submitted = false;
    t.mock.property(wakeDeliveryExecutorInternals, "execFile", fakeExecFile(() => { submitted = true; }));
    for (const disposed of [false, true]) {
      const executor = new WakeDeliveryExecutor();
      if (disposed) executor.dispose();
      const outcomes: string[] = [];
      executor.execute(chatSendArgs("unsubmitted"), {
        label: "completion-wake", sessionId: "session-unsent", target: "chat.send", phase: "wake",
        routeSummary: "session:agent:main:main", messageKind: "wake",
        shouldContinue: () => disposed,
        onAdmissionRejected: () => { outcomes.push("rejected"); },
        onAmbiguousResult: () => { outcomes.push("pending"); },
        onFinalFailure: () => { outcomes.push("fallback"); },
      });
      assert.deepEqual(outcomes, ["rejected", "pending"]);
      executor.dispose();
    }
    assert.equal(submitted, false);
  });

  it("contains an asynchronous observation rejection without success or fallback", async (t) => {
    const executor = new WakeDeliveryExecutor();
    t.mock.property(wakeDeliveryExecutorInternals, "execFile", fakeExecFile((_file, _args, callback) => {
      queueMicrotask(() => callback(null, "ack", ""));
    }));
    const outcomes: string[] = [];
    executor.execute(chatSendArgs("observe"), {
      label: "completion-wake", sessionId: "session-observe", target: "chat.send", phase: "wake",
      routeSummary: "session:agent:main:main", messageKind: "wake",
      successValidator: async () => { throw new Error("observation disconnected"); },
      onSuccess: () => { outcomes.push("success"); },
      onFinalFailure: () => { outcomes.push("fallback"); },
      onAmbiguousResult: () => { outcomes.push("ambiguous"); },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(outcomes, ["ambiguous"]);
    executor.dispose();
  });

  it("does not report a validator skip once the dispatch no longer applies", async (t) => {
    const executor = new WakeDeliveryExecutor();
    t.mock.property(wakeDeliveryExecutorInternals, "execFile", fakeExecFile((_file, _args, callback) => {
      queueMicrotask(() => callback(null, "ok", ""));
    }));
    let current = true;
    const outcomes: string[] = [];
    executor.execute(chatSendArgs("obsolete"), {
      label: "completion-wake",
      sessionId: "session-obsolete",
      target: "chat.send",
      phase: "wake",
      routeSummary: "session:agent:main:main",
      messageKind: "wake",
      shouldContinue: () => current,
      successValidator: () => {
        current = false;
        return { outcome: "skipped", reason: "superseded" };
      },
      onSkipped: () => { outcomes.push("skipped"); },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(outcomes, []);
  });

  it("clears only the failed session's pending retries", async (t) => {
    const executor = new WakeDeliveryExecutor();
    const attempts = new Map<string, number>();
    t.mock.property(wakeDeliveryExecutorInternals, "execFile", fakeExecFile((_file, args, callback) => {
      const message = chatSendMessage(args);
      attempts.set(message, (attempts.get(message) ?? 0) + 1);
      queueMicrotask(() => callback(execError("gateway unavailable"), "", ""));
    }));
    const timers: Array<{ fn: () => void; cleared: boolean }> = [];
    global.setTimeout = (((fn: () => void) => {
      const timer = { fn, cleared: false, unref: () => timer };
      timers.push(timer);
      return timer as never;
    }) as unknown as typeof setTimeout);
    global.clearTimeout = (((timer: { cleared?: boolean }) => {
      if (timer) timer.cleared = true;
    }) as typeof clearTimeout);
    const cleared: string[] = [];
    for (const sessionId of ["session-a", "session-b"]) {
      executor.execute(chatSendArgs(sessionId), {
        label: "wake",
        sessionId,
        target: "chat.send",
        phase: "wake",
        routeSummary: "session:agent:main:main",
        messageKind: "wake",
        onFinalFailure: () => { cleared.push(`final:${sessionId}`); },
      });
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(timers.length, 2, "one retry scheduled per session");
    executor.clearRetryTimersForSession("session-a");
    assert.deepEqual(timers.map((timer) => timer.cleared), [true, false]);
    executor.clearPendingRetries();
    assert.deepEqual(timers.map((timer) => timer.cleared), [true, true]);
    assert.deepEqual(cleared, []);
  });
});
