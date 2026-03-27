import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareSessionBootstrap } from "../src/session-bootstrap";
import type { PersistedSessionInfo, SessionConfig } from "../src/types";
import { createWorktree, getBranchName } from "../src/worktree";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

describe("prepareSessionBootstrap()", () => {
  it("recovers the original repo dir for resumed worktree sessions with legacy self-referential metadata", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "session-bootstrap-"));
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");

      const worktreePath = createWorktree(repoDir, "resume-self-reference");
      const branchName = getBranchName(worktreePath);
      assert.ok(branchName, "worktree branch should exist");

      const config: SessionConfig = {
        prompt: "Resume the fix",
        workdir: worktreePath,
        resumeWorktreeFrom: "sess-1",
        multiTurn: true,
        route: {
          provider: "telegram",
          target: "12345",
          sessionKey: "agent:main:telegram:group:12345",
        },
      };

      const bootstrap = prepareSessionBootstrap(
        config,
        "resume-self-reference",
        (_ref): PersistedSessionInfo | undefined => ({
          harnessSessionId: "sess-1",
          name: "resume-self-reference",
          prompt: "Resume the fix",
          workdir: worktreePath,
          status: "running",
          costUsd: 0,
          worktreePath,
          worktreeBranch: branchName,
        }),
      );

      assert.equal(bootstrap.actualWorkdir, worktreePath);
      assert.equal(bootstrap.originalWorkdir, repoDir);
      assert.equal(bootstrap.worktreePath, worktreePath);
      assert.equal(bootstrap.worktreeBranchName, branchName);
      assert.match(bootstrap.effectiveSystemPrompt ?? "", new RegExp(`Do NOT edit files directly in ${repoDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.doesNotMatch(
        bootstrap.effectiveSystemPrompt ?? "",
        new RegExp(`Do NOT edit files directly in ${worktreePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
