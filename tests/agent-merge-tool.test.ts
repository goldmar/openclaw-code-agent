import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setSessionManager } from "../src/singletons";
import { SessionNotificationService } from "../src/session-notifications";
import { makeAgentMergeTool } from "../src/tools/agent-merge";
import { createWorktree, getBranchName } from "../src/worktree";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

function createRepoWithRemote(prefix: string): { repoDir: string; remoteDir: string } {
  const repoDir = mkdtempSync(join(tmpdir(), `${prefix}-repo-`));
  const remoteDir = mkdtempSync(join(tmpdir(), `${prefix}-remote-`));

  git(remoteDir, "init", "--bare");
  git(repoDir, "init", "-b", "main");
  git(repoDir, "config", "user.name", "Test User");
  git(repoDir, "config", "user.email", "test@example.com");
  writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
  git(repoDir, "add", "README.md");
  git(repoDir, "commit", "-m", "init");
  git(repoDir, "remote", "add", "origin", remoteDir);
  git(repoDir, "push", "-u", "origin", "main");

  return { repoDir, remoteDir };
}

function createCommittedWorktree(repoDir: string, name: string): { worktreePath: string; branchName: string } {
  const worktreePath = createWorktree(repoDir, name);
  const branchName = getBranchName(worktreePath);
  assert.ok(branchName, "worktree branch should exist");

  writeFileSync(join(worktreePath, "feature.txt"), `${name}\n`, "utf-8");
  git(worktreePath, "add", "feature.txt");
  git(worktreePath, "commit", "-m", `feat: ${name}`);

  return { worktreePath, branchName };
}

function createReadmeChangingWorktree(repoDir: string, name: string): { worktreePath: string; branchName: string } {
  const worktreePath = createWorktree(repoDir, name);
  const branchName = getBranchName(worktreePath);
  assert.ok(branchName, "worktree branch should exist");

  writeFileSync(join(worktreePath, "README.md"), `${name}\n`, "utf-8");
  git(worktreePath, "add", "README.md");
  git(worktreePath, "commit", "-m", `feat: ${name}`);

  return { worktreePath, branchName };
}

function remoteHead(repoDir: string, branch: string): string {
  const output = git(repoDir, "ls-remote", "--heads", "origin", branch);
  return output.split(/\s+/)[0] ?? "";
}

function installPersistedSessionWithNotificationService(args: {
  sessionName: string;
  repoDir: string;
  worktreePath: string;
  branchName: string;
  wakeOutcome: "success" | "failure";
  capturedRequests: any[];
}): Record<string, any> {
  const persistedSession: Record<string, any> = {
    sessionId: `s-${args.sessionName}`,
    harnessSessionId: `h-${args.sessionName}`,
    backendRef: { kind: "codex-app-server", conversationId: `thread-${args.sessionName}` },
    name: args.sessionName,
    prompt: "test",
    workdir: args.repoDir,
    worktreePath: args.worktreePath,
    worktreeBranch: args.branchName,
    worktreeState: "pending_decision",
    pendingWorktreeDecisionSince: "2026-06-01T22:51:00.000Z",
    status: "completed",
    costUsd: 0,
    route: {
      provider: "telegram",
      target: "-1003863755361",
      threadId: "13832",
      sessionKey: "agent:main:telegram:group:-1003863755361:topic:13832",
    },
    originChannel: "telegram|-1003863755361",
    originThreadId: 13832,
    originSessionKey: "agent:main:telegram:group:-1003863755361:topic:13832",
  };

  const matchesRef = (ref: string): boolean => [
    persistedSession.sessionId,
    persistedSession.name,
    persistedSession.harnessSessionId,
    persistedSession.backendRef.conversationId,
  ].includes(ref);

  const updatePersistedSession = (ref: string, patch: Record<string, unknown>) => {
    assert.ok(matchesRef(ref), `unexpected persisted ref ${ref}`);
    Object.assign(persistedSession, patch);
  };

  const notificationService = new SessionNotificationService(
    {
      dispatchSessionNotification: (session: unknown, request: { hooks?: Record<string, () => void> }) => {
        args.capturedRequests.push({ session, request });
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifySucceeded?.();
        request.hooks?.onWakeStarted?.();
        if (args.wakeOutcome === "success") {
          request.hooks?.onWakeSucceeded?.();
        } else {
          request.hooks?.onWakeFailed?.();
        }
      },
      dispose: () => {},
    } as any,
    updatePersistedSession,
  );

  setSessionManager({
    resolve: () => undefined,
    getPersistedSession(ref: string) {
      return matchesRef(ref) ? persistedSession as any : undefined;
    },
    enqueueMerge: async (_repoDir: string, fn: () => Promise<void>) => { await fn(); },
    updatePersistedSession,
    notifyWorktreeOutcome(session: unknown, outcomeLine: string, options?: unknown) {
      notificationService.notifyWorktreeOutcome(session as any, outcomeLine, options as any);
    },
    spawn() {
      throw new Error("conflict resolver should not be spawned in this test");
    },
  } as any);

  return persistedSession;
}

function installPersistedSessionStub(
  sessionName: string,
  repoDir: string,
  worktreePath: string,
  branchName: string,
  notifications: Array<{ session: unknown; outcomeLine: string; options?: unknown }> = [],
): Record<string, unknown> {
  const persistedSession: Record<string, unknown> = {
    harnessSessionId: `h-${sessionName}`,
    name: sessionName,
    prompt: "test",
    workdir: repoDir,
    worktreePath,
    worktreeBranch: branchName,
    status: "completed",
    costUsd: 0,
  };

  setSessionManager({
    resolve: () => undefined,
    getPersistedSession(ref: string) {
      if (ref === sessionName || ref === persistedSession.harnessSessionId) return persistedSession as any;
      return undefined;
    },
    enqueueMerge: async (_repoDir: string, fn: () => Promise<void>) => { await fn(); },
    updatePersistedSession(_id: string, patch: Record<string, unknown>) {
      Object.assign(persistedSession, patch);
    },
    notifyWorktreeOutcome(session: unknown, outcomeLine: string, options?: unknown) {
      notifications.push({ session, outcomeLine, options });
    },
    spawn() {
      throw new Error("conflict resolver should not be spawned in this test");
    },
  } as any);
  return persistedSession;
}

afterEach(() => {
  setSessionManager(null);
});

describe("agent_merge push behavior", () => {
  it("blocks dirty uncommitted worktrees that have no commits to merge", async () => {
    const { repoDir, remoteDir } = createRepoWithRemote("agent-merge-dirty");
    try {
      const sessionName = "merge-dirty";
      const worktreePath = createWorktree(repoDir, sessionName);
      const branchName = getBranchName(worktreePath);
      assert.ok(branchName, "worktree branch should exist");
      writeFileSync(join(worktreePath, "feature.txt"), "not committed\n", "utf-8");
      installPersistedSessionStub(sessionName, repoDir, worktreePath, branchName);

      const tool = makeAgentMergeTool();
      const result = await tool.execute("tool-id", { session: sessionName });

      assert.match((result.content[0] as { text: string }).text, /Merge blocked/i);
      assert.match((result.content[0] as { text: string }).text, /uncommitted worktree changes/i);
      assert.equal(git(repoDir, "rev-parse", "main"), remoteHead(repoDir, "main"));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(remoteDir, { recursive: true, force: true });
    }
  });

  it("returns already merged before dirty/no-commit merge blocking", async () => {
    const { repoDir, remoteDir } = createRepoWithRemote("agent-merge-already-dirty");
    try {
      const sessionName = "merge-already-dirty";
      const worktreePath = createWorktree(repoDir, sessionName);
      const branchName = getBranchName(worktreePath);
      assert.ok(branchName, "worktree branch should exist");
      writeFileSync(join(worktreePath, "feature.txt"), "not committed\n", "utf-8");
      const persistedSession = installPersistedSessionStub(sessionName, repoDir, worktreePath, branchName);
      persistedSession.worktreeMerged = true;

      const tool = makeAgentMergeTool();
      const result = await tool.execute("tool-id", { session: sessionName });

      assert.match((result.content[0] as { text: string }).text, /already merged/i);
      assert.doesNotMatch((result.content[0] as { text: string }).text, /Merge blocked/i);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(remoteDir, { recursive: true, force: true });
    }
  });

  it("keeps the merged base branch local by default", async () => {
    const { repoDir, remoteDir } = createRepoWithRemote("agent-merge-default");
    try {
      const sessionName = "merge-default";
      const { worktreePath, branchName } = createCommittedWorktree(repoDir, sessionName);
      installPersistedSessionStub(sessionName, repoDir, worktreePath, branchName);

      const initialRemoteMain = remoteHead(repoDir, "main");
      const tool = makeAgentMergeTool();
      const result = await tool.execute("tool-id", { session: sessionName, delete_branch: false });

      assert.match((result.content[0] as { text: string }).text, /Fast-forward|Merge commit/);
      assert.doesNotMatch((result.content[0] as { text: string }).text, /Pushed\./);
      assert.equal(remoteHead(repoDir, "main"), initialRemoteMain);
      assert.notEqual(git(repoDir, "rev-parse", "main"), initialRemoteMain);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(remoteDir, { recursive: true, force: true });
    }
  });

  it("records immediate merge outcome wake success against the persisted origin route", async () => {
    const { repoDir, remoteDir } = createRepoWithRemote("agent-merge-wake-success");
    try {
      const sessionName = "merge-wake-success";
      const { worktreePath, branchName } = createCommittedWorktree(repoDir, sessionName);
      const capturedRequests: any[] = [];
      const persistedSession = installPersistedSessionWithNotificationService({
        sessionName,
        repoDir,
        worktreePath,
        branchName,
        wakeOutcome: "success",
        capturedRequests,
      });

      const tool = makeAgentMergeTool();
      const result = await tool.execute("tool-id", { session: sessionName, delete_branch: false });

      assert.match((result.content[0] as { text: string }).text, /Fast-forward|Merge commit/);
      assert.equal(capturedRequests.length, 1);
      assert.equal(capturedRequests[0].request.deferConditionalWakeUntilNextTick, true);
      assert.equal(capturedRequests[0].request.completionWakeSummaryRequired, true);
      assert.match(capturedRequests[0].request.wakeMessageOnNotifySuccess, /Session origin route \(authoritative for human follow-ups\):/);
      assert.match(capturedRequests[0].request.wakeMessageOnNotifySuccess, /"target":"-1003863755361"/);
      assert.match(capturedRequests[0].request.wakeMessageOnNotifySuccess, /"threadId":"13832"/);
      assert.match(capturedRequests[0].request.wakeMessageOnNotifySuccess, /"sessionKey":"agent:main:telegram:group:-1003863755361:topic:13832"/);
      assert.equal(persistedSession.worktreeMerged, true);
      assert.equal(persistedSession.worktreeState, "merged");
      assert.equal(persistedSession.pendingWorktreeDecisionSince, undefined);
      assert.equal(persistedSession.deliveryState, "idle");
      assert.equal(persistedSession.completionWakeSummaryRequired, undefined);
      assert.equal(typeof persistedSession.completionWakeIssuedAt, "string");
      assert.equal(typeof persistedSession.completionWakeSucceededAt, "string");
      assert.equal(persistedSession.completionWakeFailedAt, undefined);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(remoteDir, { recursive: true, force: true });
    }
  });

  it("leaves the merge outcome summary repair flag durable when the immediate wake fails", async () => {
    const { repoDir, remoteDir } = createRepoWithRemote("agent-merge-wake-failure");
    try {
      const sessionName = "merge-wake-failure";
      const { worktreePath, branchName } = createCommittedWorktree(repoDir, sessionName);
      const capturedRequests: any[] = [];
      const persistedSession = installPersistedSessionWithNotificationService({
        sessionName,
        repoDir,
        worktreePath,
        branchName,
        wakeOutcome: "failure",
        capturedRequests,
      });

      const tool = makeAgentMergeTool();
      const result = await tool.execute("tool-id", { session: sessionName, delete_branch: false });

      assert.match((result.content[0] as { text: string }).text, /Fast-forward|Merge commit/);
      assert.equal(capturedRequests.length, 1);
      assert.equal(capturedRequests[0].request.deferConditionalWakeUntilNextTick, true);
      assert.equal(persistedSession.worktreeMerged, true);
      assert.equal(persistedSession.worktreeState, "merged");
      assert.equal(persistedSession.deliveryState, "failed");
      assert.equal(persistedSession.completionWakeSummaryRequired, true);
      assert.equal(typeof persistedSession.completionWakeIssuedAt, "string");
      assert.equal(persistedSession.completionWakeSucceededAt, undefined);
      assert.equal(typeof persistedSession.completionWakeFailedAt, "string");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(remoteDir, { recursive: true, force: true });
    }
  });

  it("pushes the merged base branch only when push=true is requested", async () => {
    const { repoDir, remoteDir } = createRepoWithRemote("agent-merge-push");
    try {
      const sessionName = "merge-push";
      const { worktreePath, branchName } = createCommittedWorktree(repoDir, sessionName);
      installPersistedSessionStub(sessionName, repoDir, worktreePath, branchName);

      const tool = makeAgentMergeTool();
      const result = await tool.execute("tool-id", { session: sessionName, push: true, delete_branch: false });

      assert.match((result.content[0] as { text: string }).text, /Pushed\./);
      assert.equal(remoteHead(repoDir, "main"), git(repoDir, "rev-parse", "main"));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(remoteDir, { recursive: true, force: true });
    }
  });

  it("notifies with a summary wake when local merge succeeds but push fails", async () => {
    const { repoDir, remoteDir } = createRepoWithRemote("agent-merge-push-fail");
    try {
      const sessionName = "merge-push-fail";
      const { worktreePath, branchName } = createCommittedWorktree(repoDir, sessionName);
      const notifications: Array<{ session: unknown; outcomeLine: string; options?: any }> = [];
      installPersistedSessionStub(sessionName, repoDir, worktreePath, branchName, notifications);
      git(repoDir, "remote", "set-url", "origin", join(tmpdir(), "missing-openclaw-remote.git"));

      const tool = makeAgentMergeTool();
      const result = await tool.execute("tool-id", { session: sessionName, push: true, delete_branch: false });

      assert.match((result.content[0] as { text: string }).text, /locally, but failed to push main/);
      assert.equal(notifications.length, 1);
      assert.match(notifications[0].outcomeLine, /Merged .* locally, but failed to push main/);
      assert.match(String(notifications[0].options?.detailLines?.join("\n")), /remote state may not include the merge/i);
      assert.equal(git(repoDir, "rev-parse", "main"), git(repoDir, "rev-parse", branchName));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(remoteDir, { recursive: true, force: true });
    }
  });

  it("includes stash-pop-conflict details in successful manual merge summary wake details", async () => {
    const { repoDir, remoteDir } = createRepoWithRemote("agent-merge-stash-conflict");
    try {
      const sessionName = "merge-stash-conflict";
      const { worktreePath, branchName } = createReadmeChangingWorktree(repoDir, sessionName);
      const notifications: Array<{ session: unknown; outcomeLine: string; options?: any }> = [];
      installPersistedSessionStub(sessionName, repoDir, worktreePath, branchName, notifications);
      writeFileSync(join(repoDir, "README.md"), "local dirty base change\n", "utf-8");

      const tool = makeAgentMergeTool();
      const result = await tool.execute("tool-id", { session: sessionName, delete_branch: false });

      assert.match((result.content[0] as { text: string }).text, /Pre-merge stash pop conflicted/);
      assert.equal(notifications.length, 1);
      assert.match(String(notifications[0].options?.detailLines?.join("\n")), /Pre-merge stash pop conflicted/);
      assert.match(String(notifications[0].options?.detailLines?.join("\n")), /git stash show stash@\{0\}/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(remoteDir, { recursive: true, force: true });
    }
  });
});
