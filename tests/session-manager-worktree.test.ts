import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "../src/session-manager";
import { createWorktree, getBranchName } from "../src/worktree";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

function stubDispatch(sm: SessionManager): void {
  (sm as any).__dispatchCalls = [];
  (sm as any).notifications = {
    dispatch: (...args: any[]) => { ((sm as any).__dispatchCalls ??= []).push(args); },
    notifyWorktreeOutcome: (...args: any[]) => { ((sm as any).__dispatchCalls ??= []).push(args); },
    dispose: () => {},
  };
  (sm as any).wakeDispatcher = { clearRetryTimersForSession: () => {}, dispose: () => {} };
}

describe("SessionManager.handleWorktreeStrategy()", () => {
  it("notifies no-change cleanup only after the worktree is actually deleted", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "sm-worktree-"));
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");

      const worktreePath = createWorktree(repoDir, "no-change-cleanup");
      const branchName = getBranchName(worktreePath);
      assert.ok(branchName, "worktree branch should exist");

      const sm = new SessionManager(5);
      stubDispatch(sm);
      (sm as any).store.persisted.set("h-no-change", {
        harnessSessionId: "h-no-change",
        backendRef: { kind: "claude-code", conversationId: "h-no-change" },
        name: "no-change",
        prompt: "test",
        workdir: repoDir,
        route: {
          provider: "telegram",
          target: "12345",
          sessionKey: "agent:main:telegram:group:12345",
        },
        status: "completed",
        costUsd: 0,
        worktreePath,
        worktreeBranch: branchName,
        worktreeStrategy: "ask",
      });

      const session = {
        id: "s-no-change",
        name: "no-change",
        status: "completed",
        phase: "implementing",
        harnessSessionId: "h-no-change",
        prompt: "test",
        originalWorkdir: repoDir,
        worktreePath,
        worktreeBranch: branchName,
        worktreeStrategy: "ask",
        worktreeBaseBranch: "main",
        pendingPlanApproval: false,
        getOutput: () => [
          "Builds & Tools follow-up:",
          "Built rust-hello-world and verified the binary output.",
          "No repo changes were needed after validation.",
        ],
      };

      const result = await (sm as any).handleWorktreeStrategy(session);

      assert.deepEqual(result, { notificationSent: true, worktreeRemoved: true });
      assert.equal(session.worktreePath, undefined);
      const calls = (sm as any).__dispatchCalls;
      assert.equal(calls.length, 1);
      const [_sessionArg, request] = calls[0];
      assert.equal(request.label, "worktree-no-changes");
      assert.match(request.userMessage, /worktree cleaned up/);
      assert.equal(request.notifyUser, "always");
      assert.match(request.wakeMessage, /completed with no repository changes/);
      assert.match(request.wakeMessage, /Built rust-hello-world and verified the binary output/);
      const persisted = (sm as any).store.persisted.get("h-no-change");
      assert.equal(persisted.worktreePath, undefined);
      assert.equal(persisted.worktreeDisposition, "no-change-cleaned");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("uses the generic cleanup message for no-change plan sessions", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "sm-worktree-plan-report-"));
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");

      const worktreePath = createWorktree(repoDir, "plan-report");
      const branchName = getBranchName(worktreePath);
      assert.ok(branchName, "worktree branch should exist");

      const sm = new SessionManager(5);
      stubDispatch(sm);
      (sm as any).store.persisted.set("h-plan-report", {
        harnessSessionId: "h-plan-report",
        backendRef: { kind: "claude-code", conversationId: "h-plan-report" },
        name: "plan-report",
        prompt: "Investigate the issue and write a plan before making any code changes.",
        workdir: repoDir,
        route: {
          provider: "telegram",
          target: "12345",
          sessionKey: "agent:main:telegram:group:12345",
        },
        status: "completed",
        costUsd: 0,
        worktreePath,
        worktreeBranch: branchName,
        worktreeStrategy: "ask",
      });

      const session = {
        id: "s-plan-report",
        name: "plan-report",
        status: "completed",
        phase: "implementing",
        harnessSessionId: "h-plan-report",
        prompt: "Investigate the issue and write a plan before making any code changes.",
        originalWorkdir: repoDir,
        worktreePath,
        worktreeBranch: branchName,
        worktreeStrategy: "ask",
        worktreeBaseBranch: "main",
        currentPermissionMode: "plan",
        pendingPlanApproval: false,
        getOutput: () => [
          "Plan:",
          "- Inspect the completion path in session-manager.ts",
          "- Route report-only sessions through the existing notification pipeline",
          "- Add regression coverage for no-change planning sessions",
        ],
      };

      const result = await (sm as any).handleWorktreeStrategy(session);

      assert.deepEqual(result, { notificationSent: true, worktreeRemoved: true });
      const calls = (sm as any).__dispatchCalls;
      assert.equal(calls.length, 1);
      const [_sessionArg, request] = calls[0];
      assert.equal(request.label, "worktree-no-changes");
      assert.equal(request.userMessage, "ℹ️ [plan-report] Session completed with no changes — worktree cleaned up");
      assert.match(request.wakeMessage, /plugin already sent the canonical completion notification/i);
      assert.match(request.wakeMessage, /do NOT repeat the plugin's completion status line/i);
      assert.match(request.wakeMessage, /usually send a short plain-text summary of what was done or the concrete outcome/i);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("uses the generic cleanup message for no-change investigation sessions outside explicit plan mode", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "sm-worktree-investigation-report-"));
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");

      const worktreePath = createWorktree(repoDir, "investigation-report");
      const branchName = getBranchName(worktreePath);
      assert.ok(branchName, "worktree branch should exist");

      const sm = new SessionManager(5);
      stubDispatch(sm);
      const session = {
        id: "s-investigation-report",
        name: "investigation-report",
        status: "completed",
        phase: "implementing",
        harnessSessionId: "h-investigation-report",
        prompt: "Investigate why the callback is skipped and report the root cause.",
        originalWorkdir: repoDir,
        worktreePath,
        worktreeBranch: branchName,
        worktreeStrategy: "ask",
        worktreeBaseBranch: "main",
        currentPermissionMode: "default",
        pendingPlanApproval: false,
        getOutput: () => [
          "Findings:",
          "The terminal cleanup branch runs before any output-aware completion fallback.",
          "That makes a no-diff investigation look like a no-op even when a report was produced.",
          "Recommended fix: inspect output before sending the generic no-change notification.",
        ],
      };

      const result = await (sm as any).handleWorktreeStrategy(session);

      assert.deepEqual(result, { notificationSent: true, worktreeRemoved: true });
      const calls = (sm as any).__dispatchCalls;
      assert.equal(calls.length, 1);
      const [_sessionArg, request] = calls[0];
      assert.equal(request.label, "worktree-no-changes");
      assert.equal(request.userMessage, "ℹ️ [investigation-report] Session completed with no changes — worktree cleaned up");
      assert.match(request.wakeMessage, /plugin already sent the canonical completion notification/i);
      assert.match(request.wakeMessage, /do NOT repeat the plugin's completion status line/i);
      assert.match(request.wakeMessage, /usually send a short plain-text summary of what was done or the concrete outcome/i);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("releases native Codex worktrees to backend cleanup instead of deleting them directly", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "sm-worktree-native-codex-"));
    const nativeWorktreePath = join(tmpdir(), "codex-native-worktree-release");
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");

      const sm = new SessionManager(5);
      stubDispatch(sm);
      (sm as any).store.persisted.set("legacy-native-thread", {
        sessionId: "s-native-codex",
        harnessSessionId: "legacy-native-thread",
        backendRef: {
          kind: "codex-app-server",
          conversationId: "backend-native-thread",
          worktreeId: "abcd",
          worktreePath: nativeWorktreePath,
        },
        name: "native-codex",
        prompt: "inspect only",
        workdir: repoDir,
        route: {
          provider: "telegram",
          target: "12345",
          sessionKey: "agent:main:telegram:group:12345",
        },
        status: "completed",
        costUsd: 0,
        worktreePath: nativeWorktreePath,
        worktreeBranch: "agent/native-codex",
        worktreeStrategy: "ask",
      });
      (sm as any).store.idIndex.set("s-native-codex", "legacy-native-thread");

      const session = {
        id: "s-native-codex",
        name: "native-codex",
        status: "completed",
        phase: "implementing",
        harnessName: "codex",
        backendRef: {
          kind: "codex-app-server",
          conversationId: "backend-native-thread",
          worktreeId: "abcd",
          worktreePath: nativeWorktreePath,
        },
        harnessSessionId: "legacy-native-thread",
        prompt: "inspect only",
        originalWorkdir: repoDir,
        worktreePath: nativeWorktreePath,
        worktreeBranch: "agent/native-codex",
        worktreeStrategy: "ask",
        worktreeBaseBranch: "main",
        pendingPlanApproval: false,
      };

      const result = await (sm as any).handleWorktreeStrategy(session);

      assert.deepEqual(result, { notificationSent: true, worktreeRemoved: true });
      assert.equal(session.worktreePath, undefined);
      const calls = (sm as any).__dispatchCalls;
      assert.equal(calls.length, 1);
      const [_sessionArg, request] = calls[0];
      assert.equal(request.label, "worktree-no-changes");
      assert.match(request.userMessage, /native backend worktree released for backend cleanup/);
      const persisted = (sm as any).store.getPersistedSession("s-native-codex");
      assert.equal(persisted?.worktreePath, undefined);
      assert.equal(persisted?.worktreeDisposition, "no-change-cleaned");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("routes delegate mode to the orchestrator without user buttons", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "sm-worktree-delegate-"));
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");

      const worktreePath = createWorktree(repoDir, "delegate-buttons");
      const branchName = getBranchName(worktreePath);
      assert.ok(branchName, "worktree branch should exist");

      writeFileSync(join(worktreePath, "README.md"), "hello\nupdated\n", "utf-8");
      git(worktreePath, "add", "README.md");
      git(worktreePath, "commit", "-m", "update readme");

      const sm = new SessionManager(5);
      stubDispatch(sm);
      (sm as any).store.persisted.set("h-delegate", {
        harnessSessionId: "h-delegate",
        backendRef: { kind: "claude-code", conversationId: "h-delegate" },
        name: "delegate-session",
        prompt: "update the readme",
        workdir: repoDir,
        route: {
          provider: "telegram",
          target: "12345",
          sessionKey: "agent:main:telegram:group:12345",
        },
        status: "completed",
        costUsd: 0,
        worktreePath,
        worktreeBranch: branchName,
        worktreeStrategy: "delegate",
      });

      const session = {
        id: "s-delegate",
        name: "delegate-session",
        status: "completed",
        phase: "implementing",
        harnessSessionId: "h-delegate",
        prompt: "update the readme",
        originalWorkdir: repoDir,
        worktreePath,
        worktreeBranch: branchName,
        worktreeStrategy: "delegate",
        worktreeBaseBranch: "main",
        pendingPlanApproval: false,
      };
      (sm as any).sessions.set(session.id, session);

      const result = await (sm as any).handleWorktreeStrategy(session);

      assert.deepEqual(result, { notificationSent: true, worktreeRemoved: false });
      const calls = (sm as any).__dispatchCalls;
      assert.equal(calls.length, 1);
      const [_sessionArg, request] = calls[0];
      assert.equal(request.label, "worktree-delegate");
      assert.equal(request.notifyUser, "never");
      assert.equal(request.userMessage, undefined);
      assert.equal(request.buttons, undefined);
      assert.match(request.wakeMessage, /DELEGATED WORKTREE DECISION/);
      assert.match(request.wakeMessage, /agent_merge\(session="delegate-session"/);
      assert.match(request.wakeMessage, /Never call agent_pr\(\) autonomously/);
      const persisted = (sm as any).store.persisted.get("h-delegate");
      assert.match(persisted.pendingWorktreeDecisionSince, /^\d{4}-\d{2}-\d{2}T/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("adds a concise implementation summary and shorter button rows for ask-mode worktree prompts", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "sm-worktree-ask-summary-"));
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
      writeFileSync(join(repoDir, "notes.txt"), "base\n", "utf-8");
      git(repoDir, "add", "README.md", "notes.txt");
      git(repoDir, "commit", "-m", "init");

      const worktreePath = createWorktree(repoDir, "ask-summary");
      const branchName = getBranchName(worktreePath);
      assert.ok(branchName, "worktree branch should exist");

      writeFileSync(join(worktreePath, "README.md"), "hello\nupdated\n", "utf-8");
      writeFileSync(join(worktreePath, "src-note.txt"), "new file\n", "utf-8");
      git(worktreePath, "add", "README.md", "src-note.txt");
      git(worktreePath, "commit", "-m", "tighten worktree decision UX");

      const sm = new SessionManager(5);
      stubDispatch(sm);
      (sm as any).store.persisted.set("h-ask-summary", {
        harnessSessionId: "h-ask-summary",
        backendRef: { kind: "claude-code", conversationId: "h-ask-summary" },
        name: "ask-summary",
        prompt: "fix the worktree decision prompt",
        workdir: repoDir,
        route: {
          provider: "telegram",
          target: "12345",
          sessionKey: "agent:main:telegram:group:12345",
        },
        status: "completed",
        costUsd: 0,
        worktreePath,
        worktreeBranch: branchName,
        worktreeStrategy: "ask",
      });

      const session = {
        id: "s-ask-summary",
        name: "ask-summary",
        status: "completed",
        phase: "implementing",
        harnessSessionId: "h-ask-summary",
        prompt: "fix the worktree decision prompt",
        originalWorkdir: repoDir,
        worktreePath,
        worktreeBranch: branchName,
        worktreeStrategy: "ask",
        worktreeBaseBranch: "main",
        pendingPlanApproval: false,
      };
      (sm as any).sessions.set(session.id, session);

      const result = await (sm as any).handleWorktreeStrategy(session);

      assert.deepEqual(result, { notificationSent: true, worktreeRemoved: false });
      const calls = (sm as any).__dispatchCalls;
      assert.equal(calls.length, 1);
      const [_sessionArg, request] = calls[0];
      assert.equal(request.label, "worktree-merge-ask");
      assert.match(request.userMessage, /Summary:/);
      assert.match(request.userMessage, /Touches `README.md`, `src-note.txt`/);
      assert.match(request.userMessage, /Recent work: tighten worktree decision UX/);
      assert.match(request.wakeMessageOnNotifySuccess, /Session: ask-summary \| ID: s-ask-summary/);
      assert.match(request.wakeMessageOnNotifySuccess, /Branch: `agent\/ask-summary` → `main`/);
      assert.deepEqual(
        request.buttons.map((row: Array<{ label: string }>) => row.map((button) => button.label)),
        [
          ["Merge", "Open PR"],
          ["Later", "Discard"],
        ],
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("daily cleanup removes resolved worktrees after retention", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "sm-worktree-retention-"));
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");

      const worktreePath = createWorktree(repoDir, "resolved-cleanup");
      const branchName = getBranchName(worktreePath);
      assert.ok(branchName, "worktree branch should exist");

      const sm = new SessionManager(5);
      (sm as any).store.persisted.set("h-resolved", {
        harnessSessionId: "h-resolved",
        backendRef: { kind: "claude-code", conversationId: "h-resolved" },
        name: "resolved-cleanup",
        prompt: "test",
        workdir: repoDir,
        route: {
          provider: "telegram",
          target: "12345",
          sessionKey: "agent:main:telegram:group:12345",
        },
        status: "completed",
        costUsd: 0,
        worktreePath,
        worktreeBranch: branchName,
        worktreeState: "merged",
        worktreeMergedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      });

      (sm as any).runDailyWorktreeMaintenance(Date.now());

      assert.equal(existsSync(worktreePath), false);
      const persisted = (sm as any).store.persisted.get("h-resolved");
      assert.equal(persisted.worktreePath, undefined);
      assert.equal(persisted.worktreeState, "none");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("daily cleanup never deletes pending-decision worktrees", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "sm-worktree-pending-"));
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");

      const worktreePath = createWorktree(repoDir, "pending-cleanup");
      const branchName = getBranchName(worktreePath);
      assert.ok(branchName, "worktree branch should exist");

      const sm = new SessionManager(5);
      (sm as any).store.persisted.set("h-pending", {
        harnessSessionId: "h-pending",
        backendRef: { kind: "claude-code", conversationId: "h-pending" },
        name: "pending-cleanup",
        prompt: "test",
        workdir: repoDir,
        route: {
          provider: "telegram",
          target: "12345",
          sessionKey: "agent:main:telegram:group:12345",
        },
        status: "completed",
        costUsd: 0,
        worktreePath,
        worktreeBranch: branchName,
        worktreeState: "pending_decision",
        pendingWorktreeDecisionSince: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      });

      (sm as any).runDailyWorktreeMaintenance(Date.now());

      assert.equal(existsSync(worktreePath), true);
      const persisted = (sm as any).store.persisted.get("h-pending");
      assert.equal(persisted.worktreePath, worktreePath);
      assert.equal(persisted.worktreeState, "pending_decision");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
