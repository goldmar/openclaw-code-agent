import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { listWorktreeToolTargets, matchesWorktreeToolRef } from "../src/tools/worktree-tool-context";

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
});
