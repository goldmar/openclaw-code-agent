import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathsReferToSameLocation } from "../src/path-utils";
import { setPluginConfig } from "../src/config";
import { prepareSessionBootstrap } from "../src/session-bootstrap";
import type { PersistedSessionInfo, SessionConfig } from "../src/types";
import { createWorktree, getBranchName } from "../src/worktree";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

describe("prepareSessionBootstrap()", () => {
  beforeEach(() => {
    setPluginConfig({});
  });

  it("recovers the original repo dir for resumed worktree sessions with legacy self-referential metadata", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "session-bootstrap-"));
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");

      const worktreePath = createWorktree(repoDir, "resume-self-reference");
      const branchName = getBranchName(worktreePath);
      assert.ok(branchName, "worktree branch should exist");

      const config: SessionConfig = {
        prompt: "Resume the fix",
        workdir: worktreePath,
        resumeWorktreeFrom: "sess-1",
        multiTurn: true,
        route: {
          provider: "telegram",
          target: "12345",
          sessionKey: "agent:main:telegram:group:12345",
        },
      };

      const bootstrap = prepareSessionBootstrap(
        config,
        "resume-self-reference",
        (_ref): PersistedSessionInfo | undefined => ({
          harnessSessionId: "sess-1",
          name: "resume-self-reference",
          prompt: "Resume the fix",
          workdir: worktreePath,
          status: "running",
          costUsd: 0,
          worktreePath,
          worktreeBranch: branchName,
        }),
      );

      assert.equal(bootstrap.actualWorkdir, worktreePath);
      assert.equal(pathsReferToSameLocation(bootstrap.originalWorkdir, repoDir), true);
      assert.equal(bootstrap.worktreePath, worktreePath);
      assert.equal(bootstrap.worktreeBranchName, branchName);
      assert.match(
        bootstrap.effectiveSystemPrompt ?? "",
        new RegExp(`Do NOT edit files directly in ${(bootstrap.originalWorkdir ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      );
      assert.doesNotMatch(
        bootstrap.effectiveSystemPrompt ?? "",
        new RegExp(`Do NOT edit files directly in ${worktreePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("keeps fresh Codex worktree launches on the original repo and lets the backend allocate the native worktree", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "session-bootstrap-codex-native-"));
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");

      const config: SessionConfig = {
        prompt: "Implement the fix",
        workdir: repoDir,
        harness: "codex",
        worktreeStrategy: "ask",
        multiTurn: true,
        route: {
          provider: "telegram",
          target: "12345",
          sessionKey: "agent:main:telegram:group:12345",
        },
      };

      const bootstrap = prepareSessionBootstrap(config, "codex-native", () => undefined);

      assert.equal(bootstrap.actualWorkdir, repoDir);
      assert.equal(bootstrap.originalWorkdir, repoDir);
      assert.equal(bootstrap.worktreePath, undefined);
      assert.equal(bootstrap.worktreeBranchName, undefined);
      assert.equal(bootstrap.effectiveSystemPrompt, config.systemPrompt);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("uses the delegated plugin worktree default when no strategy is provided", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "session-bootstrap-default-delegate-"));
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");

      const config: SessionConfig = {
        prompt: "Implement the fix",
        workdir: repoDir,
        harness: "claude-code",
        multiTurn: true,
        route: {
          provider: "telegram",
          target: "12345",
          sessionKey: "agent:main:telegram:group:12345",
        },
      };

      const bootstrap = prepareSessionBootstrap(config, "default-delegate", () => undefined);

      assert.equal(config.worktreeStrategy, "delegate");
      assert.equal(bootstrap.originalWorkdir, repoDir);
      assert.ok(bootstrap.worktreePath, "default delegate strategy should create a worktree");
      assert.equal(bootstrap.actualWorkdir, bootstrap.worktreePath);
      assert.ok(bootstrap.worktreeBranchName, "default delegate worktree should have a branch");
      assert.match(bootstrap.effectiveSystemPrompt ?? "", /You are working in a git worktree/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("does not recreate missing native Codex worktrees during resume bootstrap", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "session-bootstrap-codex-resume-"));
    const missingWorktreePath = join(repoDir, ".codex", "worktrees", "abcd", "openclaw");
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");

      const config: SessionConfig = {
        prompt: "Resume the Codex session",
        workdir: repoDir,
        harness: "codex",
        resumeSessionId: "thread-1",
        worktreeStrategy: "ask",
        multiTurn: true,
        route: {
          provider: "telegram",
          target: "12345",
          sessionKey: "agent:main:telegram:group:12345",
        },
      };

      const bootstrap = prepareSessionBootstrap(
        config,
        "codex-native-resume",
        (_ref): PersistedSessionInfo | undefined => ({
          sessionId: "session-1",
          harnessSessionId: "thread-1",
          backendRef: {
            kind: "codex-app-server",
            conversationId: "thread-1",
            worktreeId: "abcd",
            worktreePath: missingWorktreePath,
          },
          name: "codex-native-resume",
          prompt: "Resume the Codex session",
          workdir: repoDir,
          status: "killed",
          lifecycle: "suspended",
          runtimeState: "stopped",
          costUsd: 0,
          route: {
            provider: "telegram",
            target: "12345",
            sessionKey: "agent:main:telegram:group:12345",
          },
          worktreePath: missingWorktreePath,
          worktreeBranch: "agent/codex-native-resume",
          worktreeStrategy: "ask",
        }),
      );

      assert.equal(bootstrap.actualWorkdir, repoDir);
      assert.equal(bootstrap.originalWorkdir, repoDir);
      assert.equal(bootstrap.worktreePath, undefined);
      assert.equal(bootstrap.worktreeBranchName, "agent/codex-native-resume");
      assert.equal(config.resumeSessionId, "thread-1");
      assert.equal(config.resumeWorktreeFrom, undefined);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("clears stale resume state when a missing plugin-managed worktree cannot be recreated", () => {
    const missingRepoDir = join(tmpdir(), `session-bootstrap-missing-${Date.now()}`);
    const missingWorktreePath = join(missingRepoDir, ".worktrees", "missing", "openclaw");
    try {
      const config: SessionConfig = {
        prompt: "Resume the Claude session",
        workdir: "/tmp",
        harness: "claude-code",
        resumeSessionId: "thread-missing",
        resumeWorktreeFrom: "session-missing",
        worktreeStrategy: "off",
        multiTurn: true,
        route: {
          provider: "telegram",
          target: "12345",
          sessionKey: "agent:main:telegram:group:12345",
        },
      };

      const bootstrap = prepareSessionBootstrap(
        config,
        "missing-plugin-worktree",
        (_ref): PersistedSessionInfo | undefined => ({
          sessionId: "session-missing",
          harnessSessionId: "thread-missing",
          backendRef: {
            kind: "claude-code",
            conversationId: "thread-missing",
          },
          name: "missing-plugin-worktree",
          prompt: "Resume the Claude session",
          workdir: missingRepoDir,
          status: "killed",
          lifecycle: "suspended",
          runtimeState: "stopped",
          costUsd: 0,
          route: {
            provider: "telegram",
            target: "12345",
            sessionKey: "agent:main:telegram:group:12345",
          },
          worktreePath: missingWorktreePath,
          worktreeBranch: "agent/missing-plugin-worktree",
          worktreeStrategy: "ask",
        }),
      );

      assert.equal(bootstrap.actualWorkdir, missingRepoDir);
      assert.equal(bootstrap.originalWorkdir, missingRepoDir);
      assert.equal(bootstrap.worktreePath, undefined);
      assert.equal(config.resumeSessionId, undefined);
      assert.equal(config.resumeWorktreeFrom, undefined);
      assert.equal(bootstrap.clearedResumeSessionId, true);
      assert.equal(bootstrap.clearedResumeWorktreeFrom, true);
    } finally {
      rmSync(missingRepoDir, { recursive: true, force: true });
    }
  });
});
