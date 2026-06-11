import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { KeyedDeadlineScheduler } from "../src/keyed-deadline-scheduler";

describe("KeyedDeadlineScheduler", () => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalDateNow = Date.now;

  function installFakeTimers(): Array<{ fn: () => void; delay: number; cleared: boolean; unref?: () => void }> {
    const scheduled: Array<{ fn: () => void; delay: number; cleared: boolean; unref?: () => void }> = [];

    global.setTimeout = (((fn: () => void, delay?: number) => {
      const timer = {
        fn,
        delay: delay ?? 0,
        cleared: false,
        unref: () => timer,
      };
      scheduled.push(timer);
      return timer as any;
    }) as typeof setTimeout);
    global.clearTimeout = (((timer: { cleared?: boolean }) => {
      if (timer) timer.cleared = true;
    }) as typeof clearTimeout);

    return scheduled;
  }

  function runPendingTimers(scheduled: Array<{ fn: () => void; cleared: boolean }>): void {
    for (const timer of scheduled) {
      if (!timer.cleared) timer.fn();
    }
  }

  afterEach(() => {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    Date.now = originalDateNow;
  });

  for (const [name, deadline] of [
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
  ] as const) {
    it(`clears an existing timer and does not register a new one for ${name} deadlines`, () => {
      const scheduled = installFakeTimers();
      let now = 1_000;
      let fired = 0;

      Date.now = () => now;

      const scheduler = new KeyedDeadlineScheduler();
      scheduler.schedule("deadline", now + 1_000, () => {
        fired += 1;
      });
      scheduler.schedule("deadline", deadline, () => {
        fired += 1;
      });

      assert.equal(scheduled.length, 1);
      assert.equal(scheduled[0]?.cleared, true);
      now += 1_000;
      runPendingTimers(scheduled);

      assert.equal(fired, 0);
    });
  }

  it("re-schedules long deadlines until the target time is actually reached", () => {
    const scheduled = installFakeTimers();
    let now = 1_000;
    let fired = 0;

    Date.now = () => now;

    const scheduler = new KeyedDeadlineScheduler();
    scheduler.schedule("long-deadline", now + 2_147_483_647 + 1_000, () => {
      fired += 1;
    });

    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0]?.delay, 2_147_483_647);

    now += 2_147_483_647;
    scheduled[0]!.fn();

    assert.equal(fired, 0);
    assert.equal(scheduled.length, 2);
    assert.equal(scheduled[1]?.delay, 1_000);

    now += 1_000;
    scheduled[1]!.fn();

    assert.equal(fired, 1);
  });
});
