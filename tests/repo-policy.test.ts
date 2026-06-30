import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectRepoProvider,
  normalizeRemoteUrl,
  resolveAllowedWorktreeActions,
  resolveWorktreePolicyDecision,
  seededRepoPolicy,
  resolveRepoIdentity,
} from "../src/repo-policy";
import { setPluginConfig } from "../src/config";
import { SessionWorktreeActionService } from "../src/session-worktree-action-service";
import { createWorktree, getBranchName } from "../src/worktree";
import { SessionManager } from "../src/session-manager";
import { CALLBACK_NAMESPACE } from "../src/interactive-constants";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function repoPolicyButtonTokenIds(request: { buttons: Array<Array<{ callbackData: string }>> }): string[] {
  return request.buttons.flatMap((row) => row.map((button) => button.callbackData));
}

function createRepoWithWorktree(name: string) {
  const repoDir = mkdtempSync(join(tmpdir(), `openclaw-policy-${name}-`));
  git(repoDir, "init", "-b", "main");
  git(repoDir, "config", "user.name", "Test User");
  git(repoDir, "config", "user.email", "test@example.com");
  writeFileSync(join(repoDir, "README.md"), "base\n", "utf-8");
  git(repoDir, "add", "README.md");
  git(repoDir, "commit", "-m", "init");
  const worktreePath = createWorktree(repoDir, name);
  const branchName = getBranchName(worktreePath);
  assert.ok(branchName);
  writeFileSync(join(worktreePath, "feature.txt"), "feature\n", "utf-8");
  git(worktreePath, "add", "feature.txt");
  git(worktreePath, "commit", "-m", "feature");
  return { repoDir, worktreePath, branchName };
}

describe("repo policy resolution", () => {
  it("normalizes GitHub remotes and detects unsupported providers", () => {
    assert.equal(normalizeRemoteUrl("git@github.com:Goldmar/OpenClaw-Code-Agent.git"), "https://github.com/goldmar/openclaw-code-agent");
    assert.equal(normalizeRemoteUrl("git@github.com:Goldmar/OpenClaw-Code-Agent.git/"), "https://github.com/goldmar/openclaw-code-agent");
    assert.equal(normalizeRemoteUrl("git@github.com:Goldmar/OpenClaw-Code-Agent/"), "https://github.com/goldmar/openclaw-code-agent");
    assert.equal(normalizeRemoteUrl("https://github.com/Goldmar/OpenClaw-Code-Agent.git/"), "https://github.com/goldmar/openclaw-code-agent");
    assert.equal(normalizeRemoteUrl("https://github.com/Goldmar/OpenClaw-Code-Agent/"), "https://github.com/goldmar/openclaw-code-agent");
    assert.equal(detectRepoProvider("https://github.com/goldmar/openclaw-code-agent"), "github");
    assert.equal(detectRepoProvider("https://gitlab.com/example/repo"), "unsupported");
  });

  it("blocks first worktree launch when repo policy is unknown", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-policy-unknown-"));
    const storeDir = mkdtempSync(join(tmpdir(), "openclaw-policy-store-"));
    try {
      git(repoDir, "init", "-b", "main");
      const sm = new SessionManager(1, 10, { store: { indexPath: join(storeDir, "sessions.json") } });
      const result = sm.checkRepoPolicyForLaunch(repoDir, "delegate");
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.text, /Repo integration policy is not set/);
        assert.match(result.text, /agent_repo_policy/);
      }
      sm.dispose();
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it("omits PR policy choices when PR automation is unavailable", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-policy-unsupported-buttons-"));
    const storeDir = mkdtempSync(join(tmpdir(), "openclaw-policy-unsupported-buttons-store-"));
    const dispatchCalls: any[] = [];
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "remote", "add", "origin", "https://gitlab.com/example/repo.git");
      const sm = new SessionManager(1, 10, { store: { indexPath: join(storeDir, "sessions.json") } });
      (sm as any).notifications = {
        dispatch: (...args: any[]) => { dispatchCalls.push(args); },
        notifyWorktreeOutcome: () => {},
        dispose: () => {},
      };

      const result = sm.requestRepoPolicyForLaunch({
        route: {
          provider: "telegram",
          target: "12345",
          threadId: "99",
          sessionKey: "agent:main:telegram:group:12345:topic:99",
        },
        prompt: "Ship isolated changes",
        workdir: repoDir,
        harness: "codex",
        worktreeStrategy: "delegate",
      });

      assert.match(result, /No PR or Manual response/);
      assert.equal(dispatchCalls.length, 1);
      const [, request] = dispatchCalls[0];
      assert.match(request.userMessage, /Provider: unsupported \(PR automation unavailable\)/);
      assert.doesNotMatch(request.userMessage, /Require PR/);
      assert.doesNotMatch(request.userMessage, /Merge or PR/);
      assert.doesNotMatch(request.userMessage, /policy="pr-required"/);
      assert.doesNotMatch(request.userMessage, /policy="pr-allowed"/);
      assert.deepEqual(
        request.buttons.map((row: Array<{ label: string }>) => row.map((button) => button.label)),
        [["No PR", "Manual"]],
      );
      const tokenPolicies = repoPolicyButtonTokenIds(request)
        .map((tokenId) => sm.getActionToken(tokenId)?.repoPolicy);
      assert.deepEqual(tokenPolicies, ["never-pr", "manual"]);
      sm.dispose();
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it("delivers short repo-policy buttons with opaque callback tokens before continuing launch", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-policy-buttons-"));
    const storeDir = mkdtempSync(join(tmpdir(), "openclaw-policy-buttons-store-"));
    const dispatchCalls: any[] = [];
    try {
      git(repoDir, "init", "-b", "main");
      const sm = new SessionManager(1, 10, { store: { indexPath: join(storeDir, "sessions.json") } });
      (sm as any).notifications = {
        dispatch: (...args: any[]) => { dispatchCalls.push(args); },
        notifyWorktreeOutcome: () => {},
        dispose: () => {},
      };

      const result = sm.requestRepoPolicyForLaunch({
        route: {
          provider: "telegram",
          target: "12345",
          threadId: "99",
          sessionKey: "agent:main:telegram:group:12345:topic:99",
        },
        prompt: "Ship isolated changes",
        workdir: repoDir,
        harness: "codex",
        model: "gpt-5.5",
        reasoningEffort: "high",
        fastMode: true,
        resumeWorktreeFrom: "stable-session-1",
        sessionIdOverride: "stable-session-1",
        clearedPersistedCodexResume: true,
        worktreeStrategy: "delegate",
      });

      assert.match(result, /Repo policy choice prompt sent/);
      assert.equal(dispatchCalls.length, 1);
      const [, request] = dispatchCalls[0];
      assert.match(request.userMessage, /continue this launch automatically/);
      assert.deepEqual(
        request.buttons.map((row: Array<{ label: string }>) => row.map((button) => button.label)),
        [["No PR", "Manual"]],
      );
      for (const row of request.buttons as Array<Array<{ label: string; callbackData: string }>>) {
        for (const button of row) {
          assert.ok(button.label.length <= 11, `button label too long: ${button.label}`);
          assert.equal(button.callbackData.includes("pr-required"), false);
          assert.equal(button.callbackData.includes(repoDir), false);
          assert.ok(Buffer.byteLength(`${CALLBACK_NAMESPACE}:${button.callbackData}`, "utf8") <= 64);
        }
      }

      const tokenId = request.buttons[0][0].callbackData;
      const token = sm.getActionToken(tokenId);
      assert.equal(token?.kind, "repo-policy-set");
      assert.equal(token?.repoPolicy, "never-pr");
      assert.equal(token?.launchPrompt, "Ship isolated changes");
      assert.equal(token?.launchWorkdir, repoDir);
      assert.equal(token?.launchModel, "gpt-5.5");
      assert.equal(token?.launchReasoningEffort, "high");
      assert.equal(token?.launchFastMode, true);
      assert.equal(token?.launchResumeWorktreeFrom, "stable-session-1");
      assert.equal(token?.launchSessionIdOverride, "stable-session-1");
      assert.equal(token?.launchClearedPersistedCodexResume, true);
      sm.dispose();
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it("scopes repo-policy prompt idempotency to the deferred launch context", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-policy-idempotency-"));
    const storeDir = mkdtempSync(join(tmpdir(), "openclaw-policy-idempotency-store-"));
    const dispatchCalls: any[] = [];
    try {
      git(repoDir, "init", "-b", "main");
      const sm = new SessionManager(1, 10, { store: { indexPath: join(storeDir, "sessions.json") } });
      (sm as any).notifications = {
        dispatch: (...args: any[]) => { dispatchCalls.push(args); },
        notifyWorktreeOutcome: () => {},
        dispose: () => {},
      };

      const baseLaunch = {
        route: {
          provider: "telegram" as const,
          target: "12345",
          threadId: "99",
          sessionKey: "agent:main:telegram:group:12345:topic:99",
        },
        prompt: "Implement launch A",
        workdir: repoDir,
        name: "launch-a",
        harness: "codex",
        model: "gpt-5.1",
        reasoningEffort: "medium" as const,
        worktreeStrategy: "delegate" as const,
        allowedTools: ["Shell(git status)", "Shell(pnpm test)"],
      };

      sm.requestRepoPolicyForLaunch(baseLaunch);
      sm.requestRepoPolicyForLaunch(baseLaunch);
      sm.requestRepoPolicyForLaunch({
        ...baseLaunch,
        allowedTools: ["Shell(pnpm test)", "Shell(git status)"],
      });
      sm.requestRepoPolicyForLaunch({
        ...baseLaunch,
        prompt: "Implement launch B",
        name: "launch-b",
        model: "gpt-5.2",
      });

      assert.equal(dispatchCalls.length, 4);
      const firstKey = dispatchCalls[0][1].idempotencyKey;
      const retryKey = dispatchCalls[1][1].idempotencyKey;
      const reorderedToolsKey = dispatchCalls[2][1].idempotencyKey;
      const changedKey = dispatchCalls[3][1].idempotencyKey;
      assert.equal(retryKey, firstKey);
      assert.equal(reorderedToolsKey, firstKey);
      assert.notEqual(changedKey, firstKey);
      assert.match(firstKey, /^repo-policy-choice:.+:delegate:[0-9a-f]{16}$/);
      assert.match(changedKey, /^repo-policy-choice:.+:delegate:[0-9a-f]{16}$/);
      assert.equal(firstKey.includes("Implement launch A"), false);
      assert.equal(changedKey.includes("Implement launch B"), false);
      assert.equal(changedKey.includes("gpt-5.2"), false);
      sm.dispose();
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it("forwards stored session ID override when continuing after repo-policy choice", () => {
    const storeDir = mkdtempSync(join(tmpdir(), "openclaw-policy-launch-store-"));
    try {
      const sm = new SessionManager(1, 10, { store: { indexPath: join(storeDir, "sessions.json") } });
      let spawnConfig: Record<string, unknown> | undefined;
      (sm as any).spawn = (config: Record<string, unknown>) => {
        spawnConfig = config;
        return {
          id: "stable-session-1",
          name: "ship-isolated",
          model: config.model,
          worktreeStrategy: config.worktreeStrategy,
        };
      };

      const result = sm.launchAfterRepoPolicyChoice({
        route: { provider: "telegram", target: "12345" },
        prompt: "Ship isolated changes",
        workdir: "/repo",
        model: "gpt-5.5",
        resumeSessionId: "backend-session-1",
        resumeWorktreeFrom: "stable-session-1",
        sessionIdOverride: "stable-session-1",
        clearedPersistedCodexResume: true,
        worktreeStrategy: "delegate",
      });

      assert.equal(spawnConfig?.sessionIdOverride, "stable-session-1");
      assert.equal(spawnConfig?.resumeSessionId, "backend-session-1");
      assert.equal(spawnConfig?.resumeWorktreeFrom, "stable-session-1");
      assert.match(result.text, /ID: stable-session-1/);
      assert.match(result.text, /historical Codex state cleared/);
      sm.dispose();
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it("continues a deferred launch after manually setting the matching repo policy", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-policy-manual-continue-"));
    const storeDir = mkdtempSync(join(tmpdir(), "openclaw-policy-manual-continue-store-"));
    const dispatchCalls: any[] = [];
    try {
      git(repoDir, "init", "-b", "main");
      const sm = new SessionManager(1, 10, { store: { indexPath: join(storeDir, "sessions.json") } });
      (sm as any).notifications = {
        dispatch: (...args: any[]) => { dispatchCalls.push(args); },
        notifyWorktreeOutcome: () => {},
        dispose: () => {},
      };
      let spawnConfig: Record<string, unknown> | undefined;
      (sm as any).spawn = (config: Record<string, unknown>) => {
        spawnConfig = config;
        return {
          id: "manual-policy-session",
          name: "manual-policy-session",
          model: config.model,
          worktreeStrategy: config.worktreeStrategy,
        };
      };

      sm.requestRepoPolicyForLaunch({
        route: { provider: "telegram", target: "12345" },
        prompt: "Continue after manual policy",
        workdir: repoDir,
        model: "gpt-5.5",
        worktreeStrategy: "delegate",
      });
      const policyTokenId = dispatchCalls[0][1].buttons[0][0].callbackData;

      sm.setRepoPolicy(repoDir, "never-pr");
      const continuation = sm.continueLaunchAfterManualRepoPolicy(repoDir, "never-pr");

      assert.equal(continuation.kind, "launched");
      if (continuation.kind === "launched") {
        assert.match(continuation.text, /Session launched successfully/);
      }
      assert.equal(spawnConfig?.prompt, "Continue after manual policy");
      assert.equal(spawnConfig?.workdir, repoDir);
      assert.equal(spawnConfig?.model, "gpt-5.5");
      assert.equal(spawnConfig?.worktreeStrategy, "delegate");
      assert.equal(sm.getActionToken(policyTokenId), undefined);
      sm.dispose();
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it("preserves config-derived worktree strategy across deferred repo-policy continuation", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-policy-default-strategy-"));
    const storeDir = mkdtempSync(join(tmpdir(), "openclaw-policy-default-strategy-store-"));
    const dispatchCalls: any[] = [];
    try {
      setPluginConfig({ defaultWorktreeStrategy: "auto-merge" });
      git(repoDir, "init", "-b", "main");
      const sm = new SessionManager(1, 10, { store: { indexPath: join(storeDir, "sessions.json") } });
      (sm as any).notifications = {
        dispatch: (...args: any[]) => { dispatchCalls.push(args); },
        notifyWorktreeOutcome: () => {},
        dispose: () => {},
      };
      let spawnConfig: Record<string, unknown> | undefined;
      (sm as any).spawn = (config: Record<string, unknown>) => {
        spawnConfig = config;
        return {
          id: "manual-policy-default-strategy",
          name: "manual-policy-default-strategy",
          model: config.model,
          worktreeStrategy: config.worktreeStrategy,
        };
      };

      sm.requestRepoPolicyForLaunch({
        route: { provider: "telegram", target: "12345" },
        prompt: "Continue with original default strategy",
        workdir: repoDir,
        model: "gpt-5.5",
      });
      const policyTokenId = dispatchCalls[0][1].buttons[0][0].callbackData;
      assert.equal(sm.getActionToken(policyTokenId)?.launchWorktreeStrategy, "auto-merge");

      setPluginConfig({ defaultWorktreeStrategy: "off" });
      sm.setRepoPolicy(repoDir, "never-pr");
      const continuation = sm.continueLaunchAfterManualRepoPolicy(repoDir, "never-pr");

      assert.equal(continuation.kind, "launched");
      assert.equal(spawnConfig?.prompt, "Continue with original default strategy");
      assert.equal(spawnConfig?.worktreeStrategy, "auto-merge");
      sm.dispose();
    } finally {
      setPluginConfig({});
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it("deduplicates repeated delivery tokens for the same deferred manual policy launch", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-policy-manual-dedupe-"));
    const storeDir = mkdtempSync(join(tmpdir(), "openclaw-policy-manual-dedupe-store-"));
    const dispatchCalls: any[] = [];
    try {
      git(repoDir, "init", "-b", "main");
      const sm = new SessionManager(1, 10, { store: { indexPath: join(storeDir, "sessions.json") } });
      (sm as any).notifications = {
        dispatch: (...args: any[]) => { dispatchCalls.push(args); },
        notifyWorktreeOutcome: () => {},
        dispose: () => {},
      };
      let spawnCount = 0;
      let spawnConfig: Record<string, unknown> | undefined;
      (sm as any).spawn = (config: Record<string, unknown>) => {
        spawnCount++;
        spawnConfig = config;
        return {
          id: "manual-policy-session",
          name: "manual-policy-session",
          model: config.model,
          worktreeStrategy: config.worktreeStrategy,
        };
      };

      const launch = {
        route: { provider: "telegram" as const, target: "12345", threadId: "99" },
        prompt: "Continue once after duplicate prompt delivery",
        workdir: repoDir,
        model: "gpt-5.5",
        allowedTools: ["Shell(git status)", "Shell(pnpm test)"],
        worktreeStrategy: "delegate" as const,
      };

      sm.requestRepoPolicyForLaunch(launch);
      sm.requestRepoPolicyForLaunch({
        ...launch,
        allowedTools: ["Shell(pnpm test)", "Shell(git status)"],
      });
      const firstPolicyTokenId = dispatchCalls[0][1].buttons[0][0].callbackData;
      const secondPolicyTokenId = dispatchCalls[1][1].buttons[0][0].callbackData;

      sm.setRepoPolicy(repoDir, "never-pr");
      const continuation = sm.continueLaunchAfterManualRepoPolicy(repoDir, "never-pr");

      assert.equal(continuation.kind, "launched");
      assert.equal(spawnCount, 1);
      assert.equal(spawnConfig?.prompt, "Continue once after duplicate prompt delivery");
      assert.equal(spawnConfig?.workdir, repoDir);
      assert.equal(sm.getActionToken(firstPolicyTokenId), undefined);
      assert.equal(sm.getActionToken(secondPolicyTokenId), undefined);
      assert.equal(dispatchCalls.length, 2);
      sm.dispose();
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it("keeps the deferred launch token retryable when manual policy continuation fails", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-policy-manual-failure-"));
    const storeDir = mkdtempSync(join(tmpdir(), "openclaw-policy-manual-failure-store-"));
    const dispatchCalls: any[] = [];
    try {
      git(repoDir, "init", "-b", "main");
      const sm = new SessionManager(1, 10, { store: { indexPath: join(storeDir, "sessions.json") } });
      (sm as any).notifications = {
        dispatch: (...args: any[]) => { dispatchCalls.push(args); },
        notifyWorktreeOutcome: () => {},
        dispose: () => {},
      };
      (sm as any).spawn = () => {
        throw new Error("launch capacity unavailable");
      };

      sm.requestRepoPolicyForLaunch({
        route: { provider: "telegram", target: "12345" },
        prompt: "Retry after manual policy",
        workdir: repoDir,
        worktreeStrategy: "delegate",
      });
      const policyTokenId = dispatchCalls[0][1].buttons[0][0].callbackData;

      sm.setRepoPolicy(repoDir, "never-pr");
      assert.throws(
        () => sm.continueLaunchAfterManualRepoPolicy(repoDir, "never-pr"),
        /launch capacity unavailable/,
      );
      assert.equal(sm.getActionToken(policyTokenId)?.id, policyTokenId);
      sm.dispose();
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it("clears stale manual policy prompt tokens when no matching deferred launch remains", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-policy-manual-no-match-"));
    const storeDir = mkdtempSync(join(tmpdir(), "openclaw-policy-manual-no-match-store-"));
    const dispatchCalls: any[] = [];
    try {
      git(repoDir, "init", "-b", "main");
      const sm = new SessionManager(1, 10, { store: { indexPath: join(storeDir, "sessions.json") } });
      (sm as any).notifications = {
        dispatch: (...args: any[]) => { dispatchCalls.push(args); },
        notifyWorktreeOutcome: () => {},
        dispose: () => {},
      };
      (sm as any).spawn = () => {
        throw new Error("spawn should not run without a matching policy token");
      };

      sm.requestRepoPolicyForLaunch({
        route: { provider: "telegram", target: "12345" },
        prompt: "No matching policy token remains",
        workdir: repoDir,
        worktreeStrategy: "delegate",
      });
      const policyTokenIds = repoPolicyButtonTokenIds(dispatchCalls[0][1]);
      const neverPrTokenId = policyTokenIds.find((tokenId) => (
        sm.getActionToken(tokenId)?.repoPolicy === "never-pr"
      ));
      assert.ok(neverPrTokenId);
      sm.consumeActionToken(neverPrTokenId);

      sm.setRepoPolicy(repoDir, "never-pr");
      const continuation = sm.continueLaunchAfterManualRepoPolicy(repoDir, "never-pr");

      assert.deepEqual(continuation, { kind: "none" });
      for (const tokenId of policyTokenIds) {
        assert.equal(sm.getActionToken(tokenId), undefined);
      }
      sm.dispose();
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it("does not guess which launch to continue when multiple manual policy matches exist", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-policy-manual-ambiguous-"));
    const storeDir = mkdtempSync(join(tmpdir(), "openclaw-policy-manual-ambiguous-store-"));
    const dispatchCalls: any[] = [];
    try {
      git(repoDir, "init", "-b", "main");
      const sm = new SessionManager(1, 10, { store: { indexPath: join(storeDir, "sessions.json") } });
      (sm as any).notifications = {
        dispatch: (...args: any[]) => { dispatchCalls.push(args); },
        notifyWorktreeOutcome: () => {},
        dispose: () => {},
      };
      let spawnCalled = false;
      (sm as any).spawn = () => {
        spawnCalled = true;
        throw new Error("spawn should not run for ambiguous manual policy continuation");
      };

      sm.requestRepoPolicyForLaunch({
        route: { provider: "telegram", target: "12345" },
        prompt: "First pending launch",
        workdir: repoDir,
        worktreeStrategy: "delegate",
      });
      sm.requestRepoPolicyForLaunch({
        route: { provider: "telegram", target: "12345" },
        prompt: "Second pending launch",
        workdir: repoDir,
        worktreeStrategy: "delegate",
      });
      const firstPolicyTokenIds = repoPolicyButtonTokenIds(dispatchCalls[0][1]);
      const secondPolicyTokenIds = repoPolicyButtonTokenIds(dispatchCalls[1][1]);

      sm.setRepoPolicy(repoDir, "never-pr");
      const continuation = sm.continueLaunchAfterManualRepoPolicy(repoDir, "never-pr");

      assert.deepEqual(continuation, { kind: "ambiguous", count: 2 });
      assert.equal(spawnCalled, false);
      assert.equal(dispatchCalls.length, 2);
      for (const tokenId of [...firstPolicyTokenIds, ...secondPolicyTokenIds]) {
        assert.equal(sm.getActionToken(tokenId), undefined);
      }
      sm.dispose();
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it("seeds openclaw-code-agent as PR-required", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-policy-seed-"));
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "remote", "add", "origin", "https://github.com/goldmar/openclaw-code-agent.git/");
      const identity = resolveRepoIdentity(repoDir);
      assert.ok(identity);
      assert.equal(identity.remoteUrl, "https://github.com/goldmar/openclaw-code-agent");
      assert.equal(seededRepoPolicy(identity), "pr-required");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("cleans up stored repo policies when the repo identity changes at the same path", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-policy-identity-cleanup-"));
    const secondRepoDir = mkdtempSync(join(tmpdir(), "openclaw-policy-identity-cleanup-second-"));
    const storeDir = mkdtempSync(join(tmpdir(), "openclaw-policy-identity-cleanup-store-"));
    let sm: SessionManager | undefined;
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "remote", "add", "origin", "https://github.com/example/old.git");
      git(secondRepoDir, "init", "-b", "main");
      git(secondRepoDir, "remote", "add", "origin", "https://github.com/example/second-old.git");
      sm = new SessionManager(1, 10, { store: { indexPath: join(storeDir, "sessions.json") } });

      const oldRecord = sm.setRepoPolicy(repoDir, "pr-required");
      const secondOldRecord = sm.setRepoPolicy(secondRepoDir, "never-pr");
      assert.ok(oldRecord);
      assert.ok(secondOldRecord);
      const store = (sm as any).store as { saveIndex: () => void };
      const originalSaveIndex = store.saveIndex.bind(store);
      let cleanupSaveCount = 0;
      store.saveIndex = () => {
        cleanupSaveCount += 1;
        originalSaveIndex();
      };
      git(repoDir, "remote", "set-url", "origin", "https://github.com/example/new.git");
      git(secondRepoDir, "remote", "set-url", "origin", "https://github.com/example/second-new.git");

      const removed = sm.cleanupRepoPolicies();

      assert.deepEqual(removed.map((record) => record.key).sort(), [oldRecord.key, secondOldRecord.key].sort());
      assert.equal(cleanupSaveCount, 1);
      assert.deepEqual(sm.listRepoPolicies(), []);
    } finally {
      sm?.dispose();
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(secondRepoDir, { recursive: true, force: true });
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it("downgrades or blocks requested strategies according to policy and PR capability", () => {
    assert.deepEqual(
      resolveAllowedWorktreeActions({ policy: "never-pr", prAvailable: true }),
      { merge: true, pr: false },
    );
    assert.deepEqual(
      resolveAllowedWorktreeActions({ policy: "manual", prAvailable: true }),
      { merge: false, pr: false },
    );
    assert.deepEqual(
      resolveWorktreePolicyDecision({ requestedStrategy: "auto-merge", policy: "pr-required", prAvailable: true }),
      {
        strategy: "auto-pr",
        reason: "Repo policy requires a PR; auto-merge was downgraded to auto-pr.",
        allowedActions: { merge: false, pr: true },
      },
    );
    assert.equal(
      resolveWorktreePolicyDecision({ requestedStrategy: "auto-merge", policy: "pr-required", prAvailable: false }).blocked,
      true,
    );
    assert.equal(
      resolveWorktreePolicyDecision({ requestedStrategy: "auto-pr", policy: "never-pr", prAvailable: true }).strategy,
      "ask",
    );
    assert.deepEqual(
      resolveWorktreePolicyDecision({
        requestedStrategy: "auto-pr",
        policy: "never-pr",
        prAvailable: true,
        existingOpenPr: true,
      }),
      {
        strategy: "auto-pr",
        reason: "Repo policy forbids new PR creation; updating the existing open PR is allowed.",
        allowedActions: { merge: true, pr: false },
      },
    );
  });
});

describe("SessionWorktreeActionService repo policy planning", () => {
  it("releases absent native backend worktrees without inspecting completion topology", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-policy-native-absent-"));
    const worktreePath = join(repoDir, ".worktrees", "native-absent");
    try {
      const service = new SessionWorktreeActionService({
        shouldRunWorktreeStrategy: () => true,
        isAlreadyMerged: () => false,
        resolveWorktreeRepoDir: () => repoDir,
        getWorktreeCompletionState: () => {
          throw new Error("absent native backend worktrees should release before topology inspection");
        },
        isPrAvailable: () => true,
      });

      const action = await service.plan({
        id: "s-native-absent",
        name: "native-absent",
        status: "completed",
        lifecycle: "active",
        phase: "implementing",
        worktreePath,
        worktreeBranch: "agent/native-absent",
        worktreeStrategy: "ask",
        originalWorkdir: repoDir,
        harnessSessionId: "h-native-absent",
        backendRef: {
          kind: "codex-app-server",
          conversationId: "codex-native-absent",
          worktreeId: "wt-native-absent",
          worktreePath,
        },
      } as any);

      assert.deepEqual(action, {
        kind: "no-change",
        repoDir,
        worktreePath,
        branchName: "agent/native-absent",
        nativeBackendWorktree: true,
      });
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("turns auto-merge into auto-pr for PR-required repos when PRs are available", async () => {
    const { repoDir, worktreePath, branchName } = createRepoWithWorktree("auto-pr-required");
    try {
      const service = new SessionWorktreeActionService({
        shouldRunWorktreeStrategy: () => true,
        isAlreadyMerged: () => false,
        resolveWorktreeRepoDir: () => repoDir,
        getWorktreeCompletionState: () => "has-commits",
        isPrAvailable: () => true,
      });
      const action = await service.plan({
        id: "s-policy-pr",
        name: "policy-pr",
        status: "completed",
        lifecycle: "active",
        phase: "implementing",
        worktreePath,
        worktreeBranch: branchName,
        worktreeStrategy: "auto-merge",
        repoIntegrationPolicy: "pr-required",
        originalWorkdir: repoDir,
        harnessSessionId: "h-policy-pr",
      } as any);
      assert.equal(action.kind, "decision");
      if (action.kind === "decision") {
        assert.equal(action.strategy, "auto-pr");
        assert.equal(action.allowedActions.merge, false);
        assert.equal(action.allowedActions.pr, true);
      }
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("uses live repo policy when an in-flight session has no policy snapshot", async () => {
    const { repoDir, worktreePath, branchName } = createRepoWithWorktree("live-policy-fallback");
    try {
      const service = new SessionWorktreeActionService({
        shouldRunWorktreeStrategy: () => true,
        isAlreadyMerged: () => false,
        resolveWorktreeRepoDir: () => repoDir,
        getWorktreeCompletionState: () => "has-commits",
        isPrAvailable: () => false,
        resolveRepoPolicy: () => ({
          policy: "pr-required",
          source: "stored",
          provider: "github",
          prAvailable: true,
          identity: {
            key: `${repoDir}|https://github.com/example/repo`,
            repoRoot: repoDir,
            remoteUrl: "https://github.com/example/repo",
            provider: "github",
          },
        }),
      });
      const action = await service.plan({
        id: "s-policy-live",
        name: "policy-live",
        status: "completed",
        lifecycle: "active",
        phase: "implementing",
        worktreePath,
        worktreeBranch: branchName,
        worktreeStrategy: "auto-merge",
        originalWorkdir: repoDir,
        harnessSessionId: "h-policy-live",
      } as any);
      assert.equal(action.kind, "decision");
      if (action.kind === "decision") {
        assert.equal(action.strategy, "auto-pr");
        assert.equal(action.allowedActions.merge, false);
        assert.equal(action.allowedActions.pr, true);
      }
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("blocks auto-merge for PR-required repos when PRs are unavailable", async () => {
    const { repoDir, worktreePath, branchName } = createRepoWithWorktree("pr-unavailable");
    try {
      const service = new SessionWorktreeActionService({
        shouldRunWorktreeStrategy: () => true,
        isAlreadyMerged: () => false,
        resolveWorktreeRepoDir: () => repoDir,
        getWorktreeCompletionState: () => "has-commits",
        isPrAvailable: () => false,
      });
      const action = await service.plan({
        id: "s-policy-block",
        name: "policy-block",
        status: "completed",
        lifecycle: "active",
        phase: "implementing",
        worktreePath,
        worktreeBranch: branchName,
        worktreeStrategy: "auto-merge",
        repoIntegrationPolicy: "pr-required",
        originalWorkdir: repoDir,
        harnessSessionId: "h-policy-block",
      } as any);
      assert.equal(action.kind, "decision");
      if (action.kind === "decision") {
        assert.equal(action.policyBlocked, true);
        assert.equal(action.allowedActions.merge, false);
        assert.equal(action.allowedActions.pr, false);
      }
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("does not treat a stale persisted PR URL as an existing open PR", async () => {
    const { repoDir, worktreePath, branchName } = createRepoWithWorktree("stale-pr-url");
    try {
      const service = new SessionWorktreeActionService({
        shouldRunWorktreeStrategy: () => true,
        isAlreadyMerged: () => false,
        resolveWorktreeRepoDir: () => repoDir,
        getWorktreeCompletionState: () => "has-commits",
        isPrAvailable: () => true,
      });
      const action = await service.plan({
        id: "s-stale-pr-url",
        name: "stale-pr-url",
        status: "completed",
        lifecycle: "active",
        phase: "implementing",
        worktreePath,
        worktreeBranch: branchName,
        worktreeStrategy: "auto-pr",
        repoIntegrationPolicy: "never-pr",
        worktreePrUrl: "https://github.com/example/repo/pull/1",
        originalWorkdir: repoDir,
        harnessSessionId: "h-stale-pr-url",
      } as any);

      assert.equal(action.kind, "decision");
      if (action.kind === "decision") {
        assert.equal(action.strategy, "ask");
        assert.equal(action.allowedActions.merge, true);
        assert.equal(action.allowedActions.pr, false);
      }
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("does not treat stale pr-open lifecycle as an existing open PR while planning", async () => {
    const { repoDir, worktreePath, branchName } = createRepoWithWorktree("stale-lifecycle-open-pr");
    try {
      const service = new SessionWorktreeActionService({
        shouldRunWorktreeStrategy: () => true,
        isAlreadyMerged: () => false,
        resolveWorktreeRepoDir: () => repoDir,
        getWorktreeCompletionState: () => "has-commits",
        isPrAvailable: () => true,
      });
      const action = await service.plan({
        id: "s-stale-lifecycle-open-pr",
        name: "stale-lifecycle-open-pr",
        status: "completed",
        lifecycle: "terminal",
        phase: "implementing",
        worktreeState: "pr_open",
        worktreeLifecycle: {
          state: "pr_open",
          updatedAt: "2026-06-30T12:00:00.000Z",
          resolutionSource: "agent_pr",
        },
        worktreePath,
        worktreeBranch: branchName,
        worktreeStrategy: "auto-pr",
        repoIntegrationPolicy: "never-pr",
        worktreePrUrl: "https://github.com/example/repo/pull/2",
        originalWorkdir: repoDir,
        harnessSessionId: "h-stale-lifecycle-open-pr",
      } as any);

      assert.equal(action.kind, "decision");
      if (action.kind === "decision") {
        assert.equal(action.strategy, "ask");
        assert.equal(action.allowedActions.merge, true);
        assert.equal(action.allowedActions.pr, false);
      }
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
