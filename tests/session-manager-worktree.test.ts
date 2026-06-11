import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "../src/session-manager";
import type { WorktreeDecisionSummaryEvidence, WorktreeDecisionSummaryProvider } from "../src/worktree-decision-summary";
import { createWorktree, getBranchName } from "../src/worktree";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

const mockGhDir = mkdtempSync(join(tmpdir(), "sm-worktree-gh-"));
const mockGhBinDir = join(mockGhDir, "bin");
mkdirSync(mockGhBinDir);
writeFileSync(join(mockGhBinDir, "gh"), [
  "#!/bin/sh",
  "if [ \"$1\" = \"--version\" ]; then",
  "  echo 'gh version 2.0.0'",
  "  exit 0",
  "fi",
  "exit 1",
  "",
].join("\n"));
chmodSync(join(mockGhBinDir, "gh"), 0o755);
const originalPath = process.env.PATH;
process.env.PATH = `${mockGhBinDir}:${process.env.PATH ?? ""}`;
after(() => {
  process.env.PATH = originalPath;
  rmSync(mockGhDir, { recursive: true, force: true });
});

function createTestSessionManager(
  maxSessions = 5,
  options: { worktreeSummaryProvider?: WorktreeDecisionSummaryProvider } = {},
): { sm: SessionManager; cleanup: () => void } {
  const storeDir = mkdtempSync(join(tmpdir(), "sm-session-store-"));
  const sm = new SessionManager(maxSessions, 50, {
    store: {
      env: {},
      indexPath: join(storeDir, "sessions.json"),
    },
    worktreeSummaryProvider: options.worktreeSummaryProvider,
  });
  return {
    sm,
    cleanup: () => rmSync(storeDir, { recursive: true, force: true }),
  };
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

function buttonLabels(rows: Array<Array<{ label: string }>> | undefined): string[][] {
  return (rows ?? []).map((row) => row.map((button) => button.label));
}

function hasButton(rows: string[][], label: string): boolean {
  return rows.some((row) => row.includes(label));
}

function createPendingDelegateDecisionFixture(policy: "pr-required" | "never-pr" | "manual"): {
  sm: SessionManager;
  cleanup: () => void;
  dispatchCalls: () => any[];
} {
  const repoDir = mkdtempSync(join(tmpdir(), `sm-worktree-live-policy-${policy}-`));
  git(repoDir, "init", "-b", "main");
  git(repoDir, "config", "user.name", "Test User");
  git(repoDir, "config", "user.email", "test@example.com");
  writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
  git(repoDir, "add", "README.md");
  git(repoDir, "commit", "-m", "init");
  if (policy === "pr-required") {
    git(repoDir, "remote", "add", "origin", "https://github.com/example/repo.git");
  }

  const worktreePath = createWorktree(repoDir, `live-policy-${policy}`);
  const branchName = getBranchName(worktreePath);
  assert.ok(branchName, "worktree branch should exist");

  writeFileSync(join(worktreePath, "README.md"), `hello\n${policy}\n`, "utf-8");
  git(worktreePath, "add", "README.md");
  git(worktreePath, "commit", "-m", `update for ${policy}`);

  const created = createTestSessionManager(5);
  const sm = created.sm;
  stubDispatch(sm);
  (sm as any).interactions.isGitHubCliAvailable = () => true;
  sm.setRepoPolicy(repoDir, policy);
  (sm as any).sessions.set(`s-live-policy-${policy}`, {
    id: `s-live-policy-${policy}`,
    name: `live-policy-${policy}`,
    status: "completed",
    phase: "implementing",
    prompt: "update the readme",
    originalWorkdir: repoDir,
    worktreePath,
    worktreeBranch: branchName,
    worktreeStrategy: "delegate",
    worktreeBaseBranch: "main",
    pendingWorktreeDecisionSince: new Date().toISOString(),
    pendingPlanApproval: false,
  });

  return {
    sm,
    cleanup: () => {
      rmSync(repoDir, { recursive: true, force: true });
      created.cleanup();
    },
    dispatchCalls: () => (sm as any).__dispatchCalls ?? [],
  };
}

describe("SessionManager.handleWorktreeStrategy()", () => {
  it("notifies no-change cleanup only after the worktree is actually deleted", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "sm-worktree-"));
    let cleanup = () => {};
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");
      git(repoDir, "remote", "add", "origin", "https://github.com/example/repo.git");

      const worktreePath = createWorktree(repoDir, "no-change-cleanup");
      const branchName = getBranchName(worktreePath);
      assert.ok(branchName, "worktree branch should exist");

      const created = createTestSessionManager(5);
      const sm = created.sm;
      cleanup = created.cleanup;
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
      cleanup();
    }
  });

  it("uses the generic cleanup message for no-change plan sessions", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "sm-worktree-plan-report-"));
    let cleanup = () => {};
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

      const created = createTestSessionManager(5);
      const sm = created.sm;
      cleanup = created.cleanup;
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
      assert.match(request.wakeMessage, /plugin already sent the canonical completion status/i);
      assert.match(request.wakeMessage, /send the user one short factual completion summary/i);
      assert.match(request.wakeMessage, /Do this even when agent_output already contains a good final summary/);
      assert.doesNotMatch(request.wakeMessage, /already summarized by completed session/);
      assert.match(request.wakeMessage, /ordinary terminal\/manual completions too/i);
      assert.match(request.wakeMessage, /do NOT repeat the plugin's status line/i);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      cleanup();
    }
  });

  it("uses the generic cleanup message for no-change investigation sessions outside explicit plan mode", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "sm-worktree-investigation-report-"));
    let cleanup = () => {};
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

      const created = createTestSessionManager(5);
      const sm = created.sm;
      cleanup = created.cleanup;
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
      assert.match(request.wakeMessage, /plugin already sent the canonical completion status/i);
      assert.match(request.wakeMessage, /send the user one short factual completion summary/i);
      assert.match(request.wakeMessage, /Do this even when agent_output already contains a good final summary/);
      assert.doesNotMatch(request.wakeMessage, /already summarized by completed session/);
      assert.match(request.wakeMessage, /ordinary terminal\/manual completions too/i);
      assert.match(request.wakeMessage, /do NOT repeat the plugin's status line/i);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      cleanup();
    }
  });

  it("marks dirty uncommitted worktree completion as a pending decision instead of no-change", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "sm-worktree-dirty-completion-"));
    let cleanup = () => {};
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");

      const worktreePath = createWorktree(repoDir, "dirty-completion");
      const branchName = getBranchName(worktreePath);
      assert.ok(branchName, "worktree branch should exist");
      writeFileSync(join(worktreePath, "new-file.txt"), "untracked\n", "utf-8");

      const created = createTestSessionManager(5);
      const sm = created.sm;
      cleanup = created.cleanup;
      stubDispatch(sm);
      (sm as any).store.persisted.set("h-dirty-completion", {
        harnessSessionId: "h-dirty-completion",
        backendRef: { kind: "claude-code", conversationId: "h-dirty-completion" },
        name: "dirty-completion",
        prompt: "create a file",
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
        id: "s-dirty-completion",
        name: "dirty-completion",
        status: "completed",
        phase: "implementing",
        harnessSessionId: "h-dirty-completion",
        prompt: "create a file",
        originalWorkdir: repoDir,
        worktreePath,
        worktreeBranch: branchName,
        worktreeStrategy: "delegate",
        worktreeBaseBranch: "main",
        pendingPlanApproval: false,
      };

      const result = await (sm as any).handleWorktreeStrategy(session);

      assert.deepEqual(result, { notificationSent: true, worktreeRemoved: false });
      assert.equal(existsSync(worktreePath), true);
      const calls = (sm as any).__dispatchCalls;
      assert.equal(calls.length, 1);
      const [_sessionArg, request] = calls[0];
      assert.equal(request.label, "worktree-dirty-uncommitted");
      assert.match(request.userMessage, /uncommitted worktree changes/i);
      assert.match(request.userMessage, /new-file\.txt/);
      const persisted = (sm as any).store.persisted.get("h-dirty-completion");
      assert.equal(persisted.lifecycle, "awaiting_worktree_decision");
      assert.equal(persisted.worktreeState, "pending_decision");
      assert.equal(persisted.worktreeLifecycle?.state, "pending_decision");
      assert.deepEqual(persisted.worktreeLifecycle?.notes, ["dirty_uncommitted_completion"]);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      cleanup();
    }
  });

  it("releases native Codex worktrees to backend cleanup instead of deleting them directly", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "sm-worktree-native-codex-"));
    const nativeWorktreePath = join(tmpdir(), "codex-native-worktree-release");
    let cleanup = () => {};
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");

      const created = createTestSessionManager(5);
      const sm = created.sm;
      cleanup = created.cleanup;
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
      cleanup();
    }
  });

  it("routes delegate mode with a visible pending status and orchestrator wake", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "sm-worktree-delegate-"));
    let cleanup = () => {};
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");
      git(repoDir, "remote", "add", "origin", "https://github.com/example/repo.git");

      const worktreePath = createWorktree(repoDir, "delegate-buttons");
      const branchName = getBranchName(worktreePath);
      assert.ok(branchName, "worktree branch should exist");

      writeFileSync(join(worktreePath, "README.md"), "hello\nupdated\n", "utf-8");
      git(worktreePath, "add", "README.md");
      git(worktreePath, "commit", "-m", "update readme");

      const created = createTestSessionManager(5);
      const sm = created.sm;
      cleanup = created.cleanup;
      stubDispatch(sm);
      sm.setRepoPolicy(repoDir, "pr-allowed");
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
        route: {
          provider: "telegram",
          target: "-1003863755361",
          threadId: "13832",
          sessionKey: "agent:main:telegram:group:-1003863755361:topic:13832",
        },
        originChannel: "telegram|-1003863755361",
        originThreadId: 13832,
        originSessionKey: "agent:main:telegram:group:-1003863755361:topic:13832",
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
      assert.match(request.wakeMessage, /Session origin route \(authoritative for human follow-ups\):/);
      assert.match(request.wakeMessage, /"target":"-1003863755361"/);
      assert.match(request.wakeMessage, /"threadId":"13832"/);
      assert.match(request.wakeMessage, /do not use a plain final assistant reply/i);
      assert.match(request.wakeMessage, /agent_merge\(session="delegate-session"/);
      assert.match(request.wakeMessage, /agent_request_worktree_decision\(session="delegate-session"/);
      assert.match(request.wakeMessage, /Never call agent_pr\(\) autonomously/);
      const persisted = (sm as any).store.persisted.get("h-delegate");
      assert.match(persisted.pendingWorktreeDecisionSince, /^\d{4}-\d{2}-\d{2}T/);

      const response = (sm as any).requestWorktreeDecisionFromUser(
        "delegate-session",
        [
          "PR is safer because the branch changes user-visible notification behavior.",
          "Please choose whether to merge locally or open a PR.",
        ].join("\n"),
      );

      assert.match(response, /Canonical worktree decision prompt sent/);
      assert.equal(calls.length, 2);
      const [_promptSessionArg, promptRequest] = calls[1];
      assert.equal(promptRequest.label, "worktree-merge-ask");
      assert.equal(promptRequest.notifyUser, "always");
      assert.match(promptRequest.userMessage, /PR is safer because the branch changes user-visible notification behavior/);
      assert.deepEqual(
        promptRequest.buttons.map((row: Array<{ label: string }>) => row.map((button) => button.label)),
        [
          ["Merge", "Open PR"],
          ["Later", "Discard"],
        ],
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      cleanup();
    }
  });

  it("uses live pr-required policy for explicit pending worktree decision buttons without a session snapshot", () => {
    const fixture = createPendingDelegateDecisionFixture("pr-required");
    try {
      const response = (fixture.sm as any).requestWorktreeDecisionFromUser(
        "s-live-policy-pr-required",
        "The branch is ready for a worktree decision.",
      );

      assert.match(response, /Canonical worktree decision prompt sent/);
      const request = fixture.dispatchCalls().at(-1)?.[1];
      assert.equal(request.label, "worktree-merge-ask");
      const labels = buttonLabels(request.buttons);
      assert.equal(hasButton(labels, "Merge"), false);
      assert.equal(hasButton(labels, "Open PR"), true);
    } finally {
      fixture.cleanup();
    }
  });

  for (const policy of ["never-pr", "manual"] as const) {
    it(`uses live ${policy} policy for explicit pending worktree decision PR buttons without a session snapshot`, () => {
      const fixture = createPendingDelegateDecisionFixture(policy);
      try {
        const response = (fixture.sm as any).requestWorktreeDecisionFromUser(
          `s-live-policy-${policy}`,
          "The branch is ready for a worktree decision.",
        );

        assert.match(response, /Canonical worktree decision prompt sent/);
        const request = fixture.dispatchCalls().at(-1)?.[1];
        assert.equal(request.label, "worktree-merge-ask");
        const labels = buttonLabels(request.buttons);
        assert.equal(hasButton(labels, "Open PR"), false);
        assert.equal(hasButton(labels, "View PR"), false);
        assert.equal(hasButton(labels, "Sync PR"), false);
        if (policy === "manual") {
          assert.equal(hasButton(labels, "Merge"), false);
        }
      } finally {
        fixture.cleanup();
      }
    });
  }

  it("adds a concise implementation summary and shorter button rows for ask-mode worktree prompts", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "sm-worktree-ask-summary-"));
    let cleanup = () => {};
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
      writeFileSync(join(repoDir, "notes.txt"), "base\n", "utf-8");
      git(repoDir, "add", "README.md", "notes.txt");
      git(repoDir, "commit", "-m", "init");
      git(repoDir, "remote", "add", "origin", "https://github.com/example/repo.git");

      const worktreePath = createWorktree(repoDir, "ask-summary");
      const branchName = getBranchName(worktreePath);
      assert.ok(branchName, "worktree branch should exist");

      writeFileSync(join(worktreePath, "README.md"), "hello\nupdated\n", "utf-8");
      writeFileSync(join(worktreePath, "src-note.txt"), "new file\n", "utf-8");
      git(worktreePath, "add", "README.md", "src-note.txt");
      git(worktreePath, "commit", "-m", "tighten worktree decision UX");

      let capturedEvidence: WorktreeDecisionSummaryEvidence | undefined;
      const created = createTestSessionManager(5, {
        worktreeSummaryProvider: {
          async generateWorktreeDecisionSummary(evidence) {
            capturedEvidence = evidence;
            return {
              summary: [
                "Fixed the worktree decision notification so it explains the completed UX changes.",
                "Updated callback cleanup so successful decisions resolve the original Telegram buttons.",
                "Covered the summary and callback behavior with focused regression tests.",
              ],
            };
          },
        },
      });
      const sm = created.sm;
      cleanup = created.cleanup;
      stubDispatch(sm);
      (sm as any).interactions.isGitHubCliAvailable = () => true;
      sm.setRepoPolicy(repoDir, "pr-allowed");
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
        getOutput: () => [
          "Implemented a richer worktree decision prompt using the agent's completion summary.",
          "Changed src/session-worktree-message-service.ts and src/session-notification-builders/worktree.ts.",
          "Verified with focused regression tests for summary quality and callback cleanup.",
        ],
      };
      (sm as any).sessions.set(session.id, session);

      const result = await (sm as any).handleWorktreeStrategy(session);

      assert.deepEqual(result, { notificationSent: true, worktreeRemoved: false });
      const calls = (sm as any).__dispatchCalls;
      assert.equal(calls.length, 1);
      const [_sessionArg, request] = calls[0];
      assert.equal(request.label, "worktree-merge-ask");
      assert.match(request.userMessage, /Summary:/);
      assert.match(request.userMessage, /Fixed the worktree decision notification so it explains the completed UX changes/);
      assert.match(request.userMessage, /Updated callback cleanup so successful decisions resolve the original Telegram buttons/);
      assert.match(request.userMessage, /Covered the summary and callback behavior with focused regression tests/);
      assert.doesNotMatch(request.userMessage, /Implemented a richer worktree decision prompt using the agent's completion summary/);
      assert.doesNotMatch(request.userMessage, /Touches `README\.md`, `src-note\.txt`/);
      assert.equal(capturedEvidence?.sessionName, "ask-summary");
      assert.match(capturedEvidence?.objective ?? "", /fix the worktree decision prompt/);
      assert.ok(capturedEvidence?.changedFiles.includes("README.md"));
      assert.match(capturedEvidence?.outputPreview ?? "", /Implemented a richer worktree decision prompt/);
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
      cleanup();
    }
  });

  it("daily cleanup removes resolved worktrees after retention", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "sm-worktree-retention-"));
    let cleanup = () => {};
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

      const created = createTestSessionManager(5);
      const sm = created.sm;
      cleanup = created.cleanup;
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
        worktreeLifecycle: {
          state: "pr_open",
          updatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
        },
      });

      (sm as any).maintenance.reconcileResolvedWorktreeRetention((sm as any).store.persisted.get("h-resolved"), Date.now());

      assert.equal(existsSync(worktreePath), false);
      const persisted = (sm as any).store.persisted.get("h-resolved");
      assert.equal(persisted.worktreePath, undefined);
      assert.equal(persisted.worktreeState, "none");
      assert.equal(persisted.worktreeLifecycle?.state, "merged");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      cleanup();
    }
  });

  it("retention cleanup never deletes pending-decision worktrees", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "sm-worktree-pending-"));
    let cleanup = () => {};
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

      const created = createTestSessionManager(5);
      const sm = created.sm;
      cleanup = created.cleanup;
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

      (sm as any).maintenance.reconcileResolvedWorktreeRetention((sm as any).store.persisted.get("h-pending"), Date.now());

      assert.equal(existsSync(worktreePath), true);
      const persisted = (sm as any).store.persisted.get("h-pending");
      assert.equal(persisted.worktreePath, worktreePath);
      assert.equal(persisted.worktreeState, "pending_decision");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      cleanup();
    }
  });

  it("retention cleanup removes legacy dismissed worktrees without lifecycle metadata", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "sm-worktree-legacy-dismissed-"));
    let cleanup = () => {};
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");

      const worktreePath = createWorktree(repoDir, "legacy-dismissed-cleanup");
      const branchName = getBranchName(worktreePath);
      assert.ok(branchName, "worktree branch should exist");

      const created = createTestSessionManager(5);
      const sm = created.sm;
      cleanup = created.cleanup;
      (sm as any).store.persisted.set("h-legacy-dismissed", {
        harnessSessionId: "h-legacy-dismissed",
        backendRef: { kind: "claude-code", conversationId: "h-legacy-dismissed" },
        name: "legacy-dismissed-cleanup",
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
        worktreeDisposition: "dismissed",
        worktreeDismissedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      });

      (sm as any).maintenance.reconcileResolvedWorktreeRetention((sm as any).store.persisted.get("h-legacy-dismissed"), Date.now());

      assert.equal(existsSync(worktreePath), false);
      const persisted = (sm as any).store.persisted.get("h-legacy-dismissed");
      assert.equal(persisted.worktreePath, undefined);
      assert.equal(persisted.worktreeState, "none");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      cleanup();
    }
  });
});
