import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "fs";
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
});
