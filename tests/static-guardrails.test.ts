import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dirname, "..", "scripts", "check-static-guardrails.mjs");

/** A throwaway git repository with the guardrail script and the files it always reads. */
function fixtureRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "guardrails-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  copyFileSync(script, join(dir, "scripts", "check-static-guardrails.mjs"));
  const all: Record<string, string> = {
    "src/tools/agent-pr.ts": "export {};\n",
    "src/session-notifications.ts": "export {};\n",
    ...files,
  };
  for (const [path, body] of Object.entries(all)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function runGuardrails(dir: string): string {
  const result = spawnSync(process.execPath, ["scripts/check-static-guardrails.mjs"], { cwd: dir, encoding: "utf8" });
  return `${result.stdout}${result.stderr}`;
}

describe("static privacy guardrails (N8, N4)", () => {
  it("flags real-looking home paths, Telegram user ids, Discord snowflakes, and git checkout in src", () => {
    const realHome = ["/home", "jdoe", "workspace", "repo"].join("/");
    const dir = fixtureRepo({
      "tests/a.test.ts": [
        'import "./test-env";',
        `const workdir = "${realHome}";`,
        `const fake = "/home/alice/workspace/repo";`,
        `const sender = { senderId: "${["73", "91", "04", "826"].join("")}" };`,
        `const fakeSender = { senderId: "123456789" };`,
        `const route = "telegram|${["58", "10", "93", "746"].join("")}";`,
        `const channel = "channel:${["1283", "9571", "0462", "8391", "57"].join("")}";`,
        'const fakeChannel = "channel:111111111111111111";',
      ].join("\n"),
      "tests/test-env.ts": "export {};\n",
      "src/merge.ts": 'await runGit(["-C", dir, "checkout", base]);\n',
      // Ignored files are not repository content and are never scanned.
      ".gitignore": "scratch/\n",
      "scratch/notes.md": `${realHome}\n`,
    });
    try {
      const out = runGuardrails(dir);
      assert.match(out, /tests\/a\.test\.ts:2 home path of a real-looking account/);
      assert.doesNotMatch(out, /tests\/a\.test\.ts:3 /);
      assert.match(out, /tests\/a\.test\.ts:4 Telegram user id that is not a known fake/);
      assert.doesNotMatch(out, /tests\/a\.test\.ts:5 /);
      assert.match(out, /tests\/a\.test\.ts:6 Telegram user id that is not a known fake/);
      assert.match(out, /tests\/a\.test\.ts:7 Discord snowflake-shaped id/);
      assert.doesNotMatch(out, /tests\/a\.test\.ts:8 /);
      assert.match(out, /src\/merge\.ts:1 git "checkout" subcommand/);
      assert.doesNotMatch(out, /scratch\/notes\.md/, "gitignored files are not scanned");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes a repository that uses only synthetic identifiers", () => {
    const dir = fixtureRepo({
      "tests/a.test.ts": 'import "./test-env";\nconst x = { senderId: "123456789", to: "channel:1400000000000000002", workdir: "/home/user/repo" };\n',
      "tests/test-env.ts": "export {};\n",
    });
    try {
      assert.match(runGuardrails(dir), /Static guardrail check passed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
