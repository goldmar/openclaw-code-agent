import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..");
const runnerPath = join(repoRoot, "scripts", "run-tests.mjs");
const sampleTest = join("tests", "session-route.test.ts");

function runScript(args: string[]) {
  return spawnSync(process.execPath, [runnerPath, ...args], {
    cwd: repoRoot,
    encoding: "utf-8",
  });
}

describe("run-tests script", () => {
  it("accepts direct file arguments", () => {
    const result = runScript([sampleTest]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Test files run: 1/);
    assert.match(result.stdout, /Status: PASS/);
  });

  it("ignores a leading separator before file arguments", () => {
    const result = runScript(["--", sampleTest]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Test files run: 1/);
    assert.match(result.stdout, /Status: PASS/);
  });

  it("ignores separators that appear between file arguments", () => {
    const result = runScript([sampleTest, "--", sampleTest]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Test files run: 2/);
    assert.match(result.stdout, /Status: PASS/);
  });

  it("isolates spawned tests from the caller OpenClaw session store", () => {
    const parentHome = mkdtempSync(join(tmpdir(), "openclaw-code-agent-parent-home-"));
    try {
      const result = spawnSync(process.execPath, [runnerPath, "tests/session-manager.test.ts"], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          OPENCLAW_HOME: parentHome,
          OPENCLAW_CODE_AGENT_SESSIONS_PATH: join(parentHome, "code-agent-sessions.json"),
        },
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(existsSync(join(parentHome, "code-agent-sessions.json")), false);
    } finally {
      rmSync(parentHome, { recursive: true, force: true });
    }
  });
});
