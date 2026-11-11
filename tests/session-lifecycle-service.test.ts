import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree } from "../src/worktree";

import { SessionLifecycleService } from "../src/session-lifecycle-service";
import { createStubSession } from "./helpers";
import { createTaskOutcomeReport, executionCycle, type TaskOutcomeInput, type TaskOutcomeSession } from "../src/session-task-outcome";
import type { SessionNotificationRequest } from "../src/wake-dispatcher";

function reviewedOutcome(session: TaskOutcomeSession, overrides: Partial<TaskOutcomeInput> = {}) {
  const workdir = session.worktreePath ?? session.workdir;
  return createTaskOutcomeReport({
    executionCycle: executionCycle(session), task: "completed",
    checks: [{ name: "required tests", scope: "task", required: true, status: "passed", stage: "analysis complete",
      evidence: "reviewed test receipt", source: "reviewed_receipt", exitCode: 0 }],
    repositories: workdir ? [{ workdir, head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: workdir, encoding: "utf8" }).trim() }] : [],
    blockers: [], remainingWork: [], summary: "Requested work and required tests passed.", ...overrides,
  }, { source: "orchestrator" });
}

describe("SessionLifecycleService", () => {
  const originalConsoleInfo = console.info;
  const scratchRepos: string[] = [];
  function newRepository() {
    const repoDir = mkdtempSync(join(tmpdir(), "oca-lifecycle-outcome-"));
    scratchRepos.push(repoDir);
    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "--allow-empty", "-m", "init"], { cwd: repoDir, stdio: "ignore" });
    return repoDir;
  }

  afterEach(() => {
    console.info = originalConsoleInfo;
    for (const repoDir of scratchRepos.splice(0)) rmSync(repoDir, { recursive: true, force: true });
  });

  function terminalRecorder(overrides: Partial<ConstructorParameters<typeof SessionLifecycleService>[0]> = {}) {
    const requests: SessionNotificationRequest[] = [];
    let strategyCalls = 0;
    const resumeButtons = [[{ label: "Resume", callbackData: "resume-current" }, { label: "View output", callbackData: "output-current" }]];
    const service = new SessionLifecycleService({
      persistSession: () => {}, clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => { strategyCalls += 1; return { notificationSent: false, worktreeRemoved: false }; },
      resolveWorktreeRepoDir: () => undefined, updatePersistedSession: () => true,
      dispatchSessionNotification: (_session, request) => { requests.push(request); },
      notifySession: () => {}, clearRetryTimersForSession: () => {}, shouldEmitTerminalWake: () => true,
      resolvePlanApprovalMode: () => "ask", getPlanApprovalButtons: () => [],
      getResumeButtons: () => resumeButtons, getQuestionButtons: () => undefined,
      extractLastOutputLine: () => undefined, getOutputPreview: () => "Harness turn ended successfully; all work is ready.",
      originThreadLine: () => "", debounceWaitingEvent: () => true, isAlreadyMerged: () => false,
      ...overrides,
    });
    return { service, requests, resumeButtons, strategyCalls: () => strategyCalls };
  }

  for (const strategy of ["ask", "delegate", "manual", "auto-merge", "auto-pr", "off"] as const) {
    it(`retains incomplete committed work under ${strategy} without integration prompts`, async () => {
      const repoDir = newRepository();
      const session = createStubSession({ id: `unfinished-${strategy}`, name: `unfinished-${strategy}`, status: "completed",
        startedAt: 1700000000000, workdir: repoDir, worktreePath: repoDir, originalWorkdir: repoDir, worktreeStrategy: strategy });
      session.taskOutcome = reviewedOutcome(session, { task: "blocked",
        checks: [{ name: "required lint", scope: "channel", required: true, status: "timed_out", stage: "startup before analysis",
          evidence: "reviewed timeout receipt", source: "reviewed_receipt" }],
        blockers: ["Required lint did not analyze files"], remainingWork: ["Preserve nested work and complete lint"] });
      const recorder = terminalRecorder();
      await recorder.service.handleSessionTerminal(session);
      assert.equal(recorder.strategyCalls(), 0);
      assert.equal(existsSync(join(repoDir, ".git")), true, "committed task content stays available");
      assert.equal(recorder.requests.length, 1);
      const request = recorder.requests[0];
      assert.equal(request.label, "task-unverified");
      assert.match(request.userMessage ?? "", /task blocked; verification blocked/);
      assert.match(request.userMessage ?? "", /Required lint did not analyze files/);
      assert.match(request.userMessage ?? "", /Preserve nested work and complete lint/);
      assert.doesNotMatch(request.userMessage ?? "", /✅|Finished on/);
      assert.deepEqual(request.buttons, recorder.resumeButtons);
      assert.match(request.wakeMessageOnNotifySuccess ?? "", /Do not offer merge, PR, later or discard/);
    });
  }

  it("downgrades a previously verified report when its real checkout HEAD changed", async () => {
    const repoDir = newRepository();
    const session = createStubSession({ id: "head-changed", name: "head-changed", status: "completed",
      startedAt: 1700000000000, workdir: repoDir, worktreePath: repoDir, originalWorkdir: repoDir, worktreeStrategy: "ask" });
    session.taskOutcome = reviewedOutcome(session);
    execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "--allow-empty", "-m", "later work"], { cwd: repoDir, stdio: "ignore" });
    const recorder = terminalRecorder();
    await recorder.service.handleSessionTerminal(session);
    assert.equal(recorder.strategyCalls(), 0);
    assert.equal(recorder.requests[0]?.label, "task-unverified");
    assert.match(recorder.requests[0]?.userMessage ?? "", /task completion unverified/);
    assert.doesNotMatch(recorder.requests[0]?.userMessage ?? "", /✅/);
    assert.deepEqual(recorder.requests[0]?.buttons, recorder.resumeButtons);
  });

  it("does not deliver an old terminal cycle after its session was replaced on resume", async () => {
    const session = createStubSession({ id: "old-cycle", status: "completed", startedAt: 1700000000000 });
    const recorder = terminalRecorder({ isCurrentSessionCycle: () => false });
    await recorder.service.handleSessionTerminal(session);
    assert.equal(recorder.strategyCalls(), 0);
    assert.deepEqual(recorder.requests, []);
  });

  it("carries a reviewed success summary without a redundant review wake", () => {
    const session = createStubSession({ id: "reviewed-success", name: "reviewed-success", status: "completed", startedAt: 1700000000000 });
    session.taskOutcome = createTaskOutcomeReport({ executionCycle: executionCycle(session), task: "completed",
      checks: [{ name: "acceptance", scope: "research task", required: true, status: "not_applicable", stage: "review",
        evidence: "Reviewed research acceptance; no executable checks apply", source: "reviewed_receipt" }],
      repositories: [], blockers: [], remainingWork: [], summary: "Requested research was reviewed." }, { source: "orchestrator" });
    const recorder = terminalRecorder();
    recorder.service.emitCompleted(session, { summary: session.taskOutcome.summary });
    const request = recorder.requests[0];
    assert.equal(request.label, "completed");
    assert.match(request.userMessage ?? "", /^✅ \[reviewed-success\] Completed/);
    assert.match(request.userMessage ?? "", /Requested research was reviewed/);
    assert.equal(request.completionWakeSummaryRequired, false);
    assert.equal(request.wakeMessageOnNotifySuccess, undefined);
    assert.equal(request.wakeMessageOnNotifyFailed, undefined);
    assert.equal(request.buttons, undefined);
  });

  it("skips worktree terminal handling for goal-owned sessions", async () => {
    const clearedRetryTimers: string[] = [];
    let worktreeCalls = 0;

    const service = new SessionLifecycleService({
      persistSession: () => {},
      clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => {
        worktreeCalls += 1;
        return {
          notificationSent: false,
          worktreeRemoved: false,
        };
      },
      resolveWorktreeRepoDir: () => undefined,
      updatePersistedSession: () => false,
      dispatchSessionNotification: () => {},
      notifySession: () => {},
      clearRetryTimersForSession: (sessionId: string) => {
        clearedRetryTimers.push(sessionId);
      },
      shouldEmitTerminalWake: () => true,
      resolvePlanApprovalMode: () => "ask",
      getPlanApprovalButtons: () => [],
      getResumeButtons: () => [],
      getQuestionButtons: () => undefined,
      extractLastOutputLine: () => undefined,
      getOutputPreview: () => "Codex reached the policy selection step after reading the plugin configuration.",
      originThreadLine: () => "",
      debounceWaitingEvent: () => true,
      isAlreadyMerged: () => false,
    });

    const session = createStubSession({
      id: "session-1",
      name: "goal-task",
      status: "completed",
      goalTaskId: "goal-1",
      worktreePath: "/tmp/worktree",
      originalWorkdir: "/tmp/repo",
    });

    await service.handleSessionTerminal(session);

    assert.equal(worktreeCalls, 0);
    assert.deepEqual(clearedRetryTimers, ["session-1"]);
  });

  describe("early startup failure auto-clean (B1)", () => {
    function lifecycleFor(repoDir: string) {
      return new SessionLifecycleService({
        persistSession: () => {},
        clearWaitingTimestamp: () => {},
        handleWorktreeStrategy: async () => ({ notificationSent: false, worktreeRemoved: false }),
        resolveWorktreeRepoDir: () => repoDir,
        updatePersistedSession: () => true,
        dispatchSessionNotification: () => {},
        notifySession: () => {},
        clearRetryTimersForSession: () => {},
        shouldEmitTerminalWake: () => false,
        resolvePlanApprovalMode: () => "ask",
        getPlanApprovalButtons: () => [],
        getResumeButtons: () => [],
        getQuestionButtons: () => undefined,
        extractLastOutputLine: () => undefined,
        getOutputPreview: () => "",
        originThreadLine: () => "",
        debounceWaitingEvent: () => true,
        isAlreadyMerged: () => false,
      });
    }

    async function repoWithWorktree(name: string, commitOnBranch: boolean) {
      const repoDir = mkdtempSync(join(tmpdir(), "oca-early-fail-"));
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "--allow-empty", "-m", "init"], { cwd: repoDir, stdio: "ignore" });
      const worktreePath = await createWorktree(repoDir, name);
      if (commitOnBranch) {
        execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "--allow-empty", "-m", "earlier work"], { cwd: worktreePath, stdio: "ignore" });
      }
      const branchExists = () => execFileSync("git", ["branch", "--list", `agent/${name}`], { cwd: repoDir, encoding: "utf-8" }).trim() !== "";
      return { repoDir, worktreePath, branchExists };
    }

    const failedSession = (overrides: Record<string, unknown>) => createStubSession({
      status: "failed",
      costUsd: 0,
      duration: 4_000,
      worktreeStrategy: "ask",
      worktreeParentBranch: "main",
      ...overrides,
    });

    it("keeps a resumed session's worktree and branch (for example a usage-limit failure on resume)", async () => {
      const { repoDir, worktreePath, branchExists } = await repoWithWorktree("resumed-work", true);
      try {
        await lifecycleFor(repoDir).handleSessionTerminal(failedSession({
          id: "resumed", name: "resumed-work", worktreePath, worktreeBranch: "agent/resumed-work", originalWorkdir: repoDir, launchedFresh: false,
        }));
        assert.equal(existsSync(worktreePath), true);
        assert.equal(branchExists(), true, "the branch with earlier commits survives");
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it("never deletes a branch with commits of its own, even for a fresh launch", async () => {
      const { repoDir, worktreePath, branchExists } = await repoWithWorktree("fresh-with-commit", true);
      try {
        await lifecycleFor(repoDir).handleSessionTerminal(failedSession({
          id: "fresh-commit", name: "fresh-with-commit", worktreePath, worktreeBranch: "agent/fresh-with-commit", originalWorkdir: repoDir, launchedFresh: true,
        }));
        assert.equal(branchExists(), true);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it("still removes a fresh, empty worktree and branch after an early startup failure", async () => {
      const { repoDir, worktreePath, branchExists } = await repoWithWorktree("fresh-empty", false);
      try {
        await lifecycleFor(repoDir).handleSessionTerminal(failedSession({
          id: "fresh-empty", name: "fresh-empty", worktreePath, worktreeBranch: "agent/fresh-empty", originalWorkdir: repoDir, launchedFresh: true,
        }));
        assert.equal(existsSync(worktreePath), false);
        assert.equal(branchExists(), false);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });

  it("keeps a manual-strategy worktree at completion and records a current lifecycle", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "oca-manual-worktree-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "--allow-empty", "-m", "init"], { cwd: repoDir, stdio: "ignore" });
      const worktreePath = await createWorktree(repoDir, "manual-keep");
      const patches: Array<{ ref: string; patch: Record<string, any> }> = [];
      const before = Date.now();

      const service = new SessionLifecycleService({
        persistSession: () => {},
        clearWaitingTimestamp: () => {},
        handleWorktreeStrategy: async () => ({ notificationSent: false, worktreeRemoved: false }),
        resolveWorktreeRepoDir: () => repoDir,
        updatePersistedSession: (ref: string, patch: Record<string, any>) => {
          patches.push({ ref, patch });
          return true;
        },
        dispatchSessionNotification: () => {},
        notifySession: () => {},
        clearRetryTimersForSession: () => {},
        shouldEmitTerminalWake: () => false,
        resolvePlanApprovalMode: () => "ask",
        getPlanApprovalButtons: () => [],
        getResumeButtons: () => [],
        getQuestionButtons: () => undefined,
        extractLastOutputLine: () => undefined,
        getOutputPreview: () => "",
        originThreadLine: () => "",
        debounceWaitingEvent: () => true,
        isAlreadyMerged: () => false,
      });

      const session = createStubSession({
        id: "session-manual",
        name: "manual-keep",
        status: "completed",
        startedAt: 1700000000000,
        worktreeStrategy: "manual",
        worktreeState: "provisioned",
        worktreePath,
        worktreeBaseBranch: "main",
        originalWorkdir: repoDir,
      });

      session.taskOutcome = reviewedOutcome(session);
      await service.handleSessionTerminal(session);

      assert.equal(existsSync(worktreePath), true, "manual worktrees stay for the user to merge");
      const lifecycle = patches.find(({ patch }) => patch.worktreeLifecycle)?.patch.worktreeLifecycle;
      assert.equal(lifecycle?.state, "provisioned");
      assert.ok(Date.parse(lifecycle?.updatedAt) >= before, "lifecycle timestamp is current, not the epoch");
      assert.equal(patches.some(({ patch }) => "worktreePath" in patch && patch.worktreePath === undefined), false);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("holds outcome wakes right after launch and skips them once the orchestrator read the outcome", () => {
    const requests: Array<Record<string, any>> = [];
    const service = new SessionLifecycleService({
      persistSession: () => {},
      clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => ({ notificationSent: false, worktreeRemoved: false }),
      resolveWorktreeRepoDir: () => undefined,
      updatePersistedSession: () => false,
      dispatchSessionNotification: (_session, request) => { requests.push(request as any); },
      notifySession: () => {},
      clearRetryTimersForSession: () => {},
      shouldEmitTerminalWake: () => true,
      resolvePlanApprovalMode: () => "ask",
      getPlanApprovalButtons: () => [],
      getResumeButtons: () => [],
      getQuestionButtons: () => undefined,
      extractLastOutputLine: () => undefined,
      getOutputPreview: () => "",
      originThreadLine: () => "",
      debounceWaitingEvent: () => true,
      isAlreadyMerged: () => false,
    });

    const early = createStubSession({ id: "early", name: "ux-fail", status: "failed", startedAt: Date.now() - 2_000 }) as any;
    service.emitFailed(early, "model_not_found", false);
    const earlyRequest = requests.at(-1)!;
    assert.equal(earlyRequest.label, "failed");
    assert.equal(earlyRequest.deferWakeMs, 15_000);
    assert.equal(earlyRequest.skipDeferredWake(), undefined);
    assert.equal(typeof early.outcomeWakeSentAt, "number", "a wake that goes out is recorded");
    early.outcomeSeenAt = Date.now();
    assert.equal(earlyRequest.skipDeferredWake(), "the launching orchestrator turn already read the failure");

    const quick = createStubSession({ id: "quick", name: "ux-route", status: "completed", startedAt: Date.now() - 7_000 }) as any;
    service.emitCompleted(quick);
    const quickRequest = requests.at(-1)!;
    assert.equal(quickRequest.label, "task-unverified");
    assert.doesNotMatch(quickRequest.userMessage, /✅/);
    assert.match(quickRequest.wakeMessageOnNotifySuccess, /agent_report_outcome/);
    assert.equal(quickRequest.deferConditionalWakeMs, 15_000);
    assert.equal(quickRequest.skipDeferredWake(), undefined);
    quick.outcomeSeenAt = Date.now();
    assert.equal(quickRequest.skipDeferredWake(), "the launching orchestrator turn already read the result");

    const late = createStubSession({ id: "late", name: "long-run", status: "failed", startedAt: Date.now() - 10 * 60_000 }) as any;
    service.emitFailed(late, "rate limit", false);
    assert.equal(requests.at(-1)!.deferWakeMs, undefined);
    assert.equal(requests.at(-1)!.skipDeferredWake, undefined);
  });

  it("emits unverified execution review wakes with direct-delivery and summary diagnostics", () => {
    const requests: Array<Record<string, unknown>> = [];
    const infoLogs: string[] = [];
    console.info = (message?: unknown, ...rest: unknown[]) => {
      infoLogs.push([message, ...rest].map((value) => String(value)).join(" "));
    };

    const service = new SessionLifecycleService({
      persistSession: () => {},
      clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => ({
        notificationSent: false,
        worktreeRemoved: false,
      }),
      resolveWorktreeRepoDir: () => undefined,
      updatePersistedSession: () => false,
      dispatchSessionNotification: (_session, request) => {
        requests.push(request as unknown as Record<string, unknown>);
        request.hooks?.onNotifySucceeded?.();
        request.hooks?.onWakeSucceeded?.();
      },
      notifySession: () => {},
      clearRetryTimersForSession: () => {},
      shouldEmitTerminalWake: () => true,
      resolvePlanApprovalMode: () => "ask",
      getPlanApprovalButtons: () => [],
      getResumeButtons: () => [],
      getQuestionButtons: () => undefined,
      extractLastOutputLine: () => undefined,
      getOutputPreview: () => "Final output",
      originThreadLine: () => "Origin thread: telegram topic 42",
      debounceWaitingEvent: () => true,
      isAlreadyMerged: () => false,
    });

    service.emitCompleted(createStubSession({
      id: "session-complete",
      name: "complete-session",
      status: "completed",
      duration: 15_000,
      costUsd: 0.25,
      requestedPermissionMode: "plan",
      currentPermissionMode: "bypassPermissions",
      approvalExecutionState: "approved_then_implemented",
    }));

    assert.equal(requests.length, 1);
    const request = requests[0] as {
      wakeMessage?: string;
      wakeMessageOnNotifySuccess?: string;
      wakeMessageOnNotifyFailed?: string;
      requireDirectUserNotification?: boolean;
    };
    assert.equal(request.wakeMessage, undefined);
    assert.equal(request.requireDirectUserNotification, true);
    assert.match(request.wakeMessageOnNotifySuccess ?? "", /Tell the user in one or two sentences what was done/);
    assert.match(request.wakeMessageOnNotifySuccess ?? "", /The user saw: ⚠️ \[complete-session\] Execution ended — task completion unverified/);
    assert.doesNotMatch(request.wakeMessageOnNotifySuccess ?? "", /already summarized by completed session/);
    assert.match(request.wakeMessageOnNotifyFailed ?? "", /did NOT reach the user/);
    assert.ok(infoLogs.some((line) => line.includes("\"event\":\"completion_notify_succeeded\"") && line.includes("\"requestedShortFactualSummary\":true")));
    assert.ok(infoLogs.some((line) => line.includes("\"event\":\"completion_wake_succeeded\"") && line.includes("\"canonicalStatusDelivered\":true")));
  });

  it("does not emit a second completion follow-up after a worktree outcome notification", async () => {
    const requests: Array<Record<string, unknown>> = [];
    // As in SessionManager: one terminal notice per terminal cycle.
    const seenCycles = new Set<string>();
    let strategyNotifies = true;
    const repoDir = newRepository();

    const service = new SessionLifecycleService({
      persistSession: () => {},
      clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => {
        // A later pass over the same cycle finds the worktree resolved and sends nothing.
        if (!strategyNotifies) return { notificationSent: false, worktreeRemoved: false };
        requests.push({
          label: "worktree-merge-success",
          userMessage: "ℹ️ [worktree-summary] Merged: agent/example → main (4 files, +531/-0)",
          completionWakeSummaryRequired: true,
          wakeMessageOnNotifySuccess: "Worktree follow-through outcome recorded.",
        });
        return {
          notificationSent: true,
          worktreeRemoved: true,
        };
      },
      resolveWorktreeRepoDir: () => undefined,
      updatePersistedSession: () => false,
      dispatchSessionNotification: (_session, request) => {
        requests.push(request as unknown as Record<string, unknown>);
      },
      notifySession: () => {},
      clearRetryTimersForSession: () => {},
      shouldEmitTerminalWake: (session) => {
        const cycle = `${session.id}|${session.status}`;
        if (seenCycles.has(cycle)) return false;
        seenCycles.add(cycle);
        return true;
      },
      resolvePlanApprovalMode: () => "ask",
      getPlanApprovalButtons: () => [],
      getResumeButtons: () => [],
      getQuestionButtons: () => undefined,
      extractLastOutputLine: () => undefined,
      getOutputPreview: () => "Implementation summary already in agent output.",
      originThreadLine: () => "Origin thread: telegram topic 42",
      debounceWaitingEvent: () => true,
      isAlreadyMerged: () => false,
    });

    const session = createStubSession({
      id: "session-worktree-merge",
      name: "worktree-summary",
      status: "completed",
      startedAt: 1700000000000,
      duration: 12_000,
      worktreePath: repoDir,
      originalWorkdir: repoDir,
      worktreeStrategy: "auto-merge",
    });
    session.taskOutcome = reviewedOutcome(session);
    await service.handleSessionTerminal(session);

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.label, "worktree-merge-success");
    assert.equal(requests[0]?.completionWakeSummaryRequired, true);

    // The same terminal cycle handled again (worktree now resolved): the
    // worktree notice owned it, so no generic ✅ Completed follows.
    strategyNotifies = false;
    await service.handleSessionTerminal(session);
    assert.deepEqual(requests.map((request) => request.label), ["worktree-merge-success"]);
  });

  it("reports a user stop once: not again after the Reject button already said so", async () => {
    const notices: string[] = [];
    const service = new SessionLifecycleService({
      persistSession: () => {},
      clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => ({ notificationSent: false, worktreeRemoved: false }),
      resolveWorktreeRepoDir: () => undefined,
      updatePersistedSession: () => false,
      dispatchSessionNotification: () => {},
      notifySession: (_session, text) => { notices.push(text); },
      clearRetryTimersForSession: () => {},
      shouldEmitTerminalWake: () => true,
      resolvePlanApprovalMode: () => "ask",
      getPlanApprovalButtons: () => [],
      getResumeButtons: () => [],
      getQuestionButtons: () => undefined,
      extractLastOutputLine: () => undefined,
      getOutputPreview: () => "",
      originThreadLine: () => "",
      debounceWaitingEvent: () => true,
      isAlreadyMerged: () => false,
    });
    const stopped = { status: "killed", killReason: "user", duration: 5_000, costUsd: 0.1 } as const;

    await service.handleSessionTerminal(createStubSession({ id: "stop-1", name: "stopped-by-user", ...stopped }));
    assert.equal(notices.length, 1);
    assert.match(notices[0] ?? "", /^⛔ \[stopped-by-user\] Stopped by user \| \$0\.10 \| 5s/);

    await service.handleSessionTerminal(createStubSession({ id: "stop-2", name: "plan-rejected", ...stopped, stopNoticeReplaced: true }));
    assert.equal(notices.length, 1, "the Reject button's reply was the stop message");
  });

  it("keeps completion follow-up summaries for degraded routes that still recover to a direct user route", () => {
    const requests: Array<Record<string, unknown>> = [];

    const service = new SessionLifecycleService({
      persistSession: () => {},
      clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => ({
        notificationSent: false,
        worktreeRemoved: false,
      }),
      resolveWorktreeRepoDir: () => undefined,
      updatePersistedSession: () => false,
      dispatchSessionNotification: (_session, request) => {
        requests.push(request as unknown as Record<string, unknown>);
      },
      notifySession: () => {},
      clearRetryTimersForSession: () => {},
      shouldEmitTerminalWake: () => true,
      resolvePlanApprovalMode: () => "ask",
      getPlanApprovalButtons: () => [],
      getResumeButtons: () => [],
      getQuestionButtons: () => undefined,
      extractLastOutputLine: () => undefined,
      getOutputPreview: () => "Final output",
      originThreadLine: () => "Origin thread: telegram topic 42",
      debounceWaitingEvent: () => true,
      isAlreadyMerged: () => false,
    });

    service.emitCompleted(createStubSession({
      id: "session-recoverable-route",
      name: "recoverable-route",
      status: "completed",
      duration: 8_000,
      route: {
        provider: "system",
        target: "system",
        sessionKey: "agent:main:telegram:group:-1001234567890:topic:11239",
      },
      originChannel: "telegram",
      originSessionKey: "agent:main:telegram:group:-1001234567890:topic:11239",
    }));

    assert.equal(requests.length, 1);
    const request = requests[0] as {
      completionWakeSummaryRequired?: boolean;
      wakeMessageOnNotifySuccess?: string;
      wakeMessageOnNotifyFailed?: string;
    };
    assert.equal(request.completionWakeSummaryRequired, true);
    assert.match(request.wakeMessageOnNotifySuccess ?? "", /Tell the user in one or two sentences what was done/);
    assert.doesNotMatch(request.wakeMessageOnNotifySuccess ?? "", /already summarized by completed session/);
    assert.match(request.wakeMessageOnNotifyFailed ?? "", /did NOT reach the user/);
  });

  it("does not re-enter ask-mode prompt delivery once the current plan prompt is already proven", () => {
    const requests: Array<Record<string, unknown>> = [];
    const persistedUpdates: Array<Record<string, unknown>> = [];

    const service = new SessionLifecycleService({
      persistSession: () => {},
      clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => ({
        notificationSent: false,
        worktreeRemoved: false,
      }),
      resolveWorktreeRepoDir: () => undefined,
      updatePersistedSession: (_sessionId, patch) => {
        persistedUpdates.push(patch as Record<string, unknown>);
        return true;
      },
      dispatchSessionNotification: (_session, request) => {
        requests.push(request as unknown as Record<string, unknown>);
      },
      notifySession: () => {},
      clearRetryTimersForSession: () => {},
      shouldEmitTerminalWake: () => true,
      resolvePlanApprovalMode: () => "ask",
      getPlanApprovalButtons: () => [[{ label: "Approve", callbackData: "approve-token" }]],
      getResumeButtons: () => [],
      getQuestionButtons: () => undefined,
      extractLastOutputLine: () => undefined,
      getOutputPreview: () => "Plan preview",
      originThreadLine: () => "Origin thread: telegram topic 42",
      debounceWaitingEvent: () => true,
      isAlreadyMerged: () => false,
    });

    service.emitWaitingForInput(createStubSession({
      id: "session-proven-prompt",
      name: "proven-prompt",
      pendingPlanApproval: true,
      planDecisionVersion: 5,
      actionablePlanDecisionVersion: 5,
      approvalPromptRequiredVersion: 5,
      approvalPromptStatus: "delivered",
      latestPlanArtifactVersion: 5,
      latestPlanArtifact: {
        markdown: "1. Keep using the existing prompt",
        steps: [],
      },
    }));

    assert.equal(requests.length, 1);
    const request = requests[0] as {
      notifyUser?: string;
      wakeMessage?: string;
      wakeMessageOnNotifySuccess?: string;
      onUserNotifyFailed?: () => void;
      hooks?: Record<string, unknown>;
      userMessage?: string;
      userMessages?: unknown[];
    };
    assert.equal(request.notifyUser, "never");
    assert.match(request.wakeMessage ?? "", /It is with the user \(planApproval: ask\)/);
    // The user already has the prompt: only next-turn context for the orchestrator (N37).
    assert.equal((request as { wakeDelivery?: string }).wakeDelivery, "next-turn");
    assert.equal(request.wakeMessageOnNotifySuccess, undefined);
    assert.equal(request.onUserNotifyFailed, undefined);
    assert.equal(request.userMessage, undefined);
    assert.equal(request.userMessages, undefined);
    assert.equal(request.hooks, undefined);
    assert.deepEqual(persistedUpdates, []);
  });

  it("adds a plan-decision delivery guard that closes when the pending plan is rejected", () => {
    const requests: Array<Record<string, unknown>> = [];
    const service = new SessionLifecycleService({
      persistSession: () => {},
      clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => ({
        notificationSent: false,
        worktreeRemoved: false,
      }),
      resolveWorktreeRepoDir: () => undefined,
      updatePersistedSession: () => false,
      dispatchSessionNotification: (_session, request) => {
        requests.push(request as unknown as Record<string, unknown>);
      },
      notifySession: () => {},
      clearRetryTimersForSession: () => {},
      shouldEmitTerminalWake: () => true,
      resolvePlanApprovalMode: () => "ask",
      getPlanApprovalButtons: () => [[{ label: "Reject", callbackData: "reject-token" }]],
      getResumeButtons: () => [],
      getQuestionButtons: () => undefined,
      extractLastOutputLine: () => undefined,
      getOutputPreview: () => "Plan v2 preview",
      originThreadLine: () => "Origin thread: telegram topic 42",
      debounceWaitingEvent: () => true,
      isAlreadyMerged: () => false,
    });
    const session = createStubSession({
      id: "session-plan-v2",
      name: "plan-v2",
      lifecycle: "awaiting_plan_decision",
      pendingPlanApproval: true,
      approvalState: "pending",
      planDecisionVersion: 2,
      actionablePlanDecisionVersion: 2,
      latestPlanArtifactVersion: 2,
      latestPlanArtifact: {
        markdown: "1. Revised Plan v2 step",
        steps: [],
      },
    });

    service.emitWaitingForInput(session);

    assert.equal(requests.length, 1);
    const request = requests[0] as { shouldDispatch?: () => boolean };
    assert.equal(request.shouldDispatch?.(), true);

    session.pendingPlanApproval = false;
    session.approvalState = "rejected";
    session.lifecycle = "terminal";
    session.planDecisionVersion = 3;
    session.actionablePlanDecisionVersion = undefined;

    assert.equal(request.shouldDispatch?.(), false);
  });

  it("adds a pending-input question delivery guard that closes when the request is cleared", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const service = new SessionLifecycleService({
      persistSession: () => {},
      clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => ({
        notificationSent: false,
        worktreeRemoved: false,
      }),
      resolveWorktreeRepoDir: () => undefined,
      updatePersistedSession: () => false,
      dispatchSessionNotification: (_session, request) => {
        requests.push(request as unknown as Record<string, unknown>);
      },
      notifySession: () => {},
      clearRetryTimersForSession: () => {},
      shouldEmitTerminalWake: () => true,
      resolvePlanApprovalMode: () => "ask",
      getPlanApprovalButtons: () => [],
      getResumeButtons: () => [],
      getQuestionButtons: (_sessionId, options) => [
        options.map((option) => ({ label: option.label, callbackData: `token:${option.label}` })),
      ],
      extractLastOutputLine: () => undefined,
      getOutputPreview: () => "Codex needs one answer before it can continue.",
      originThreadLine: () => "Origin thread: telegram topic 42",
      debounceWaitingEvent: () => true,
      isAlreadyMerged: () => false,
    });
    const session = createStubSession({
      id: "session-question-guard",
      name: "question-guard",
      pendingPlanApproval: false,
      pendingInputState: {
        requestId: "req-question-guard",
        kind: "question",
        promptText: "Which environment should I target?",
        options: ["Staging", "Production"],
      },
    });

    await service.emitWaitingForInput(session);

    assert.equal(requests.length, 1);
    const request = requests[0] as { shouldDispatch?: () => boolean };
    assert.equal(request.shouldDispatch?.(), true);

    session.pendingInputState = undefined;

    assert.equal(request.shouldDispatch?.(), false);
  });

  it("blocks stale structured question notifications when the active question changes before dispatch", async () => {
    const requests: Array<Record<string, unknown>> = [];
    let summaryStarted!: () => void;
    let releaseSummary!: (value: { summary: string }) => void;
    const summaryStartedPromise = new Promise<void>((resolve) => {
      summaryStarted = resolve;
    });
    const summaryPromise = new Promise<{ summary: string }>((resolve) => {
      releaseSummary = resolve;
    });
    const service = new SessionLifecycleService({
      persistSession: () => {},
      clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => ({
        notificationSent: false,
        worktreeRemoved: false,
      }),
      resolveWorktreeRepoDir: () => undefined,
      updatePersistedSession: () => false,
      dispatchSessionNotification: (_session, request) => {
        requests.push(request as unknown as Record<string, unknown>);
      },
      notifySession: () => {},
      clearRetryTimersForSession: () => {},
      shouldEmitTerminalWake: () => true,
      resolvePlanApprovalMode: () => "ask",
      getPlanApprovalButtons: () => [],
      getResumeButtons: () => [],
      getQuestionButtons: (_sessionId, options) => [
        options.map((option) => ({ label: option.label, callbackData: `token:${option.label}` })),
      ],
      extractLastOutputLine: () => undefined,
      getOutputPreview: () => "Codex is collecting deployment inputs.",
      originThreadLine: () => "Origin thread: telegram topic 42",
      debounceWaitingEvent: () => true,
      isAlreadyMerged: () => false,
      questionContextSummaryProvider: {
        async generateQuestionContextSummary() {
          summaryStarted();
          return summaryPromise;
        },
      },
    });
    const session = createStubSession({
      id: "session-stale-structured-question",
      name: "stale-structured-question",
      pendingPlanApproval: false,
      pendingInputState: {
        requestId: "req-stale-structured-question",
        kind: "question",
        promptText: "Answer the deployment questions.",
        options: [],
        activeQuestionIndex: 0,
        questions: [
          {
            id: "environment",
            question: "Which environment should I target?",
            options: [
              { label: "Staging" },
              { label: "Production" },
            ],
          },
          {
            id: "scope",
            question: "How broad should the rollout be?",
            options: [
              { label: "Canary" },
              { label: "Everyone" },
            ],
          },
        ],
      },
    });

    const emitPromise = service.emitWaitingForInput(session);
    await summaryStartedPromise;

    session.pendingInputState = {
      ...session.pendingInputState,
      activeQuestionIndex: 1,
    };
    releaseSummary({ summary: "Codex needs the target environment before it can continue." });
    await emitPromise;

    assert.equal(requests.length, 1);
    const request = requests[0] as { shouldDispatch?: () => boolean };
    assert.equal(request.shouldDispatch?.(), false);
  });

  it("reuses the question context preview when promptText is unavailable", () => {
    const requests: Array<Record<string, unknown>> = [];
    let previewCalls = 0;

    const service = new SessionLifecycleService({
      persistSession: () => {},
      clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => ({
        notificationSent: false,
        worktreeRemoved: false,
      }),
      resolveWorktreeRepoDir: () => undefined,
      updatePersistedSession: () => false,
      dispatchSessionNotification: (_session, request) => {
        requests.push(request as unknown as Record<string, unknown>);
      },
      notifySession: () => {},
      clearRetryTimersForSession: () => {},
      shouldEmitTerminalWake: () => true,
      resolvePlanApprovalMode: () => "ask",
      getPlanApprovalButtons: () => [],
      getResumeButtons: () => [],
      getQuestionButtons: () => undefined,
      extractLastOutputLine: () => undefined,
      getOutputPreview: () => {
        previewCalls += 1;
        return "Fallback preview";
      },
      originThreadLine: () => "Origin thread: telegram topic 42",
      debounceWaitingEvent: () => true,
      isAlreadyMerged: () => false,
    });

    service.emitWaitingForInput(createStubSession({
      id: "session-fallback-preview",
      name: "fallback-preview",
      pendingPlanApproval: false,
      pendingInputState: {
        requestId: "req-fallback-preview",
        kind: "question",
        promptText: "",
        options: [],
      },
    }));

    assert.equal(previewCalls, 1);
    assert.equal(requests.length, 1);
    assert.match(String(requests[0]?.userMessage ?? ""), /Fallback preview/);
  });

  it("renders queued multi-question pending input one step at a time with buttons", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const questionButtonCalls: Array<{
      options: Array<{ label: string }>;
      context?: { requestId?: string; questionId?: string };
    }> = [];
    const debounceCalls: Array<{ sessionId: string; identityKey?: string }> = [];

    const service = new SessionLifecycleService({
      persistSession: () => {},
      clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => ({
        notificationSent: false,
        worktreeRemoved: false,
      }),
      resolveWorktreeRepoDir: () => undefined,
      updatePersistedSession: () => false,
      dispatchSessionNotification: (_session, request) => {
        requests.push(request as unknown as Record<string, unknown>);
      },
      notifySession: () => {},
      clearRetryTimersForSession: () => {},
      shouldEmitTerminalWake: () => true,
      resolvePlanApprovalMode: () => "ask",
      getPlanApprovalButtons: () => [],
      getResumeButtons: () => [],
      getQuestionButtons: (_sessionId, options, context) => {
        questionButtonCalls.push({ options, context });
        return [options.map((option) => ({ label: option.label, callbackData: `token:${option.label}` }))];
      },
      extractLastOutputLine: () => undefined,
      getOutputPreview: () => "Fallback preview",
      originThreadLine: () => "Origin thread: telegram topic 42",
      debounceWaitingEvent: (sessionId, identityKey) => {
        debounceCalls.push({ sessionId, identityKey });
        return true;
      },
      isAlreadyMerged: () => false,
    });

    const session = createStubSession({
      id: "session-multi-question",
      name: "multi-question",
      pendingPlanApproval: false,
      pendingInputState: {
        requestId: "req-multi-question",
        kind: "question",
        promptText: [
          "Question 1 - Environment",
          "Which environment should I target?",
          "Options:",
          "  1. Staging - Use staging credentials.",
          "  2. Production - Use production credentials.",
        ].join("\n"),
        options: ["Staging", "Production"],
        activeQuestionIndex: 0,
        questions: [{
          id: "environment",
          header: "Environment",
          question: "Which environment should I target?",
          options: [
            { label: "Staging", description: "Use staging credentials." },
            { label: "Production", description: "Use production credentials." },
          ],
        }, {
          id: "scope",
          header: "Scope",
          question: "How broad should the rollout be?",
          options: [
            { label: "Canary", description: "Start with a small cohort." },
            { label: "Everyone", description: "Roll out to all users." },
          ],
        }],
      },
    });

    await service.emitWaitingForInput(session);

    assert.deepEqual(debounceCalls[0], {
      sessionId: "session-multi-question",
      identityKey: "pending-input:req-multi-question:environment",
    });
    assert.equal(questionButtonCalls.length, 1);
    assert.deepEqual(questionButtonCalls[0].options.map((option) => option.label), ["Staging", "Production"]);
    assert.deepEqual(questionButtonCalls[0].context, {
      requestId: "req-multi-question",
      questionId: "environment",
    });
    assert.equal(requests.length, 1);
    assert.deepEqual(
      (requests[0]?.buttons as Array<Array<{ label: string }>>).map((row) => row.map((button) => button.label)),
      [["Staging", "Production"]],
    );
    assert.match(String(requests[0]?.userMessage ?? ""), /Question 1 - Environment/);
    assert.match(String(requests[0]?.userMessage ?? ""), /Staging - Use staging credentials\./);
    assert.match(String(requests[0]?.userMessage ?? ""), /Production - Use production credentials\./);
    assert.doesNotMatch(String(requests[0]?.userMessage ?? ""), /Question 2 - Scope/);
    assert.doesNotMatch(String(requests[0]?.userMessage ?? ""), /Fallback preview/);
    assert.doesNotMatch(String(requests[0]?.userMessage ?? ""), /Why this is asked:/);

    session.pendingInputState = {
      ...session.pendingInputState,
      promptText: [
        "Question 2 - Scope",
        "How broad should the rollout be?",
        "Options:",
        "  1. Canary - Start with a small cohort.",
        "  2. Everyone - Roll out to all users.",
      ].join("\n"),
      options: ["Canary", "Everyone"],
      activeQuestionIndex: 1,
      answers: {
        environment: { answers: ["Production"] },
      },
    };

    await service.emitWaitingForInput(session);

    assert.deepEqual(debounceCalls[1], {
      sessionId: "session-multi-question",
      identityKey: "pending-input:req-multi-question:scope",
    });
    assert.equal(questionButtonCalls.length, 2);
    assert.deepEqual(questionButtonCalls[1].options.map((option) => option.label), ["Canary", "Everyone"]);
    assert.deepEqual(questionButtonCalls[1].context, {
      requestId: "req-multi-question",
      questionId: "scope",
    });
    assert.equal(requests.length, 2);
    assert.deepEqual(
      (requests[1]?.buttons as Array<Array<{ label: string }>>).map((row) => row.map((button) => button.label)),
      [["Canary", "Everyone"]],
    );
    assert.match(String(requests[1]?.userMessage ?? ""), /Question 2 - Scope/);
    assert.match(String(requests[1]?.userMessage ?? ""), /Canary - Start with a small cohort\./);
    assert.match(String(requests[1]?.userMessage ?? ""), /Everyone - Roll out to all users\./);
    assert.doesNotMatch(String(requests[1]?.userMessage ?? ""), /Fallback preview/);
    assert.doesNotMatch(String(requests[1]?.userMessage ?? ""), /Why this is asked:/);
  });

  it("renders fallback option buttons when a single structured question has no inline options", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const questionButtonCalls: Array<{
      options: Array<{ label: string }>;
      context?: { requestId?: string; questionId?: string };
    }> = [];

    const service = new SessionLifecycleService({
      persistSession: () => {},
      clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => ({
        notificationSent: false,
        worktreeRemoved: false,
      }),
      resolveWorktreeRepoDir: () => undefined,
      updatePersistedSession: () => false,
      dispatchSessionNotification: (_session, request) => {
        requests.push(request as unknown as Record<string, unknown>);
      },
      notifySession: () => {},
      clearRetryTimersForSession: () => {},
      shouldEmitTerminalWake: () => true,
      resolvePlanApprovalMode: () => "ask",
      getPlanApprovalButtons: () => [],
      getResumeButtons: () => [],
      getQuestionButtons: (_sessionId, options, context) => {
        questionButtonCalls.push({ options, context });
        return [options.map((option) => ({ label: option.label, callbackData: `token:${option.label}` }))];
      },
      extractLastOutputLine: () => undefined,
      getOutputPreview: () => "Fallback preview",
      originThreadLine: () => "Origin thread: telegram topic 42",
      debounceWaitingEvent: () => true,
      isAlreadyMerged: () => false,
    });

    await service.emitWaitingForInput(createStubSession({
      id: "session-structured-fallback-options",
      name: "structured-fallback-options",
      pendingPlanApproval: false,
      pendingInputState: {
        requestId: "req-structured-fallback-options",
        kind: "question",
        promptText: "Question 1 - Confirm\nYes or no?",
        options: ["Yes", "No"],
        activeQuestionIndex: 0,
        questions: [{
          id: "confirm",
          question: "Yes or no?",
          options: [],
        }],
      },
    }));

    assert.equal(questionButtonCalls.length, 1);
    assert.deepEqual(questionButtonCalls[0].options.map((option) => option.label), ["Yes", "No"]);
    assert.deepEqual(questionButtonCalls[0].context, {
      requestId: "req-structured-fallback-options",
      questionId: "confirm",
    });
    assert.equal(requests.length, 1);
    assert.deepEqual(
      (requests[0]?.buttons as Array<Array<{ label: string }>>).map((row) => row.map((button) => button.label)),
      [["Yes", "No"]],
    );
  });

  it("preserves provided option descriptions verbatim without calling the LLM", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const providedDescription = [
      "Use the plugin store as the canonical source because the shared policy is controlled by plugin configuration,",
      "is inherited by every launched agent session, and should not be overridden inside a single Codex answer.",
    ].join(" ");
    let contextSummaryCalls = 0;

    const service = new SessionLifecycleService({
      persistSession: () => {},
      clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => ({
        notificationSent: false,
        worktreeRemoved: false,
      }),
      resolveWorktreeRepoDir: () => undefined,
      updatePersistedSession: () => false,
      dispatchSessionNotification: (_session, request) => {
        requests.push(request as unknown as Record<string, unknown>);
      },
      notifySession: () => {},
      clearRetryTimersForSession: () => {},
      shouldEmitTerminalWake: () => true,
      resolvePlanApprovalMode: () => "ask",
      getPlanApprovalButtons: () => [],
      getResumeButtons: () => [],
      getQuestionButtons: (_sessionId, options) => [
        options.map((option) => ({ label: option.label, callbackData: `token:${option.label}` })),
      ],
      extractLastOutputLine: () => undefined,
      getOutputPreview: () => "Codex reached the policy selection step after reading the plugin configuration.",
      originThreadLine: () => "Origin thread: telegram topic 42",
      debounceWaitingEvent: () => true,
      isAlreadyMerged: () => false,
      questionContextSummaryProvider: {
        async generateQuestionContextSummary(evidence) {
          contextSummaryCalls += 1;
          assert.match(evidence.question, /Which policy source should I use\?/);
          return { summary: "Codex needs the policy source before it can continue." };
        },
      },
    });

    await service.emitWaitingForInput(createStubSession({
      id: "session-described-options",
      name: "described-options",
      pendingPlanApproval: false,
      pendingInputState: {
        requestId: "req-described-options",
        kind: "question",
        promptText: "Which policy source should I use?",
        options: ["Plugin store", "Local override"],
        activeQuestionIndex: 0,
        questions: [{
          id: "policy_source",
          question: "Which policy source should I use?",
          options: [
            { label: "Plugin store", description: providedDescription },
            { label: "Local override" },
          ],
        }],
      },
    }));

    assert.equal(requests.length, 1);
    assert.equal(contextSummaryCalls, 1);
    assert.match(String(requests[0]?.userMessage ?? ""), new RegExp(`Plugin store - ${providedDescription.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(String(requests[0]?.userMessage ?? ""), /Why: Codex needs the policy source before it can continue\./);
    assert.doesNotMatch(String(requests[0]?.userMessage ?? ""), /Local override -/);
    assert.deepEqual(
      (requests[0]?.buttons as Array<Array<{ label: string }>>).map((row) => row.map((button) => button.label)),
      [["Plugin store", "Local override"]],
    );
  });

  it("omits oversized option descriptions without calling the LLM", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const oversizedDescription = `${"This long provided option description is intentionally repeated. ".repeat(8)}Do not rewrite it.`;

    const service = new SessionLifecycleService({
      persistSession: () => {},
      clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => ({
        notificationSent: false,
        worktreeRemoved: false,
      }),
      resolveWorktreeRepoDir: () => undefined,
      updatePersistedSession: () => false,
      dispatchSessionNotification: (_session, request) => {
        requests.push(request as unknown as Record<string, unknown>);
      },
      notifySession: () => {},
      clearRetryTimersForSession: () => {},
      shouldEmitTerminalWake: () => true,
      resolvePlanApprovalMode: () => "ask",
      getPlanApprovalButtons: () => [],
      getResumeButtons: () => [],
      getQuestionButtons: (_sessionId, options) => [
        options.map((option) => ({ label: option.label, callbackData: `token:${option.label}` })),
      ],
      extractLastOutputLine: () => undefined,
      getOutputPreview: () => "",
      originThreadLine: () => "Origin thread: telegram topic 42",
      debounceWaitingEvent: () => true,
      isAlreadyMerged: () => false,
      questionContextSummaryProvider: {
        async generateQuestionContextSummary() {
          return undefined;
        },
      },
    });

    await service.emitWaitingForInput(createStubSession({
      id: "session-description-failure",
      name: "description-failure",
      pendingPlanApproval: false,
      pendingInputState: {
        requestId: "req-description-failure",
        kind: "question",
        promptText: "Which policy source should I use?",
        options: ["Plugin store", "Local override"],
        activeQuestionIndex: 0,
        questions: [{
          id: "policy_source",
          question: "Which policy source should I use?",
          options: [
            {
              label: "Plugin store",
              description: oversizedDescription,
            },
            { label: "Local override" },
          ],
        }],
      },
    }));

    assert.equal(requests.length, 1);
    assert.match(String(requests[0]?.userMessage ?? ""), /Which policy source should I use\?/);
    assert.doesNotMatch(String(requests[0]?.userMessage ?? ""), /Plugin store -/);
    assert.doesNotMatch(String(requests[0]?.userMessage ?? ""), /Do not rewrite it/);
    assert.deepEqual(
      (requests[0]?.buttons as Array<Array<{ label: string }>>).map((row) => row.map((button) => button.label)),
      [["Plugin store", "Local override"]],
    );
  });

  it("adds an LLM micro-summary to compact question prompts without changing options", async () => {
    const requests: Array<Record<string, unknown>> = [];

    const service = new SessionLifecycleService({
      persistSession: () => {},
      clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => ({
        notificationSent: false,
        worktreeRemoved: false,
      }),
      resolveWorktreeRepoDir: () => undefined,
      updatePersistedSession: () => false,
      dispatchSessionNotification: (_session, request) => {
        requests.push(request as unknown as Record<string, unknown>);
      },
      notifySession: () => {},
      clearRetryTimersForSession: () => {},
      shouldEmitTerminalWake: () => true,
      resolvePlanApprovalMode: () => "ask",
      getPlanApprovalButtons: () => [],
      getResumeButtons: () => [],
      getQuestionButtons: (_sessionId, options) => [
        options.map((option) => ({ label: option.label, callbackData: `token:${option.label}` })),
      ],
      extractLastOutputLine: () => undefined,
      getOutputPreview: () => [
        "The long deployment transcript should not be pasted into Telegram.",
        "Codex needs the environment before it can continue.",
      ].join("\n"),
      originThreadLine: () => "Origin thread: telegram topic 42",
      debounceWaitingEvent: () => true,
      isAlreadyMerged: () => false,
      questionContextSummaryProvider: {
        async generateQuestionContextSummary(evidence) {
          assert.match(evidence.context, /long deployment transcript/);
          return { summary: "Codex needs the target environment before it can continue." };
        },
      },
    });

    await service.emitWaitingForInput(createStubSession({
      id: "session-summary-question",
      name: "summary-question",
      pendingPlanApproval: false,
      pendingInputState: {
        requestId: "req-summary-question",
        kind: "question",
        promptText: "Which environment should I target?",
        options: ["Staging", "Production"],
      },
    }));

    assert.equal(requests.length, 1);
    assert.match(String(requests[0]?.userMessage ?? ""), /Which environment should I target\?/);
    assert.match(String(requests[0]?.userMessage ?? ""), /Why: Codex needs the target environment before it can continue\./);
    assert.doesNotMatch(String(requests[0]?.userMessage ?? ""), /Staging -/);
    assert.doesNotMatch(String(requests[0]?.userMessage ?? ""), /Production -/);
    assert.doesNotMatch(String(requests[0]?.userMessage ?? ""), /long deployment transcript/);
    assert.deepEqual(
      (requests[0]?.buttons as Array<Array<{ label: string }>>).map((row) => row.map((button) => button.label)),
      [["Staging", "Production"]],
    );
  });

  it("omits question context when LLM micro-summary generation fails", async () => {
    const requests: Array<Record<string, unknown>> = [];

    const service = new SessionLifecycleService({
      persistSession: () => {},
      clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => ({
        notificationSent: false,
        worktreeRemoved: false,
      }),
      resolveWorktreeRepoDir: () => undefined,
      updatePersistedSession: () => false,
      dispatchSessionNotification: (_session, request) => {
        requests.push(request as unknown as Record<string, unknown>);
      },
      notifySession: () => {},
      clearRetryTimersForSession: () => {},
      shouldEmitTerminalWake: () => true,
      resolvePlanApprovalMode: () => "ask",
      getPlanApprovalButtons: () => [],
      getResumeButtons: () => [],
      getQuestionButtons: (_sessionId, options) => [
        options.map((option) => ({ label: option.label, callbackData: `token:${option.label}` })),
      ],
      extractLastOutputLine: () => undefined,
      getOutputPreview: () => "This raw context must not appear if summarization fails.",
      originThreadLine: () => "Origin thread: telegram topic 42",
      debounceWaitingEvent: () => true,
      isAlreadyMerged: () => false,
      questionContextSummaryProvider: {
        async generateQuestionContextSummary() {
          return { summary: "This invalid summary is intentionally far too long to fit inside the strict one-sentence micro-summary budget for question prompts, so it must be omitted from the user-facing notification instead of being truncated or shown." };
        },
      },
    });

    await service.emitWaitingForInput(createStubSession({
      id: "session-summary-failure",
      name: "summary-failure",
      pendingPlanApproval: false,
      pendingInputState: {
        requestId: "req-summary-failure",
        kind: "question",
        promptText: "Which environment should I target?",
        options: ["Staging", "Production"],
      },
    }));

    assert.equal(requests.length, 1);
    assert.match(String(requests[0]?.userMessage ?? ""), /Which environment should I target\?/);
    assert.doesNotMatch(String(requests[0]?.userMessage ?? ""), /Why:/);
    assert.doesNotMatch(String(requests[0]?.userMessage ?? ""), /raw context/);
    assert.deepEqual(
      (requests[0]?.buttons as Array<Array<{ label: string }>>).map((row) => row.map((button) => button.label)),
      [["Staging", "Production"]],
    );
  });
});

describe("question prompt text", () => {
  it("numbers every option and explains multi-select, which has no buttons", async () => {
    const { buildActiveQuestionPrompt } = await import("../src/session-lifecycle-service");
    const text = buildActiveQuestionPrompt({
      question: {
        id: "fruits",
        header: "Fruits",
        question: "Which fruits do you like?",
        multiSelect: true,
        options: [{ label: "apple" }, { label: "banana", description: "Yellow" }, { label: "cherry" }],
      } as any,
      index: 1,
      total: 2,
      optionDescriptions: [{ label: "banana", description: "Yellow" }],
    });
    assert.equal(text, [
      "Question 2 - Fruits",
      "Which fruits do you like?",
      "",
      "1. apple",
      "2. banana - Yellow",
      "3. cherry",
      "",
      "Several answers allowed: reply with them, for example 1,3.",
    ].join("\n"));
  });
});
