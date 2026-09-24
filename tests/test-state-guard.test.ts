import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { resolveOpenClawStateDir, resolveSessionOutputDir } from "../src/state-paths";
import { resolveSessionIndexPath, saveSessionStoreIndex } from "../src/session-store-storage";
import { appendSessionOutput } from "../src/session-output";
import {
  assertTestSafeStatePath,
  canonicalizePath,
  isNodeTestRuntime,
  isPathInside,
  TEST_ISOLATION_ENV,
  testStateGuardInternals,
} from "../src/test-state-guard";

const realStateDir = join(userInfo().homedir, ".openclaw");

describe("hermetic test environment", () => {
  it("points OpenClaw state and the OS temp dir at a temporary home", () => {
    const home = process.env.OPENCLAW_HOME;
    assert.ok(home);
    assert.equal(isPathInside(canonicalizePath(home), canonicalizePath(resolveOpenClawStateDir())), true);
    assert.equal(isPathInside(canonicalizePath(home), canonicalizePath(resolveSessionIndexPath(process.env))), true);
    assert.equal(isPathInside(canonicalizePath(home), canonicalizePath(resolveSessionOutputDir())), true);
    assert.equal(isPathInside(canonicalizePath(home), canonicalizePath(tmpdir())), true);
    assert.equal(isPathInside(canonicalizePath(realStateDir), canonicalizePath(resolveOpenClawStateDir())), false);
    assert.equal(process.env[TEST_ISOLATION_ENV], "1");
  });
});

describe("test state guard", () => {
  let previousExitCode: typeof process.exitCode;
  afterEach(() => {
    process.exitCode = previousExitCode;
  });

  it("is active under node:test and inactive for a production process", () => {
    assert.equal(isNodeTestRuntime(), true);
    assert.equal(isNodeTestRuntime({}, []), false);
    assert.equal(isNodeTestRuntime({ NODE_TEST_CONTEXT: "child-v8" }, []), true);
    assert.equal(isNodeTestRuntime({ [TEST_ISOLATION_ENV]: "1" }, []), true);
    assert.equal(isNodeTestRuntime({}, ["--import", "tsx", "--test"]), true);
  });

  it("allows temporary paths", () => {
    previousExitCode = process.exitCode;
    assert.doesNotThrow(() => assertTestSafeStatePath(join(tmpdir(), "code-agent-sessions.json"), "write"));
  });

  it("refuses paths inside the real account state dir without touching them", () => {
    previousExitCode = process.exitCode;
    assert.throws(
      () => assertTestSafeStatePath(join(realStateDir, "code-agent-sessions.json"), "write the session store"),
      /Refusing to write the session store .* inside the real OpenClaw state dir/,
    );
    assert.equal(process.exitCode, 1);
  });

  it("stops the session store and output writers before they write", () => {
    previousExitCode = process.exitCode;
    // Stand in a temporary account home so a regression here cannot write real state.
    const fakeAccountHome = mkdtempSync(join(tmpdir(), "oca-guard-account-"));
    const fakeStateDir = join(fakeAccountHome, ".openclaw");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    testStateGuardInternals.setAccountHomeForTest(fakeAccountHome);
    process.env.OPENCLAW_STATE_DIR = fakeStateDir;
    try {
      const indexPath = resolveSessionIndexPath({ OPENCLAW_STATE_DIR: fakeStateDir });
      assert.throws(() => saveSessionStoreIndex(indexPath, [], []), /inside the real OpenClaw state dir/);
      assert.throws(() => appendSessionOutput([], "guard-probe", "text"), /inside the real OpenClaw state dir/);
      assert.equal(existsSync(fakeStateDir), false);
    } finally {
      testStateGuardInternals.setAccountHomeForTest(undefined);
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });
});
