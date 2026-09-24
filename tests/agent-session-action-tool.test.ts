import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeAgentSessionActionTool, resolveReviewTarget } from "../src/tools/agent-session-action";
import { setSessionManager } from "../src/singletons";

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[0]?.text ?? "";
}

describe("agent_session_action tool (B12, B13)", () => {
  afterEach(() => setSessionManager(null));

  it("defaults worktree reviews to the branch diff and plain sessions to uncommitted changes", () => {
    assert.deepEqual(resolveReviewTarget({}, { worktreeBranch: "agent/x", worktreeBaseBranch: "develop" } as any), {
      kind: "ok",
      action: { kind: "review", target: { type: "baseBranch", branch: "develop" } },
    });
    assert.deepEqual(resolveReviewTarget({}, { worktreeBranch: "agent/x", worktreeParentBranch: "main" } as any), {
      kind: "ok",
      action: { kind: "review", target: { type: "baseBranch", branch: "main" } },
    });
    assert.deepEqual(resolveReviewTarget({}, {} as any), {
      kind: "ok",
      action: { kind: "review", target: { type: "uncommittedChanges" } },
    });
    assert.deepEqual(resolveReviewTarget({ commit_sha: "abc123" }, {} as any), {
      kind: "ok",
      action: { kind: "review", target: { type: "commit", sha: "abc123" } },
    });
    assert.deepEqual(resolveReviewTarget({ review_target: "custom", instructions: "Focus on auth" }, {} as any), {
      kind: "ok",
      action: { kind: "review", target: { type: "custom", instructions: "Focus on auth" } },
    });
    assert.equal(resolveReviewTarget({ review_target: "base_branch" }, {} as any).kind, "error");
    assert.equal(resolveReviewTarget({ review_target: "commit" }, {} as any).kind, "error");
  });

  it("queues the action on the running session", async () => {
    const requested: unknown[] = [];
    setSessionManager({
      resolve: () => ({
        id: "s1",
        name: "fix-auth",
        worktreeBranch: "agent/fix-auth",
        worktreeBaseBranch: "main",
        status: "running",
        requestThreadAction: (action: unknown) => { requested.push(action); },
      }),
    } as any);
    const tool = makeAgentSessionActionTool();
    assert.match(text(await tool.execute("id", { session: "fix-auth", action: "compact" })), /Context compaction queued for session fix-auth \[s1\]/);
    assert.match(text(await tool.execute("id", { session: "fix-auth", action: "review" })), /Code review against main queued/);
    assert.deepEqual(requested, [
      { kind: "compact" },
      { kind: "review", target: { type: "baseBranch", branch: "main" } },
    ]);
  });

  it("refuses an action on a finished session instead of reporting it queued", async () => {
    let requested = 0;
    setSessionManager({
      resolve: () => ({ id: "s2", name: "done", status: "completed", requestThreadAction: () => { requested += 1; } }),
    } as any);
    const result = await makeAgentSessionActionTool().execute("id", { session: "done", action: "review" }) as any;
    assert.equal(result.isError, true);
    assert.match(text(result), /is completed, not running, so the review was not queued/);
    assert.doesNotMatch(text(result), /queued for session/);
    assert.equal(requested, 0);
  });

  it("reports unsupported harnesses, inactive sessions, and invalid parameters", async () => {
    setSessionManager({
      resolve: (ref: string) => ref === "claude"
        ? { id: "c", name: "claude", status: "running", requestThreadAction: () => { throw new Error('The claude-code harness does not support the "compact" thread action.'); } }
        : undefined,
    } as any);
    const tool = makeAgentSessionActionTool();
    assert.match(text(await tool.execute("id", { session: "claude", action: "compact" })), /does not support the "compact" thread action/);
    assert.match(text(await tool.execute("id", { session: "gone", action: "compact" })), /is not active/);
    assert.match(text(await tool.execute("id", { session: "claude", action: "delete" })), /Invalid parameters/);
  });
});
