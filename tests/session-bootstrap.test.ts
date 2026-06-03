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

  it("uses resumeWorktreeFrom instead of backend resume id when restoring worktree context", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "session-bootstrap-resume-worktree-from-"));
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");

      const worktreePath = createWorktree(repoDir, "resume-worktree-from");
      const branchName = getBranchName(worktreePath);
      assert.ok(branchName, "worktree branch should exist");

      const config: SessionConfig = {
        prompt: "Approved. Continue in the existing worktree.",
        workdir: repoDir,
        resumeSessionId: "backend-thread-1",
        resumeWorktreeFrom: "stable-session-1",
        worktreeStrategy: "delegate",
        multiTurn: true,
        route: {
          provider: "telegram",
          target: "12345",
          sessionKey: "agent:main:telegram:group:12345",
        },
      };

      const bootstrap = prepareSessionBootstrap(
        config,
        "resume-worktree-from",
        (ref): PersistedSessionInfo | undefined => {
          if (ref !== "stable-session-1") return undefined;
          return {
            harnessSessionId: "backend-thread-1",
            sessionId: "stable-session-1",
            name: "resume-worktree-from",
            prompt: "Original prompt",
            workdir: repoDir,
            status: "killed",
            costUsd: 0,
            worktreePath,
            worktreeBranch: branchName,
            worktreeStrategy: "delegate",
          };
        },
      );

      assert.equal(bootstrap.actualWorkdir, worktreePath);
      assert.equal(bootstrap.originalWorkdir, repoDir);
      assert.equal(bootstrap.worktreePath, worktreePath);
      assert.equal(bootstrap.worktreeBranchName, branchName);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("defaults resumed PR-open worktrees to auto-pr follow-through", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "session-bootstrap-pr-open-followup-"));
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");

      const worktreePath = createWorktree(repoDir, "pr-open-followup");
      const branchName = getBranchName(worktreePath);
      assert.ok(branchName, "worktree branch should exist");

      const config: SessionConfig = {
        prompt: "Address review feedback on the existing PR.",
        workdir: repoDir,
        resumeWorktreeFrom: "pr-open-session",
        multiTurn: true,
        route: {
          provider: "telegram",
          target: "12345",
          sessionKey: "agent:main:telegram:group:12345",
        },
      };

      const bootstrap = prepareSessionBootstrap(
        config,
        "pr-open-followup",
        (ref): PersistedSessionInfo | undefined => {
          if (ref !== "pr-open-session") return undefined;
          return {
            harnessSessionId: "backend-pr-open",
            sessionId: "pr-open-session",
            name: "pr-open-followup",
            prompt: "Original prompt",
            workdir: repoDir,
            status: "completed",
            costUsd: 0,
            worktreePath,
            worktreeBranch: branchName,
            worktreeStrategy: "ask",
            worktreePrUrl: "https://github.com/goldmar/openclaw-code-agent/pull/155",
            worktreeLifecycle: {
              state: "pr_open",
              updatedAt: "2026-06-03T12:00:00.000Z",
              resolutionSource: "agent_pr",
            },
          };
        },
      );

      assert.equal(bootstrap.actualWorkdir, worktreePath);
      assert.equal(config.worktreeStrategy, "auto-pr");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("creates a plugin-managed worktree for fresh Codex worktree launches", () => {
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

      assert.equal(bootstrap.originalWorkdir, repoDir);
      assert.ok(bootstrap.worktreePath, "fresh Codex ask launch should create a plugin-managed worktree");
      assert.equal(bootstrap.actualWorkdir, bootstrap.worktreePath);
      assert.ok(bootstrap.worktreeBranchName, "fresh Codex ask worktree should have a branch");
      assert.match(bootstrap.effectiveSystemPrompt ?? "", /You are working in a git worktree/);
      assert.match(bootstrap.effectiveSystemPrompt ?? "", /IMPORTANT: ALL file edits must be made within this worktree/);
      assert.match(bootstrap.effectiveSystemPrompt ?? "", /Before finishing, run `git status --short`/);
      assert.match(bootstrap.effectiveSystemPrompt ?? "", /commit all of them to this branch before finishing/);
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

  it("fails closed when a requested native Codex resume worktree is missing", () => {
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

      assert.throws(
        () => prepareSessionBootstrap(
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
        ),
        /worktree strategy "ask" was requested, but no isolated worktree was prepared/,
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("creates a new plugin-managed worktree for Codex resume launches without a persisted worktree path", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "session-bootstrap-codex-resume-no-worktree-"));
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");

      const config: SessionConfig = {
        prompt: "Fork and continue the Codex session",
        workdir: repoDir,
        harness: "codex",
        resumeSessionId: "thread-no-worktree",
        forkSession: true,
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
        "codex-resume-managed-worktree",
        (_ref): PersistedSessionInfo | undefined => ({
          sessionId: "session-no-worktree",
          harnessSessionId: "thread-no-worktree",
          backendRef: {
            kind: "codex-app-server",
            conversationId: "thread-no-worktree",
          },
          name: "codex-resume-managed-worktree",
          prompt: "Fork and continue the Codex session",
          workdir: repoDir,
          status: "completed",
          lifecycle: "terminal",
          runtimeState: "stopped",
          costUsd: 0,
          route: {
            provider: "telegram",
            target: "12345",
            sessionKey: "agent:main:telegram:group:12345",
          },
          worktreeStrategy: "ask",
        }),
      );

      assert.equal(bootstrap.originalWorkdir, repoDir);
      assert.ok(bootstrap.worktreePath, "Codex resume without persisted worktree should create a managed worktree");
      assert.equal(bootstrap.actualWorkdir, bootstrap.worktreePath);
      assert.ok(bootstrap.worktreeBranchName, "managed resume worktree should have a branch");
      assert.match(bootstrap.effectiveSystemPrompt ?? "", /You are working in a git worktree/);
      assert.equal(config.resumeSessionId, "thread-no-worktree");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("fails closed for non-Codex resumes without persisted worktree metadata when a worktree strategy is requested", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "session-bootstrap-claude-resume-no-worktree-"));
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");

      const config: SessionConfig = {
        prompt: "Resume the Claude session",
        workdir: repoDir,
        harness: "claude-code",
        resumeSessionId: "claude-thread-no-worktree",
        worktreeStrategy: "ask",
        multiTurn: true,
        route: {
          provider: "telegram",
          target: "12345",
          sessionKey: "agent:main:telegram:group:12345",
        },
      };

      assert.throws(
        () => prepareSessionBootstrap(
          config,
          "claude-resume-no-managed-worktree",
          (_ref): PersistedSessionInfo | undefined => ({
            sessionId: "claude-session-no-worktree",
            harnessSessionId: "claude-thread-no-worktree",
            harness: "claude-code",
            backendRef: {
              kind: "claude-code",
              conversationId: "claude-thread-no-worktree",
            },
            name: "claude-resume-no-managed-worktree",
            prompt: "Resume the Claude session",
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
            worktreeStrategy: "ask",
          }),
        ),
        /worktree strategy "ask" was requested, but no isolated worktree was prepared/,
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("fails closed for legacy Claude resumes without worktree metadata even when Codex is the default harness", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "session-bootstrap-legacy-claude-resume-no-worktree-"));
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");
      setPluginConfig({ defaultHarness: "codex" });

      const config: SessionConfig = {
        prompt: "Resume the legacy Claude session",
        workdir: repoDir,
        harness: "claude-code",
        resumeSessionId: "legacy-claude-thread-no-worktree",
        worktreeStrategy: "ask",
        multiTurn: true,
        route: {
          provider: "telegram",
          target: "12345",
          sessionKey: "agent:main:telegram:group:12345",
        },
      };

      assert.throws(
        () => prepareSessionBootstrap(
          config,
          "legacy-claude-resume-no-managed-worktree",
          (_ref): PersistedSessionInfo | undefined => ({
            sessionId: "legacy-claude-session-no-worktree",
            harnessSessionId: "legacy-claude-thread-no-worktree",
            name: "legacy-claude-resume-no-managed-worktree",
            prompt: "Resume the legacy Claude session",
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
            worktreeStrategy: "ask",
          }),
        ),
        /worktree strategy "ask" was requested, but no isolated worktree was prepared/,
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("fails closed when a requested plugin-managed resume worktree is missing and cannot be recreated", () => {
    const missingRepoDir = join(tmpdir(), `session-bootstrap-missing-${Date.now()}`);
    const missingWorktreePath = join(missingRepoDir, ".worktrees", "missing", "openclaw");
    try {
      const config: SessionConfig = {
        prompt: "Resume the Claude session",
        workdir: "/tmp",
        harness: "claude-code",
        resumeSessionId: "thread-missing",
        resumeWorktreeFrom: "session-missing",
        worktreeStrategy: "ask",
        multiTurn: true,
        route: {
          provider: "telegram",
          target: "12345",
          sessionKey: "agent:main:telegram:group:12345",
        },
      };

      assert.throws(
        () => prepareSessionBootstrap(
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
        ),
        /worktree strategy "ask" was requested, but no isolated worktree was prepared/,
      );
    } finally {
      rmSync(missingRepoDir, { recursive: true, force: true });
    }
  });

  it("does not replace a failed plugin-managed resume worktree restore with a fresh unrelated worktree", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "session-bootstrap-recreate-fails-"));
    const occupiedWorktreeDir = mkdtempSync(join(tmpdir(), "session-bootstrap-occupied-worktree-"));
    const occupiedWorktreePath = join(occupiedWorktreeDir, "checkout");
    const missingWorktreePath = join(repoDir, ".worktrees", "openclaw-worktree-missing-plugin-worktree");
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");
      git(repoDir, "worktree", "add", "-b", "agent/missing-plugin-worktree", occupiedWorktreePath);
      rmSync(missingWorktreePath, { recursive: true, force: true });

      const config: SessionConfig = {
        prompt: "Resume the Claude session",
        workdir: repoDir,
        harness: "claude-code",
        resumeSessionId: "thread-valid-repo-missing-worktree",
        resumeWorktreeFrom: "session-valid-repo-missing-worktree",
        worktreeStrategy: "ask",
        multiTurn: true,
        route: {
          provider: "telegram",
          target: "12345",
          sessionKey: "agent:main:telegram:group:12345",
        },
      };

      assert.throws(
        () => prepareSessionBootstrap(
          config,
          "missing-plugin-worktree",
          (_ref): PersistedSessionInfo | undefined => ({
            sessionId: "session-valid-repo-missing-worktree",
            harnessSessionId: "thread-valid-repo-missing-worktree",
            backendRef: {
              kind: "claude-code",
              conversationId: "thread-valid-repo-missing-worktree",
            },
            name: "missing-plugin-worktree",
            prompt: "Resume the Claude session",
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
            worktreeBranch: "agent/missing-plugin-worktree",
            worktreeStrategy: "ask",
          }),
        ),
        /worktree strategy "ask" was requested, but no isolated worktree was prepared/,
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(occupiedWorktreeDir, { recursive: true, force: true });
    }
  });

  it("allows explicit off to clear stale resume state when a missing plugin-managed worktree cannot be recreated", () => {
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
