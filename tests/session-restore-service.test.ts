import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { PersistedSessionInfo } from "../src/types";
import { SessionRestoreService } from "../src/session-restore-service";

const DEFAULT_ROUTE = {
  provider: "telegram",
  accountId: "bot",
  target: "12345",
  threadId: "42",
  sessionKey: "agent:main:telegram:group:12345:topic:42",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

describe("SessionRestoreService", () => {
  it("prepares and hydrates resumed worktree sessions from persisted metadata", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "session-restore-"));
    const worktreePath = join(repoDir, ".worktrees", "openclaw-worktree-resume");
    mkdirSync(worktreePath, { recursive: true });

    const persisted: PersistedSessionInfo = {
      sessionId: "session-1",
      harnessSessionId: "h-session-1",
      name: "resume-target",
      prompt: "Implement the fix",
      workdir: repoDir,
      status: "killed",
      lifecycle: "suspended",
      runtimeState: "stopped",
      costUsd: 0,
      route: DEFAULT_ROUTE,
      worktreePath,
      worktreeBranch: "agent/resume-target",
      worktreeStrategy: "ask",
      planApproval: "ask",
    };

    const service = new SessionRestoreService((ref) => ref === "h-session-1" ? persisted : undefined);
    const config = {
      prompt: "Continue where you left off.",
      workdir: repoDir,
      resumeSessionId: "h-session-1",
      worktreePrTargetRepo: "openclaw/openclaw",
    };

    const prepared = service.prepareSpawn(config, "resume-target");
    assert.equal(prepared.actualWorkdir, worktreePath);
    assert.equal(prepared.originalWorkdir, repoDir);
    assert.equal(prepared.worktreePath, worktreePath);
    assert.equal(prepared.worktreeBranchName, "agent/resume-target");
    assert.equal(config.worktreeStrategy, "ask");
    assert.equal(config.planApproval, "ask");

    const liveSession = {
      worktreePath: undefined,
      originalWorkdir: undefined,
      worktreeBranch: undefined,
      worktreeState: "none",
      worktreePrTargetRepo: undefined,
    } as any;

    service.hydrateSpawnedSession(liveSession, prepared, config);

    assert.equal(liveSession.worktreePath, worktreePath);
    assert.equal(liveSession.originalWorkdir, repoDir);
    assert.equal(liveSession.worktreeBranch, "agent/resume-target");
    assert.equal(liveSession.worktreeState, "provisioned");
    assert.equal(liveSession.worktreePrTargetRepo, "openclaw/openclaw");
  });

  it("hydrates plugin-managed worktree metadata for fresh Codex worktree strategies", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "session-restore-native-codex-"));
    git(repoDir, "init", "-b", "main");
    git(repoDir, "config", "user.name", "Test User");
    git(repoDir, "config", "user.email", "test@example.com");
    writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
    git(repoDir, "add", "README.md");
    git(repoDir, "commit", "-m", "init");
    const service = new SessionRestoreService(() => undefined);
    const config = {
      prompt: "Implement the fix",
      workdir: repoDir,
      harness: "codex",
      worktreeStrategy: "ask",
      worktreePrTargetRepo: "openclaw/openclaw",
    };

    const prepared = service.prepareSpawn(config, "codex-native");
    const liveSession = {
      worktreePath: undefined,
      originalWorkdir: undefined,
      worktreeBranch: undefined,
      worktreeState: "none",
      worktreePrTargetRepo: undefined,
    } as any;

    service.hydrateSpawnedSession(liveSession, prepared, config);

    assert.ok(prepared.worktreePath, "fresh Codex ask launch should create a managed worktree");
    assert.equal(prepared.actualWorkdir, prepared.worktreePath);
    assert.ok(prepared.worktreeBranchName, "fresh Codex ask worktree should have a branch");
    assert.equal(liveSession.originalWorkdir, repoDir);
    assert.equal(liveSession.worktreePath, prepared.worktreePath);
    assert.equal(liveSession.worktreeBranch, prepared.worktreeBranchName);
    assert.equal(liveSession.worktreeState, "provisioned");
    assert.equal(liveSession.worktreePrTargetRepo, "openclaw/openclaw");
  });
});
