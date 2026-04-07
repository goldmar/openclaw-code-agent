import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatWorktreeLifecycleState,
  formatWorktreePreserveReason,
  listWorktreeToolTargets,
  matchesWorktreeToolRef,
  resolveWorktreeToolLifecycle,
  resolveWorktreeToolSessions,
} from "../src/tools/worktree-tool-context";

describe("worktree-tool-context", () => {
  it("merges active and persisted worktree targets while preferring active sessions", () => {
    const targets = listWorktreeToolTargets({
      list: () => [{
        id: "active-1",
        name: "feature-work",
        worktreePath: "/tmp/active",
        worktreeBranch: "agent/feature-work",
        worktreeStrategy: "ask",
        originalWorkdir: "/repo",
        workdir: "/tmp/active",
        backendRef: { kind: "codex-app-server", conversationId: "backend-active" },
        harnessSessionId: "legacy-active",
      }],
      listPersistedSessions: () => [{
        sessionId: "persisted-1",
        harnessSessionId: "legacy-persisted",
        backendRef: { kind: "claude-code", conversationId: "backend-persisted" },
        name: "feature-work",
        worktreePath: "/tmp/persisted",
        worktreeBranch: "agent/feature-work",
        worktreeStrategy: "delegate",
        workdir: "/repo",
      }],
    } as any);

    assert.equal(targets.length, 2);
    assert.deepEqual(targets[0], {
      id: "persisted-1",
      name: "feature-work",
      worktreePath: "/tmp/persisted",
      worktreeBranch: "agent/feature-work",
      worktreeStrategy: "delegate",
      workdir: "/repo",
      worktreeMerged: undefined,
      worktreeMergedAt: undefined,
      worktreePrUrl: undefined,
      backendConversationId: "backend-persisted",
      harnessSessionId: "legacy-persisted",
    });
    assert.equal(targets[1]?.id, "active-1");
  });

  it("matches session refs by session id, name, backend id, and legacy harness id", () => {
    const target = {
      id: "session-1",
      name: "feature-work",
      backendConversationId: "backend-1",
      harnessSessionId: "legacy-1",
    };

    assert.equal(matchesWorktreeToolRef(target, "session-1"), true);
    assert.equal(matchesWorktreeToolRef(target, "feature-work"), true);
    assert.equal(matchesWorktreeToolRef(target, "backend-1"), true);
    assert.equal(matchesWorktreeToolRef(target, "legacy-1"), true);
    assert.equal(matchesWorktreeToolRef(target, "missing"), false);
  });

  it("resolves active and persisted worktree sessions across all supported refs", () => {
    const sessionManager = {
      resolve(ref: string) {
        return ref === "backend-1"
          ? { id: "active-1", name: "feature-work" }
          : undefined;
      },
      getPersistedSession(ref: string) {
        return ref === "legacy-1"
          ? { sessionId: "persisted-1", name: "feature-work" }
          : undefined;
      },
    };

    assert.deepEqual(
      resolveWorktreeToolSessions(sessionManager as any, {
        id: "session-1",
        name: "feature-work",
        backendConversationId: "backend-1",
        harnessSessionId: "legacy-1",
      }),
      {
        activeSession: { id: "active-1", name: "feature-work" },
        persistedSession: { sessionId: "persisted-1", name: "feature-work" },
      },
    );
  });

  it("resolves worktree lifecycle from the shared tool helper", () => {
    const resolved = resolveWorktreeToolLifecycle({
      resolve(ref: string) {
        return ref === "feature-work"
          ? { id: "active-1", name: "feature-work", status: "running" }
          : undefined;
      },
      getPersistedSession(ref: string) {
        return ref === "persisted-1"
          ? {
              sessionId: "persisted-1",
              name: "feature-work",
              workdir: "/definitely/missing/repo",
              worktreePath: "/definitely/missing/repo/.worktrees/feature-work",
              worktreeBranch: "agent/feature-work",
              worktreeBaseBranch: "main",
              worktreeLifecycle: {
                state: "pending_decision",
                updatedAt: "2026-04-07T00:00:00.000Z",
                baseBranch: "main",
              },
            }
          : undefined;
      },
    } as any, {
      id: "persisted-1",
      name: "feature-work",
      worktreePath: "/definitely/missing/repo/.worktrees/feature-work",
      worktreeBranch: "agent/feature-work",
      workdir: "/definitely/missing/repo",
      backendConversationId: undefined,
      harnessSessionId: undefined,
    });

    assert.equal(resolved.activeSession?.id, "active-1");
    assert.equal(resolved.persistedSession?.sessionId, "persisted-1");
    assert.equal(resolved.resolvedLifecycle.lifecycle.state, "pending_decision");
    assert.equal(resolved.resolvedLifecycle.preserve, true);
    assert.deepEqual(
      resolved.resolvedLifecycle.reasons,
      ["repo_missing", "worktree_missing", "active_session", "pending_decision"],
    );
  });

  it("formats lifecycle states and preserve reasons for worktree tools", () => {
    assert.equal(formatWorktreeLifecycleState("provisioned"), "active");
    assert.equal(formatWorktreeLifecycleState("custom"), "custom");
    assert.equal(formatWorktreePreserveReason("dirty_tracked_changes"), "dirty worktree");
    assert.equal(formatWorktreePreserveReason("custom_reason"), "custom reason");
  });
});
