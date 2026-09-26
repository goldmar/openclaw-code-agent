import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeAgentEscalateTool } from "../src/tools/agent-escalate";
import { setSessionManager } from "../src/singletons";
import type { SessionManager } from "../src/session-manager";

function textOf(result: unknown): string {
  return (result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "";
}

describe("agent_escalate tool", () => {
  afterEach(() => {
    setSessionManager(null);
  });

  it("rejects a missing summary or an unknown kind", async () => {
    setSessionManager({} as SessionManager);
    const tool = makeAgentEscalateTool();
    for (const params of [{ session: "s1", kind: "plan" }, { session: "s1", kind: "merge", summary: "x" }, { session: "s1", kind: "plan", summary: "  " }]) {
      const result = await tool.execute("tool-id", params);
      assert.equal((result as { isError?: boolean }).isError, true);
      assert.match(textOf(result), /Invalid parameters/);
    }
  });

  it("kind=plan posts the plan decision prompt through SessionManager.requestPlanApprovalFromUser", async () => {
    const calls: Array<{ session: string; summary: string }> = [];
    setSessionManager({
      requestPlanApprovalFromUser(session: string, summary: string) {
        calls.push({ session, summary });
        return "Canonical plan approval prompt queued for session test [s1].";
      },
    } as SessionManager);

    const result = await makeAgentEscalateTool().execute("tool-id", {
      session: "s1",
      kind: "plan",
      summary: "Risk: low\nScope: in bounds",
    });

    assert.deepEqual(calls, [{ session: "s1", summary: "Risk: low\nScope: in bounds" }]);
    assert.equal((result as { isError?: boolean }).isError, false);
    assert.match(textOf(result), /Canonical plan approval prompt queued/);
  });

  it("kind=worktree posts the worktree decision prompt through SessionManager.requestWorktreeDecisionFromUser", async () => {
    const calls: Array<{ session: string; summary: string }> = [];
    setSessionManager({
      async requestWorktreeDecisionFromUser(session: string, summary: string) {
        calls.push({ session, summary });
        return "Canonical worktree decision prompt sent for session test [s1].";
      },
    } satisfies Pick<SessionManager, "requestWorktreeDecisionFromUser"> as unknown as SessionManager);

    const result = await makeAgentEscalateTool().execute("tool-id", {
      session: "s1",
      kind: "worktree",
      summary: "Risk: PR is safer",
    });

    assert.deepEqual(calls, [{ session: "s1", summary: "Risk: PR is safer" }]);
    assert.equal((result as { isError?: boolean }).isError, false);
    assert.match(textOf(result), /Canonical worktree decision prompt sent/);
  });

  it("reports a SessionManager error as a tool error", async () => {
    setSessionManager({
      requestPlanApprovalFromUser: () => "Error: Session s1 is not waiting on plan approval.",
    } as unknown as SessionManager);
    const result = await makeAgentEscalateTool().execute("tool-id", { session: "s1", kind: "plan", summary: "why" });
    assert.equal((result as { isError?: boolean }).isError, true);
  });
});
