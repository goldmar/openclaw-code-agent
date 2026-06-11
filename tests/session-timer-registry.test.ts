import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionTimerRegistry } from "../src/session-timer-registry";

type CapturedTimer = {
  readonly id: number;
  readonly callback: () => void;
  cleared: boolean;
  unrefCalled: boolean;
  unref: () => CapturedTimer;
};

function withMockedTimers(run: (timers: CapturedTimer[], fire: (timer: CapturedTimer) => void) => void): void {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers: CapturedTimer[] = [];
  let nextTimerId = 0;

  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) => {
    const timer: CapturedTimer = {
      id: nextTimerId++,
      callback: () => { callback(...args); },
      cleared: false,
      unrefCalled: false,
      unref() {
        timer.unrefCalled = true;
        return timer;
      },
    };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof globalThis.setTimeout>;
  }) as typeof globalThis.setTimeout;

  globalThis.clearTimeout = ((timer?: ReturnType<typeof globalThis.setTimeout>) => {
    const captured = timer as unknown as CapturedTimer | undefined;
    if (captured && timers.includes(captured)) captured.cleared = true;
  }) as typeof globalThis.clearTimeout;

  try {
    run(timers, (timer) => {
      if (!timer.cleared) timer.callback();
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

describe("SessionTimerRegistry", () => {
  it("removes one-shot timer handles after they fire", () => {
    withMockedTimers((timers, fire) => {
      const registry = new SessionTimerRegistry();
      let sizeDuringCallback = -1;

      registry.set("expire", 0, () => {
        sizeDuringCallback = registry.size;
      });

      assert.equal(registry.size, 1);
      assert.equal(timers[0]?.unrefCalled, true);

      fire(timers[0]!);

      assert.equal(sizeDuringCallback, 0);
      assert.equal(registry.size, 0);
    });
  });

  it("does not retain stale handles when a callback schedules a replacement with the same name", () => {
    withMockedTimers((timers, fire) => {
      const registry = new SessionTimerRegistry();
      let firstCallbackSize = -1;

      registry.set("replace", 0, () => {
        firstCallbackSize = registry.size;
        registry.set("replace", 10_000, () => {});
      });

      fire(timers[0]!);

      assert.equal(firstCallbackSize, 0);
      assert.equal(registry.size, 1);
      assert.equal(timers.length, 2);
      assert.equal(timers[1]?.cleared, false);

      registry.clear("replace");
      assert.equal(registry.size, 0);
      assert.equal(timers[1]?.cleared, true);
    });
  });

  it("preserves explicit clear and clearAll semantics", () => {
    withMockedTimers((timers, fire) => {
      const registry = new SessionTimerRegistry();
      let clearedCallbackCount = 0;

      registry.set("clear", 10_000, () => { clearedCallbackCount++; });
      registry.set("clear-all-a", 10_000, () => { clearedCallbackCount++; });
      registry.set("clear-all-b", 10_000, () => { clearedCallbackCount++; });

      assert.equal(registry.size, 3);

      registry.clear("clear");
      assert.equal(registry.size, 2);
      assert.equal(timers[0]?.cleared, true);

      registry.clearAll();
      assert.equal(registry.size, 0);
      assert.equal(timers[1]?.cleared, true);
      assert.equal(timers[2]?.cleared, true);

      for (const timer of timers) fire(timer);
      assert.equal(clearedCallbackCount, 0);
    });
  });
});
