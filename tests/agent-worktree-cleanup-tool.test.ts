import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setSessionManager } from "../src/singletons";
import { makeAgentWorktreeCleanupTool } from "../src/tools/agent-worktree-cleanup";
import { makeAgentWorktreeStatusTool } from "../src/tools/agent-worktree-status";
import { createWorktree, getBranchName } from "../src/worktree";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function initRepo(prefix: string): string {
  const repoDir = mkdtempSync(join(tmpdir(), prefix));
  git(repoDir, "init", "-b", "main");
  git(repoDir, "config", "user.name", "Test User");
  git(repoDir, "config", "user.email", "test@example.com");
  writeFileSync(join(repoDir, "README.md"), "base\n", "utf-8");
  git(repoDir, "add", "README.md");
  git(repoDir, "commit", "-m", "init");
  return repoDir;
}

function createCommittedWorktree(repoDir: string, name: string, fileName = "feature.txt", contents = `${name}\n`) {
  const worktreePath = createWorktree(repoDir, name);
  const branchName = getBranchName(worktreePath);
  assert.ok(branchName, "worktree branch should exist");
  writeFileSync(join(worktreePath, fileName), contents, "utf-8");
  git(worktreePath, "add", fileName);
  git(worktreePath, "commit", "-m", `feat: ${name}`);
  return { worktreePath, branchName };
}

function installFakeGh(dir: string, prsJson: string): string {
  const ghPath = join(dir, "gh");
  writeFileSync(ghPath, [
    "#!/usr/bin/env sh",
    "if [ \"$1\" = \"--version\" ]; then echo 'gh version 2.0.0'; exit 0; fi",
    "if [ \"$1\" = \"pr\" ] && [ \"$2\" = \"list\" ]; then",
    `  printf '%s\\n' '${prsJson.replaceAll("'", "'\\''")}'`,
    "  exit 0",
    "fi",
    "if [ \"$1\" = \"pr\" ] && [ \"$2\" = \"view\" ]; then",
    `  printf '%s\\n' '${prsJson.replaceAll("'", "'\\''")}' | node -e 'const fs=require("fs"); const prs=JSON.parse(fs.readFileSync(0,"utf8")); const url=process.argv[1]; const pr=prs.find((p)=>p.url===url); if (!pr) process.exit(1); console.log(JSON.stringify(pr));' "$3"`,
    "  exit 0",
    "fi",
    "echo unexpected gh invocation >&2",
    "exit 1",
    "",
  ].join("\n"), "utf-8");
  chmodSync(ghPath, 0o755);
  const previousPath = process.env.PATH ?? "";
  process.env.PATH = `${dir}:${previousPath}`;
  return previousPath;
}

afterEach(() => {
  setSessionManager(null);
});

describe("agent_worktree_status", () => {
  it("treats missing or null params as listing all worktrees", async () => {
    setSessionManager({
      list: () => [],
      listPersistedSessions: () => [],
    } as any);

    const tool = makeAgentWorktreeStatusTool();
    for (const params of [undefined, null] as const) {
      const result = await tool.execute("tool-id", params);
      assert.equal((result.content[0] as { text: string }).text, "No sessions with worktrees found.");
    }
  });

  it("returns an error for malformed params without throwing", async () => {
    setSessionManager({
      list: () => [],
      listPersistedSessions: () => [],
    } as any);

    const tool = makeAgentWorktreeStatusTool();
    for (const params of ["bad", { session: 42 }, []] as const) {
      const result = await tool.execute("tool-id", params);
      assert.equal((result.content[0] as { text: string }).text, "Error: Invalid parameters. Expected { session? }.");
    }
  });

  it("renders derived released lifecycle details from repository evidence", async () => {
    const repoDir = initRepo("status-released-");
    try {
      const released = createCommittedWorktree(repoDir, "released-status", "feature.txt", "released\n");
      const releasedCommit = git(released.worktreePath, "rev-parse", "HEAD");
      git(repoDir, "checkout", "main");
      writeFileSync(join(repoDir, "main-only.txt"), "main first\n", "utf-8");
      git(repoDir, "add", "main-only.txt");
      git(repoDir, "commit", "-m", "main diverges");
      git(repoDir, "cherry-pick", releasedCommit);

      const persisted = {
        sessionId: "s-released-status",
        harnessSessionId: "h-released-status",
        name: "released-status",
        prompt: "released",
        workdir: repoDir,
        status: "completed",
        costUsd: 0,
        worktreePath: released.worktreePath,
        worktreeBranch: released.branchName,
        worktreeBaseBranch: "main",
        worktreeLifecycle: {
          state: "pending_decision",
          updatedAt: new Date().toISOString(),
          baseBranch: "main",
        },
      };

      setSessionManager({
        list: () => [],
        resolve: () => undefined,
        listPersistedSessions: () => [persisted] as any,
        getPersistedSession(ref: string) {
          return [persisted].find((session) =>
            session.sessionId === ref || session.harnessSessionId === ref || session.name === ref
          ) as any;
        },
      } as any);

      const tool = makeAgentWorktreeStatusTool();
      const result = await tool.execute("tool-id", { session: "released-status" });
      const text = (result.content[0] as { text: string }).text;

      assert.match(text, /Session: released-status \[s-released-status\]/);
      assert.match(text, /Lifecycle:\s*needs decision/);
      assert.match(text, /Derived:\s*released/);
      assert.match(text, /Cleanup:\s*safe now/);
      assert.match(text, /Ahead:\s*\d+ ahead \/ \d+ behind/);
      assert.match(text, /Reasons:\s*pending decision, content already on base/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("renders merge-conflict-resolving worktrees as preserved conflict resolution state", async () => {
    const repoDir = initRepo("status-conflict-resolving-");
    try {
      const conflicted = createCommittedWorktree(repoDir, "conflict-resolving-status", "feature.txt", "resolver\n");

      const persisted = {
        sessionId: "s-conflict-resolving",
        harnessSessionId: "h-conflict-resolving",
        name: "conflict-resolving-status",
        prompt: "resolve the merge conflict",
        workdir: repoDir,
        status: "completed",
        costUsd: 0,
        worktreePath: conflicted.worktreePath,
        worktreeBranch: conflicted.branchName,
        worktreeBaseBranch: "main",
        worktreeLifecycle: {
          state: "merge_conflict_resolving",
          updatedAt: new Date().toISOString(),
          baseBranch: "main",
        },
      };

      setSessionManager({
        list: () => [],
        resolve: () => undefined,
        listPersistedSessions: () => [persisted] as any,
        getPersistedSession(ref: string) {
          return [persisted].find((session) =>
            session.sessionId === ref || session.harnessSessionId === ref || session.name === ref
          ) as any;
        },
      } as any);

      const tool = makeAgentWorktreeStatusTool();
      const result = await tool.execute("tool-id", { session: "conflict-resolving-status" });
      const text = (result.content[0] as { text: string }).text;

      assert.match(text, /Lifecycle:\s*conflict resolving/);
      assert.match(text, /Cleanup:\s*preserve/);
      assert.match(text, /Reasons:\s*conflict resolving, still has unique content/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("refreshes closed helper PR state and marks represented helper branches safe for cleanup", async () => {
    const repoDir = initRepo("status-closed-helper-pr-");
    const fakeGhDir = mkdtempSync(join(tmpdir(), "fake-gh-"));
    const previousPath = installFakeGh(fakeGhDir, JSON.stringify([
      {
        url: "https://github.com/goldmar/openclaw-code-agent/pull/315",
        number: 315,
        title: "Address PR 314 review feedback",
        state: "CLOSED",
        headRepositoryOwner: { login: "goldmar" },
        headRefName: "agent/pr-314-comments-cleanup",
        baseRefName: "main",
      },
      {
        url: "https://github.com/goldmar/openclaw-code-agent/pull/314",
        number: 314,
        title: "Fix test session store isolation",
        state: "OPEN",
        headRepositoryOwner: { login: "goldmar" },
        headRefName: "fix-test-session-store-isolation",
        baseRefName: "main",
      },
    ]));
    try {
      git(repoDir, "remote", "add", "origin", "https://github.com/goldmar/openclaw-code-agent.git");
      git(repoDir, "checkout", "-b", "fix-test-session-store-isolation");
      writeFileSync(join(repoDir, "session-store.txt"), "pr 314\n", "utf-8");
      git(repoDir, "add", "session-store.txt");
      git(repoDir, "commit", "-m", "Fix test session store isolation");

      const helper = createCommittedWorktree(repoDir, "pr-314-comments-cleanup", "cleanup.txt", "commit 7f50458\n");
      const helperCommit = git(helper.worktreePath, "rev-parse", "HEAD");
      git(repoDir, "checkout", "fix-test-session-store-isolation");
      git(repoDir, "cherry-pick", helperCommit);

      const persisted = {
        sessionId: "s-pr-314-comments-cleanup",
        harnessSessionId: "h-pr-314-comments-cleanup",
        name: "pr-314-comments-cleanup",
        prompt: "address PR 314 review feedback",
        workdir: repoDir,
        status: "completed",
        costUsd: 0,
        worktreePath: helper.worktreePath,
        worktreeBranch: helper.branchName,
        worktreeBaseBranch: "main",
        worktreeState: "pr_open",
        worktreePrUrl: "https://github.com/goldmar/openclaw-code-agent/pull/314",
        worktreePrNumber: 314,
        worktreeLifecycle: {
          state: "pr_open",
          updatedAt: new Date().toISOString(),
          baseBranch: "main",
          targetRepo: "goldmar/openclaw-code-agent",
        },
      };

      setSessionManager({
        list: () => [],
        resolve: () => undefined,
        listPersistedSessions: () => [persisted] as any,
        getPersistedSession(ref: string) {
          return [persisted].find((session) =>
            session.sessionId === ref || session.harnessSessionId === ref || session.name === ref
          ) as any;
        },
        updatePersistedSession(ref: string, patch: Record<string, unknown>) {
          if (ref === persisted.sessionId || ref === persisted.harnessSessionId || ref === persisted.name) {
            Object.assign(persisted, patch);
            return true;
          }
          return false;
        },
        dismissWorktree: async () => "dismissed",
      } as any);

      const statusTool = makeAgentWorktreeStatusTool();
      const statusResult = await statusTool.execute("tool-id", { session: "pr-314-comments-cleanup" });
      const statusText = (statusResult.content[0] as { text: string }).text;

      assert.match(statusText, /Lifecycle:\s*pr open/);
      assert.match(statusText, /Derived:\s*released/);
      assert.match(statusText, /Cleanup:\s*safe now/);
      assert.match(statusText, /PR:\s*https:\/\/github\.com\/goldmar\/openclaw-code-agent\/pull\/315 \(closed\)/);
      assert.match(statusText, /Reasons:\s*represented by fix-test-session-store-isolation, stale PR-open metadata/);

      const cleanupTool = makeAgentWorktreeCleanupTool();
      const cleanupResult = await cleanupTool.execute("tool-id", { mode: "clean_safe", session: "pr-314-comments-cleanup" });
      const cleanupText = (cleanupResult.content[0] as { text: string }).text;

      assert.match(cleanupText, /SAFE FOUND \(1\): pr-314-comments-cleanup \(released\)/);
      assert.match(cleanupText, /CLEANED \(1\): pr-314-comments-cleanup \(released\)/);
      assert.equal(existsSync(helper.worktreePath), false);
      assert.throws(() => git(repoDir, "rev-parse", "--verify", helper.branchName), /fatal:/);
      assert.equal(persisted.worktreePath, undefined);
      assert.equal(persisted.worktreeBranch, undefined);
      assert.equal(persisted.worktreeState, "none");
      assert.equal(persisted.worktreeLifecycle?.state, "released");
      assert.ok((persisted.worktreeLifecycle?.notes ?? []).includes("released_by_branch:fix-test-session-store-isolation"));
    } finally {
      process.env.PATH = previousPath;
      rmSync(fakeGhDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe("agent_worktree_cleanup", () => {
  it("preview_all reports safe released worktrees and kept unresolved worktrees with reasons", async () => {
    const repoDir = initRepo("cleanup-preview-");
    try {
      const released = createCommittedWorktree(repoDir, "released-branch", "feature.txt", "released\n");
      const releasedCommit = git(released.worktreePath, "rev-parse", "HEAD");
      git(repoDir, "checkout", "main");
      writeFileSync(join(repoDir, "main-only.txt"), "main first\n", "utf-8");
      git(repoDir, "add", "main-only.txt");
      git(repoDir, "commit", "-m", "main diverges");
      git(repoDir, "cherry-pick", releasedCommit);

      const unique = createCommittedWorktree(repoDir, "unique-branch", "unique.txt");
      git(repoDir, "checkout", "main");

      const persisted = [
        {
          sessionId: "s-released",
          harnessSessionId: "h-released",
          name: "released-task",
          prompt: "released",
          workdir: repoDir,
          status: "completed",
          costUsd: 0,
          worktreePath: released.worktreePath,
          worktreeBranch: released.branchName,
          worktreeBaseBranch: "main",
          worktreeLifecycle: {
            state: "released",
            updatedAt: new Date().toISOString(),
            baseBranch: "main",
          },
        },
        {
          sessionId: "s-unique",
          harnessSessionId: "h-unique",
          name: "unique-task",
          prompt: "unique",
          workdir: repoDir,
          status: "completed",
          costUsd: 0,
          worktreePath: unique.worktreePath,
          worktreeBranch: unique.branchName,
          worktreeBaseBranch: "main",
          worktreeLifecycle: {
            state: "pending_decision",
            updatedAt: new Date().toISOString(),
            baseBranch: "main",
          },
        },
      ];

      setSessionManager({
        list: () => [],
        resolve(ref: string) {
          if (ref === "s-unique") {
            return { id: "s-unique", name: "unique-task", status: "running", worktreePath: unique.worktreePath } as any;
          }
          return undefined;
        },
        listPersistedSessions: () => persisted as any,
        getPersistedSession(ref: string) {
          return persisted.find((session) =>
            session.sessionId === ref || session.harnessSessionId === ref || session.name === ref
          ) as any;
        },
        updatePersistedSession() { return true; },
        dismissWorktree: async () => "dismissed",
      } as any);

      const tool = makeAgentWorktreeCleanupTool();
      const result = await tool.execute("tool-id", { mode: "preview_all" });
      const text = (result.content[0] as { text: string }).text;

      assert.match(text, /Worktree lifecycle review:/);
      assert.match(text, /SAFE NOW \(1\): released-task \(released\)/);
      assert.match(text, /KEPT \(1\): unique-task \[kept: .*active session.*pending decision.*still has unique content/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("clean_safe removes merged worktrees and preserves legacy merged resolved timestamps", async () => {
    const repoDir = initRepo("cleanup-exec-");
    try {
      const merged = createCommittedWorktree(repoDir, "merged-clean", "feature.txt", "merged\n");
      git(repoDir, "checkout", "main");
      git(repoDir, "merge", "--ff-only", merged.branchName);
      const legacyResolvedAt = "2024-02-03T04:05:06.000Z";

      const persisted = {
        sessionId: "s-clean",
        harnessSessionId: "h-clean",
        name: "merged-clean",
        prompt: "merged",
        workdir: repoDir,
        status: "completed",
        costUsd: 0,
        worktreePath: merged.worktreePath,
        worktreeBranch: merged.branchName,
        worktreeBaseBranch: "main",
        worktreeState: "ready",
        worktreeMergedAt: legacyResolvedAt,
        pendingWorktreeDecisionSince: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
        lastWorktreeReminderAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        worktreeDecisionSnoozedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        worktreeLifecycle: {
          state: "active",
          updatedAt: new Date().toISOString(),
          baseBranch: "main",
        },
      };

      setSessionManager({
        list: () => [],
        resolve: () => undefined,
        listPersistedSessions: () => [persisted] as any,
        getPersistedSession(ref: string) {
          return [persisted].find((session) =>
            session.sessionId === ref || session.harnessSessionId === ref || session.name === ref
          ) as any;
        },
        updatePersistedSession(ref: string, patch: Record<string, unknown>) {
          if (ref === persisted.sessionId || ref === persisted.harnessSessionId || ref === persisted.name) {
            Object.assign(persisted, patch);
            return true;
          }
          return false;
        },
        dismissWorktree: async () => "dismissed",
      } as any);

      const tool = makeAgentWorktreeCleanupTool();
      const result = await tool.execute("tool-id", { mode: "clean_safe" });
      const text = (result.content[0] as { text: string }).text;

      assert.match(text, /Clean all safe:/);
      assert.match(text, /SAFE FOUND \(1\): merged-clean \(merged\)/);
      assert.match(text, /CLEANED \(1\): merged-clean \(merged\)/);
      assert.equal(existsSync(merged.worktreePath), false);
      assert.throws(() => git(repoDir, "rev-parse", "--verify", merged.branchName), /fatal:/);
      assert.equal(persisted.worktreePath, undefined);
      assert.equal(persisted.worktreeBranch, undefined);
      assert.equal(persisted.worktreeState, "none");
      assert.equal(persisted.pendingWorktreeDecisionSince, undefined);
      assert.equal(persisted.lastWorktreeReminderAt, undefined);
      assert.equal(persisted.worktreeDecisionSnoozedUntil, undefined);
      assert.equal(persisted.worktreeMerged, true);
      assert.equal(persisted.worktreeMergedAt, legacyResolvedAt);
      assert.equal(persisted.worktreeLifecycle?.state, "merged");
      assert.equal(persisted.worktreeLifecycle?.resolvedAt, legacyResolvedAt);
      assert.equal(persisted.worktreeLifecycle?.resolutionSource, "maintenance");
      assert.ok((persisted.worktreeLifecycle?.notes ?? []).includes("topology_merged"));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("clean_safe removes released worktrees and clears persisted worktree metadata", async () => {
    const repoDir = initRepo("cleanup-released-");
    try {
      const released = createCommittedWorktree(repoDir, "released-clean", "feature.txt", "released\n");
      const releasedCommit = git(released.worktreePath, "rev-parse", "HEAD");
      git(repoDir, "checkout", "main");
      writeFileSync(join(repoDir, "main-only.txt"), "main first\n", "utf-8");
      git(repoDir, "add", "main-only.txt");
      git(repoDir, "commit", "-m", "main diverges");
      git(repoDir, "cherry-pick", releasedCommit);

      const persisted = {
        sessionId: "s-released-clean",
        harnessSessionId: "h-released-clean",
        name: "released-clean",
        prompt: "released",
        workdir: repoDir,
        status: "completed",
        costUsd: 0,
        worktreePath: released.worktreePath,
        worktreeBranch: released.branchName,
        worktreeBaseBranch: "main",
        worktreeState: "ready",
        pendingWorktreeDecisionSince: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
        lastWorktreeReminderAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        worktreeDecisionSnoozedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        worktreeLifecycle: {
          state: "active",
          updatedAt: new Date().toISOString(),
          baseBranch: "main",
        },
      };

      setSessionManager({
        list: () => [],
        resolve: () => undefined,
        listPersistedSessions: () => [persisted] as any,
        getPersistedSession(ref: string) {
          return [persisted].find((session) =>
            session.sessionId === ref || session.harnessSessionId === ref || session.name === ref
          ) as any;
        },
        updatePersistedSession(ref: string, patch: Record<string, unknown>) {
          if (ref === persisted.sessionId || ref === persisted.harnessSessionId || ref === persisted.name) {
            Object.assign(persisted, patch);
            return true;
          }
          return false;
        },
        dismissWorktree: async () => "dismissed",
      } as any);

      const tool = makeAgentWorktreeCleanupTool();
      const result = await tool.execute("tool-id", { mode: "clean_safe" });
      const text = (result.content[0] as { text: string }).text;

      assert.match(text, /Clean all safe:/);
      assert.match(text, /SAFE FOUND \(1\): released-clean \(released\)/);
      assert.match(text, /CLEANED \(1\): released-clean \(released\)/);
      assert.equal(existsSync(released.worktreePath), false);
      assert.throws(() => git(repoDir, "rev-parse", "--verify", released.branchName), /fatal:/);
      assert.equal(persisted.worktreePath, undefined);
      assert.equal(persisted.worktreeBranch, undefined);
      assert.equal(persisted.worktreeState, "none");
      assert.equal(persisted.pendingWorktreeDecisionSince, undefined);
      assert.equal(persisted.lastWorktreeReminderAt, undefined);
      assert.equal(persisted.worktreeDecisionSnoozedUntil, undefined);
      assert.equal(persisted.worktreeLifecycle?.state, "released");
      assert.equal(typeof persisted.worktreeLifecycle?.resolvedAt, "string");
      assert.equal(persisted.worktreeLifecycle?.resolutionSource, "maintenance");
      assert.ok((persisted.worktreeLifecycle?.notes ?? []).includes("merge_noop_content_already_on_base"));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("clean_safe preserves legacy dismissed timestamps only for dismissed cleanup", async () => {
    const repoDir = initRepo("cleanup-dismissed-");
    try {
      const dismissed = createCommittedWorktree(repoDir, "dismissed-clean", "feature.txt", "dismissed\n");
      const legacyMergedAt = "2024-01-02T03:04:05.000Z";
      const legacyDismissedAt = "2024-02-03T04:05:06.000Z";

      const persisted = {
        sessionId: "s-dismissed-clean",
        harnessSessionId: "h-dismissed-clean",
        name: "dismissed-clean",
        prompt: "dismissed",
        workdir: repoDir,
        status: "completed",
        costUsd: 0,
        worktreePath: dismissed.worktreePath,
        worktreeBranch: dismissed.branchName,
        worktreeBaseBranch: "main",
        worktreeState: "ready",
        worktreeMergedAt: legacyMergedAt,
        worktreeDismissedAt: legacyDismissedAt,
        worktreeLifecycle: {
          state: "dismissed",
          updatedAt: new Date().toISOString(),
          baseBranch: "main",
        },
      };

      setSessionManager({
        list: () => [],
        resolve: () => undefined,
        listPersistedSessions: () => [persisted] as any,
        getPersistedSession(ref: string) {
          return [persisted].find((session) =>
            session.sessionId === ref || session.harnessSessionId === ref || session.name === ref
          ) as any;
        },
        updatePersistedSession(ref: string, patch: Record<string, unknown>) {
          if (ref === persisted.sessionId || ref === persisted.harnessSessionId || ref === persisted.name) {
            Object.assign(persisted, patch);
            return true;
          }
          return false;
        },
        dismissWorktree: async () => "dismissed",
      } as any);

      const tool = makeAgentWorktreeCleanupTool();
      const result = await tool.execute("tool-id", { mode: "clean_safe" });
      const text = (result.content[0] as { text: string }).text;

      assert.match(text, /Clean all safe:/);
      assert.match(text, /SAFE FOUND \(1\): dismissed-clean \(dismissed\)/);
      assert.match(text, /CLEANED \(1\): dismissed-clean \(dismissed\)/);
      assert.equal(existsSync(dismissed.worktreePath), false);
      assert.throws(() => git(repoDir, "rev-parse", "--verify", dismissed.branchName), /fatal:/);
      assert.equal(persisted.worktreePath, undefined);
      assert.equal(persisted.worktreeBranch, undefined);
      assert.equal(persisted.worktreeState, "none");
      assert.equal(persisted.worktreeLifecycle?.state, "dismissed");
      assert.equal(persisted.worktreeLifecycle?.resolvedAt, legacyDismissedAt);
      assert.notEqual(persisted.worktreeLifecycle?.resolvedAt, legacyMergedAt);
      assert.equal(persisted.worktreeLifecycle?.resolutionSource, "maintenance");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
