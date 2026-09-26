import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

import { createLogger } from "../src/logger";
import { setPluginRuntime } from "../src/runtime-store";

afterEach(() => {
  setPluginRuntime(undefined);
});

describe("production build keeps the logger's warn fallback (N9)", () => {
  it("bundles src/logger.ts with the package build's --pure flags and keeps console.warn/error", async () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { scripts: { build: string } };
    const pure = [...pkg.scripts.build.matchAll(/--pure:(\S+)/g)].map((match) => match[1]!);
    assert.ok(pure.length > 0, "the build still strips some console methods");
    const result = await build({
      entryPoints: [join(import.meta.dirname, "..", "src", "logger.ts")],
      bundle: true,
      write: false,
      minify: true,
      platform: "node",
      format: "esm",
      packages: "external",
      pure,
      logLevel: "silent",
    });
    const code = result.outputFiles[0]!.text;
    assert.match(code, /console\.warn\(/, "the pre-registration warn fallback survives the build");
    assert.match(code, /console\.error\(/);
    assert.doesNotMatch(code, /console\.debug\(/, "debug output is still stripped");
  });
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
