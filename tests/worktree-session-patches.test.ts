import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildMergeConflictResolvingPatch,
  buildMergedPatch,
  buildPendingDecisionPatch,
} from "../src/worktree-session-patches";

const CONTEXT = {
  worktreeBaseBranch: "main",
  worktreePrTargetRepo: "openai/codex",
  worktreePushRemote: "origin",
};

describe("worktree session patch helpers", () => {
  it("builds a canonical pending-decision transition", () => {
    const patch = buildPendingDecisionPatch(CONTEXT, {
      updatedAt: "2026-04-10T10:00:00.000Z",
      pendingSince: "2026-04-10T10:00:00.000Z",
      notes: ["manual_follow_up_required"],
      clearResolverSessionId: true,
    });

    assert.equal(patch.lifecycle, "awaiting_worktree_decision");
    assert.equal(patch.worktreeState, "pending_decision");
    assert.equal(patch.pendingWorktreeDecisionSince, "2026-04-10T10:00:00.000Z");
    assert.equal(patch.lastWorktreeReminderAt, undefined);
    assert.equal(patch.autoMergeResolverSessionId, undefined);
    assert.deepEqual(patch.worktreeLifecycle, {
      state: "pending_decision",
      updatedAt: "2026-04-10T10:00:00.000Z",
      baseBranch: "main",
      targetRepo: "openai/codex",
      pushRemote: "origin",
      notes: ["manual_follow_up_required"],
    });
  });

  it("builds a canonical conflict-resolving transition", () => {
    const patch = buildMergeConflictResolvingPatch(
      CONTEXT,
      "resolver-1",
      1,
      { updatedAt: "2026-04-10T10:05:00.000Z", notes: ["resolver_session:resolver-1"] },
    );

    assert.equal(patch.lifecycle, "terminal");
    assert.equal(patch.worktreeState, "merge_conflict_resolving");
    assert.equal(patch.autoMergeResolverSessionId, "resolver-1");
    assert.equal(patch.autoMergeConflictResolutionAttemptCount, 1);
    assert.equal(patch.pendingWorktreeDecisionSince, undefined);
    assert.deepEqual(patch.worktreeLifecycle, {
      state: "merge_conflict_resolving",
      updatedAt: "2026-04-10T10:05:00.000Z",
      baseBranch: "main",
      targetRepo: "openai/codex",
      pushRemote: "origin",
      notes: ["resolver_session:resolver-1"],
    });
  });

  it("builds a canonical merged transition", () => {
    const patch = buildMergedPatch(CONTEXT, {
      mergedAt: "2026-04-10T10:10:00.000Z",
      updatedAt: "2026-04-10T10:10:00.000Z",
      resolvedAt: "2026-04-10T10:10:00.000Z",
      clearResolverSessionId: true,
    });

    assert.equal(patch.lifecycle, "terminal");
    assert.equal(patch.worktreeState, "merged");
    assert.equal(patch.worktreeMerged, true);
    assert.equal(patch.worktreeMergedAt, "2026-04-10T10:10:00.000Z");
    assert.equal(patch.autoMergeResolverSessionId, undefined);
    assert.deepEqual(patch.worktreeLifecycle, {
      state: "merged",
      updatedAt: "2026-04-10T10:10:00.000Z",
      resolvedAt: "2026-04-10T10:10:00.000Z",
      resolutionSource: "agent_merge",
      baseBranch: "main",
      targetRepo: "openai/codex",
      pushRemote: "origin",
    });
  });
});
