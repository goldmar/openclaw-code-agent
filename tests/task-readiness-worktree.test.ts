import "./test-env";
import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionActionTokenStore } from "../src/session-action-token-store";
import { SessionInteractionService } from "../src/session-interactions";
import { SessionReminderService } from "../src/session-reminder-service";
import { SessionWorktreeController } from "../src/session-worktree-controller";
import { SessionWorktreeMessageService } from "../src/session-worktree-message-service";
import { SessionWorktreeStrategyService } from "../src/session-worktree-strategy-service";
import { createTaskOutcomeReport } from "../src/session-task-outcome";
import type { Session } from "../src/session";
import type { PersistedSessionInfo, WorktreeStrategy } from "../src/types";
import type { SessionNotificationRequest } from "../src/wake-dispatcher";
import type { WorktreeDecisionSummaryProvider } from "../src/worktree-decision-summary";
import { formatWorktreeOutcomeLine, mergeBranch } from "../src/worktree";
import { reviewedTaskFixture, reviewedTaskInput } from "./task-outcome-fixture";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture(t: TestContext, strategy: WorktreeStrategy = "ask") {
  const root = mkdtempSync(join(tmpdir(), "oca-task-readiness-"));
  const repoDir = join(root, "repo");
  const worktreePath = join(root, "task");
  mkdirSync(repoDir);
  git(repoDir, "init", "-b", "main");
  git(repoDir, "config", "user.name", "Fixture User");
  git(repoDir, "config", "user.email", "fixture@example.com");
  writeFileSync(join(repoDir, "base.txt"), "base\n");
  git(repoDir, "add", "base.txt");
  git(repoDir, "commit", "-m", "base");
  git(repoDir, "worktree", "add", "-b", "agent/task", worktreePath, "main");
  writeFileSync(join(worktreePath, "task.txt"), "task\n");
  git(worktreePath, "add", "task.txt");
  git(worktreePath, "commit", "-m", "task implementation");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The production service only reads these Session facts; lifecycle callbacks
  // are supplied explicitly below instead of starting a real harness.
  const session = {
    id: "task-readiness", name: "task-readiness", harnessSessionId: "backend-fixture",
    status: "completed", startedAt: 100, completedAt: 200, costUsd: 0, duration: 100,
    prompt: "Complete the requested task and required checks.", workdir: worktreePath,
    originalWorkdir: repoDir, worktreePath, worktreeBranch: "agent/task",
    worktreeBaseBranch: "main", worktreeParentBranch: "main", worktreeStrategy: strategy,
    worktreeState: "provisioned", lifecycle: "terminal", pendingPlanApproval: false,
  } as unknown as Session & Pick<PersistedSessionInfo, "pendingWorktreeDecisionSince" | "deferredCompletionCycle">;
  return { session, repoDir, worktreePath };
}

function strategyService(session: Session, notices: SessionNotificationRequest[], provider?: WorktreeDecisionSummaryProvider) {
  const interactions = new SessionInteractionService(new SessionActionTokenStore(() => {}, 60_000), () => true);
  const controller = new SessionWorktreeController();
  const service = new SessionWorktreeStrategyService({
    shouldRunWorktreeStrategy: () => true,
    isAlreadyMerged: () => false,
    resolveWorktreeRepoDir: () => session.originalWorkdir,
    getWorktreeCompletionState: (...args) => controller.getCompletionState(...args),
    updatePersistedSession: (_ref, patch) => { Object.assign(session, patch); return true; },
    dispatchSessionNotification: (_session, request) => { notices.push(request); },
    getOutputPreview: () => "Implementation exists; verification must be reviewed.",
    originThreadLine: () => "",
    getWorktreeDecisionButtons: (id) => interactions.getWorktreeDecisionButtons(id, session),
    getPolicyAwareWorktreeDecisionButtons: (id, _options, allowed) => interactions.getWorktreeDecisionButtons(id, session, allowed),
    makeOpenPrButton: (id) => interactions.makeActionButton(id, "worktree-create-pr", "Open PR"),
    isPrAvailable: () => true,
    resolveRepoPolicy: async () => ({ policy: "pr-allowed", source: "stored", provider: "github", prAvailable: true }),
    worktreeSummaryProvider: provider,
    worktreeMessages: new SessionWorktreeMessageService(),
    enqueueMerge: async (_repo, fn) => fn(),
    mergeBranch,
    spawnConflictResolver: async () => { throw new Error("Unexpected conflict resolver"); },
    runAutoPr: async () => { throw new Error("Unexpected automatic PR"); },
    getCurrentSessionStatus: () => session.status,
    listHookPathChanges: async () => [],
  });
  return { service, interactions };
}

function blockedReport(session: Session) {
  const input = reviewedTaskInput(session);
  input.task = "blocked";
  input.checks = [
    { name: "70 core tests", scope: "core", required: true, status: "passed", stage: "test execution", evidence: "fixture:70-passing-tests", source: "reviewed_receipt", exitCode: 0 },
    { name: "Core lint", scope: "core", required: true, status: "passed", stage: "analysis", evidence: "fixture:core-lint", source: "reviewed_receipt", exitCode: 0 },
    { name: "Telegram lint prerequisite", scope: "telegram", required: true, status: "timed_out", stage: "declaration generation", evidence: "fixture:prerequisite-timeout", source: "reviewed_receipt" },
    { name: "Telegram lint", scope: "telegram", required: true, status: "not_run", stage: "file analysis", evidence: "fixture:analysis-never-started", source: "reviewed_receipt" },
  ];
  input.blockers = ["Required Telegram lint did not run", "Independent preservation remains unresolved"];
  input.remainingWork = ["Complete lint and preservation before integration"];
  session.taskOutcome = createTaskOutcomeReport(input, { source: "orchestrator", sessionKey: "agent:fixture-reviewer" });
}

describe("worktree integration requires reviewed current task evidence", () => {
  for (const strategy of ["ask", "delegate", "manual", "auto-merge", "auto-pr", "off"] as const) {
    it(`preserves blocked committed work without ${strategy} follow-through`, async (t) => {
      const { session, repoDir, worktreePath } = fixture(t, strategy);
      blockedReport(session);
      const notices: SessionNotificationRequest[] = [];
      const { service } = strategyService(session, notices);
      const head = git(worktreePath, "rev-parse", "HEAD");
      assert.deepEqual(await service.handleWorktreeStrategy(session), { notificationSent: false, worktreeRemoved: false });
      assert.equal(notices.length, 0);
      assert.equal(git(worktreePath, "rev-parse", "HEAD"), head);
      assert.equal(git(repoDir, "rev-list", "--count", "main..agent/task"), "1");
      assert.ok(existsSync(worktreePath));
      assert.equal(session.pendingWorktreeDecisionSince, undefined);
    });
  }

  it("does not infer readiness from a legacy completed session or existing pending decision", async (t) => {
    const { session } = fixture(t);
    const notices: SessionNotificationRequest[] = [];
    session.pendingWorktreeDecisionSince = new Date(1).toISOString();
    session.worktreeState = "pending_decision";
    const { service, interactions } = strategyService(session, notices);
    assert.equal((await service.handleWorktreeStrategy(session)).notificationSent, false);
    assert.deepEqual(await interactions.getWorktreeDecisionButtons(session.id, session), []);
    assert.equal(notices.length, 0);
  });

  for (const strategy of ["ask", "delegate", "manual"] as const) {
    it(`permits verified current ${strategy} behavior without integration success markers`, async (t) => {
      const { session } = fixture(t, strategy);
      reviewedTaskFixture(session);
      const notices: SessionNotificationRequest[] = [];
      const { service, interactions } = strategyService(session, notices);
      await service.handleWorktreeStrategy(session);
      assert.equal(notices.length, strategy === "manual" ? 0 : 1);
      for (const notice of notices) assert.doesNotMatch(notice.userMessage ?? "", /✅|Completed/);
      if (strategy === "ask") {
        assert.match(notices[0]!.userMessage!, /Ready for integration/);
        const token = interactions.getActionToken(notices[0]!.buttons![0]![0]!.callbackData);
        assert.equal(token?.worktreeDecisionCycle, session.startedAt);
      }
      if (strategy === "delegate") assert.equal(notices[0]!.notifyUser, "never");
      assert.equal(session.deferredCompletionCycle, undefined);
    });
  }

  it("drops old readiness after resume, and permits fresh reviewed revalidation", async (t) => {
    const { session } = fixture(t);
    reviewedTaskFixture(session);
    session.startedAt += 1;
    const notices: SessionNotificationRequest[] = [];
    const { service } = strategyService(session, notices);
    assert.equal((await service.handleWorktreeStrategy(session)).notificationSent, false);
    reviewedTaskFixture(session);
    assert.equal((await service.handleWorktreeStrategy(session)).notificationSent, true);
  });

  it("rejects evidence when committed content changed after review", async (t) => {
    const { session, worktreePath } = fixture(t);
    reviewedTaskFixture(session);
    writeFileSync(join(worktreePath, "more.txt"), "new work\n");
    git(worktreePath, "add", "more.txt");
    git(worktreePath, "commit", "-m", "unverified follow-up");
    const notices: SessionNotificationRequest[] = [];
    const { service } = strategyService(session, notices);
    assert.equal((await service.handleWorktreeStrategy(session)).notificationSent, false);
    assert.equal(notices.length, 0);
  });

  it("does not dispatch a prepared integration notice after the session resumes", async (t) => {
    const { session } = fixture(t);
    reviewedTaskFixture(session);
    const notices: SessionNotificationRequest[] = [];
    const { service } = strategyService(session, notices);
    await service.handleWorktreeStrategy(session);
    assert.equal(notices[0]!.shouldDispatch!(), true);
    session.startedAt += 1;
    assert.equal(notices[0]!.shouldDispatch!(), false);
  });

  it("suppresses an ask decision if a resume occurs while the summary is prepared", async (t) => {
    const { session } = fixture(t);
    reviewedTaskFixture(session);
    const notices: SessionNotificationRequest[] = [];
    const { service } = strategyService(session, notices, {
      generateWorktreeDecisionSummary: async () => {
        session.startedAt += 1;
        return { lines: ["Task implementation"] };
      },
    });
    assert.equal((await service.handleWorktreeStrategy(session)).notificationSent, false);
    assert.equal(notices.length, 0);
    assert.equal(session.pendingWorktreeDecisionSince, undefined);
  });

  it("does not build integration fallback instructions for unverified work", async (t) => {
    const { session, repoDir } = fixture(t);
    const message = new SessionWorktreeMessageService().buildAskNotification({
      session, branchName: "agent/task", baseBranch: "main",
      diffSummary: { commits: 1, filesChanged: 1, insertions: 1, deletions: 0, changedFiles: ["task.txt"], commitMessages: [] },
    });
    assert.equal(message.buttons, undefined);
    assert.equal(message.wakeMessageOnNotifyFailed, undefined);
    assert.match(message.userMessage!, /completion is unverified/);
    assert.equal(git(repoDir, "rev-list", "--count", "main..agent/task"), "1");
  });

  it("retires the false three-hour reminder without removing committed work", async (t) => {
    const { session, repoDir, worktreePath } = fixture(t);
    blockedReport(session);
    const row = {
      ...session, sessionId: session.id, createdAt: session.startedAt,
      workdir: repoDir, pendingWorktreeDecisionSince: new Date(1).toISOString(),
      worktreeState: "pending_decision", lifecycle: "awaiting_worktree_decision",
    } as unknown as PersistedSessionInfo;
    const notices: SessionNotificationRequest[] = [];
    const reminders = new SessionReminderService(
      () => session,
      (_session, notice) => { notices.push(notice); },
      (_ref, patch) => { Object.assign(row, patch); return true; },
      () => { throw new Error("No integration buttons should be built"); },
    );
    assert.equal(await reminders.getNextReminderAt(row), undefined);
    assert.equal(await reminders.sendReminderIfDue(row, 4 * 60 * 60 * 1000), false);
    assert.equal(row.pendingWorktreeDecisionSince, undefined);
    assert.equal(notices.length, 0);
    assert.ok(existsSync(worktreePath));
    assert.equal(git(repoDir, "rev-list", "--count", "main..agent/task"), "1");
  });

  it("never upgrades an integration outcome to task success", () => {
    assert.match(formatWorktreeOutcomeLine({ kind: "merge", branch: "agent/task", base: "main", sessionCompleted: true }), /^ℹ️ /);
    assert.match(formatWorktreeOutcomeLine({ kind: "pr-opened", branch: "agent/task", prUrl: "https://github.com/example/repo/pull/9", sessionCompleted: true }), /^ℹ️ /);
  });
});
