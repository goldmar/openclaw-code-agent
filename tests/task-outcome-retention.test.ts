import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionMaintenanceService } from "../src/session-maintenance-service";
import { createTaskOutcomeReport } from "../src/session-task-outcome";
import type { PersistedSessionInfo } from "../src/types";
import type { Session } from "../src/session";
import { createStubSession } from "./helpers";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}
function initialize(workdir: string): void {
  git(workdir, "init", "-b", "main");
  git(workdir, "config", "user.name", "Test");
  git(workdir, "config", "user.email", "test@example.com");
}
function fixture(nested: boolean) {
  const root = mkdtempSync(join(tmpdir(), "oca-outcome-retention-"));
  const repo = join(root, "repo");
  const worktree = join(root, "worktree");
  mkdirSync(repo);
  initialize(repo);
  writeFileSync(join(repo, ".gitignore"), "nested/\n");
  git(repo, "add", ".gitignore");
  git(repo, "commit", "-qm", "initial");
  git(repo, "worktree", "add", "-b", "agent/retained", worktree, "main");
  const repositories = [{ workdir: worktree, head: git(worktree, "rev-parse", "HEAD") }];
  const nestedRepo = join(worktree, "nested");
  if (nested) {
    mkdirSync(nestedRepo);
    initialize(nestedRepo);
    writeFileSync(join(nestedRepo, "work.txt"), "independent work\n");
    git(nestedRepo, "add", "work.txt");
    git(nestedRepo, "commit", "-qm", "nested task work");
    repositories.push({ workdir: nestedRepo, head: git(nestedRepo, "rev-parse", "HEAD") });
  }
  const resolvedAt = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString();
  const row: PersistedSessionInfo = {
    sessionId: "retained-task", name: "retained-task", harnessSessionId: "retained-backend", prompt: "task",
    workdir: repo, status: "completed", createdAt: 1700000000000, costUsd: 0,
    worktreePath: worktree, worktreeBranch: "agent/retained", worktreeBaseBranch: "main",
    worktreeState: "released", worktreeLifecycle: { state: "no_change", updatedAt: resolvedAt, resolvedAt },
  };
  row.taskOutcome = createTaskOutcomeReport({ executionCycle: row.createdAt!, task: "completed",
    checks: [{ name: "tests", scope: "task", required: true, status: "passed", stage: "analysis complete",
      evidence: "reviewed passing receipt", source: "reviewed_receipt", exitCode: 0 }],
    repositories, blockers: [], remainingWork: [], summary: "Task and checks reviewed.",
  }, { source: "orchestrator" });
  const patches: Array<Partial<PersistedSessionInfo>> = [];
  const sessions = new Map<string, Session>();
  let pauseResolution: (() => Promise<void>) | undefined;
  // Reconciliation reads only this store view and session map; no runtime or scheduler is started.
  const service = new SessionMaintenanceService({
    store: { listPersistedSessions: () => [row], getPersistedSession: () => row }, sessions,
    resolveWorktreeRepoDir: async () => { await pauseResolution?.(); return repo; },
    updateSessionGeneration: (_generation: unknown, patch: Partial<PersistedSessionInfo>) => { patches.push(patch); return true; },
  } as unknown as ConstructorParameters<typeof SessionMaintenanceService>[0]);
  return { row, service, patches, worktree, nestedRepo, sessions,
    setResolutionPause: (pause: () => Promise<void>) => { pauseResolution = pause; }, cleanup: () => { service.dispose(); rmSync(root, { recursive: true, force: true }); } };
}

describe("task outcome retention safety", () => {
  for (const outcome of ["legacy", "blocked", "changed-nested-head"] as const) {
    it(`retains nested task work for ${outcome} evidence in actual maintenance reconciliation`, async () => {
      const { row, service, patches, worktree, nestedRepo, cleanup } = fixture(true);
      try {
        if (outcome === "legacy") row.taskOutcome = undefined;
        else if (outcome === "blocked") row.taskOutcome = { ...row.taskOutcome!, task: "blocked",
          blockers: ["Independent nested preservation remains unresolved"], remainingWork: ["Preserve and verify nested work"] };
        else git(nestedRepo, "commit", "--allow-empty", "-qm", "later nested work");
        assert.equal(git(worktree, "status", "--porcelain"), "", "outer checkout alone looks clean");
        await service.reconcileResolvedWorktreeRetention(row, Date.now());
        assert.equal(existsSync(worktree), true);
        assert.equal(readFileSync(join(nestedRepo, "work.txt"), "utf8"), "independent work\n");
        assert.deepEqual(patches, [], "unfinished task metadata must remain associated with its worktree");
      } finally { cleanup(); }
    });
  }

  it("keeps a checkout resumed while retention awaits repository resolution", async () => {
    const { row, service, sessions, patches, worktree, setResolutionPause, cleanup } = fixture(false);
    let resolutionStarted!: () => void;
    let releaseResolution!: () => void;
    const started = new Promise<void>((resolve) => { resolutionStarted = resolve; });
    const paused = new Promise<void>((resolve) => { releaseResolution = resolve; });
    setResolutionPause(async () => { resolutionStarted(); await paused; });
    try {
      const retention = service.reconcileResolvedWorktreeRetention(row, Date.now());
      await started;
      sessions.set(row.sessionId!, createStubSession({ id: row.sessionId, name: row.name,
        status: "running", startedAt: row.createdAt! + 1, worktreePath: worktree }) as Session);
      releaseResolution();
      await retention;
      assert.equal(existsSync(worktree), true, "a resumed owner keeps its current checkout");
      assert.deepEqual(patches, [], "old retention cannot clear the resumed checkout association");
    } finally { releaseResolution(); cleanup(); }
  });

  it("still retires an eligible resolved checkout with current verified evidence", async () => {
    const { row, service, patches, worktree, cleanup } = fixture(false);
    try {
      await service.reconcileResolvedWorktreeRetention(row, Date.now());
      assert.equal(existsSync(worktree), false);
      assert.equal(patches.at(-1)?.worktreePath, undefined);
      assert.equal(patches.at(-1)?.worktreeState, "none");
    } finally { cleanup(); }
  });
});
