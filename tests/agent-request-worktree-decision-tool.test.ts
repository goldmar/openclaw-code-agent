import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeAgentRequestWorktreeDecisionTool } from "../src/tools/agent-request-worktree-decision";
import { setSessionManager } from "../src/singletons";
import type { SessionManager } from "../src/session-manager";

describe("agent_request_worktree_decision tool", () => {
  afterEach(() => {
    setSessionManager(null);
  });

  it("returns an invalid-parameters error when summary is missing", async () => {
    setSessionManager({} as SessionManager);
    const tool = makeAgentRequestWorktreeDecisionTool();
    const result = await tool.execute("tool-id", { session: "s1" });
    const text = (result as any).content?.[0]?.text ?? "";
    assert.match(text, /Invalid parameters/);
  });

  it("delegates to SessionManager.requestWorktreeDecisionFromUser", async () => {
    const calls: Array<{ session: string; summary: string }> = [];
    setSessionManager({
      requestWorktreeDecisionFromUser(session: string, summary: string) {
        calls.push({ session, summary });
        return "Canonical worktree decision prompt sent for session test [s1]. Wait for the user's Merge, Open PR, Later, or Discard response. Do not send a separate plain-text worktree decision message.";
      },
    } as SessionManager);

    const tool = makeAgentRequestWorktreeDecisionTool();
    const result = await tool.execute("tool-id", {
      session: "s1",
      summary: "Risk: PR is safer\nScope: user-visible notification behavior",
    });

    assert.deepEqual(calls, [{ session: "s1", summary: "Risk: PR is safer\nScope: user-visible notification behavior" }]);
    assert.equal((result as any).isError, false);
    assert.match((result as any).content?.[0]?.text ?? "", /Canonical worktree decision prompt sent/);
  });
});
