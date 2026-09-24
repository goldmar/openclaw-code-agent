import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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
  TEST_HOME_ENV,
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

function probeTestEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const probeDir = mkdtempSync(join(tmpdir(), "oca-test-env-probe-"));
  const probe = join(probeDir, "probe.ts");
  writeFileSync(probe, `import ${JSON.stringify(join(import.meta.dirname, "test-env.ts"))};\n`
    + "console.log(JSON.stringify({ home: process.env.OPENCLAW_HOME, stateDir: process.env.OPENCLAW_STATE_DIR, sessions: process.env.OPENCLAW_CODE_AGENT_SESSIONS_PATH }));\n");
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CODE_AGENT_SESSIONS_PATH", TEST_HOME_ENV, TEST_ISOLATION_ENV]) delete childEnv[name];
  const result = spawnSync(process.execPath, ["--import", "tsx", probe], {
    cwd: join(import.meta.dirname, ".."),
    encoding: "utf-8",
    env: { ...childEnv, ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
}

describe("tests/test-env.ts home selection", () => {
  it("does not reuse a state dir under the OS temp dir that the runner did not create", () => {
    const liveHome = mkdtempSync(join(tmpdir(), "oca-live-gateway-"));
    const seen = probeTestEnv({
      OPENCLAW_HOME: liveHome,
      OPENCLAW_STATE_DIR: join(liveHome, ".openclaw"),
      OPENCLAW_CODE_AGENT_SESSIONS_PATH: join(liveHome, "code-agent-sessions.json"),
    });
    assert.notEqual(seen.home, liveHome);
    assert.equal(isPathInside(canonicalizePath(liveHome), canonicalizePath(seen.stateDir ?? liveHome)), false);
    assert.equal(seen.sessions, undefined);
  });

  it("reuses the runner-created home named by the marker", () => {
    const runnerHome = mkdtempSync(join(tmpdir(), "oca-runner-home-"));
    const sessions = join(runnerHome, "code-agent-sessions.json");
    const seen = probeTestEnv({
      OPENCLAW_HOME: runnerHome,
      OPENCLAW_STATE_DIR: join(runnerHome, ".openclaw"),
      OPENCLAW_CODE_AGENT_SESSIONS_PATH: sessions,
      [TEST_HOME_ENV]: runnerHome,
    });
    assert.deepEqual(seen, { home: runnerHome, stateDir: join(runnerHome, ".openclaw"), sessions });
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
