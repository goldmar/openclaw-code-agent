import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { createLogger } from "../src/logger";
import { setPluginRuntime } from "../src/runtime-store";

afterEach(() => {
  setPluginRuntime(undefined);
});

describe("createLogger", () => {
  it("writes through runtime.logging.getChildLogger with plugin bindings", (t) => {
    const bindings: unknown[] = [];
    const records: Array<{ level: string; message: string; meta?: unknown }> = [];
    const child = (level: string) => (message: string, meta?: unknown) => { records.push({ level, message, meta }); };
    setPluginRuntime({
      logging: {
        getChildLogger(binding: unknown) {
          bindings.push(binding);
          return { debug: child("debug"), info: child("info"), warn: child("warn"), error: child("error") };
        },
      },
    });
    const consoleWarn = t.mock.method(console, "warn", () => {});

    const log = createLogger("session-store");
    log.warn("[SessionStore] save failed", new Error("disk full"));
    log.debug("[WakeDispatcher] started");

    assert.deepEqual(bindings, [{ plugin: "openclaw-code-agent", subsystem: "session-store" }]);
    assert.deepEqual(records, [
      { level: "warn", message: "[SessionStore] save failed", meta: { details: [{ name: "Error", message: "disk full" }] } },
      { level: "debug", message: "[WakeDispatcher] started", meta: undefined },
    ]);
    assert.equal(consoleWarn.mock.callCount(), 0);
  });

  it("falls back to the matching console method without a host logger", (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const debug = t.mock.method(console, "debug", () => {});

    const log = createLogger("fallback");
    log.warn("[X] warned", 1);
    log.debug("[X] debugged");

    assert.deepEqual(warn.mock.calls[0]?.arguments, ["[X] warned", 1]);
    assert.deepEqual(debug.mock.calls[0]?.arguments, ["[X] debugged"]);
  });

  it("falls back to console when the host logger throws", (t) => {
    setPluginRuntime({
      logging: {
        getChildLogger: () => ({
          info: () => { throw new Error("closed"); },
          warn: () => {},
          error: () => {},
        }),
      },
    });
    const info = t.mock.method(console, "info", () => {});

    createLogger("throws").info("[X] hello");

    assert.deepEqual(info.mock.calls[0]?.arguments, ["[X] hello"]);
  });
});
