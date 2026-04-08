import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
});
