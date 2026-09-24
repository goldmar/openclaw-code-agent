import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeAgentRequestPlanApprovalTool } from "../src/tools/agent-request-plan-approval";
import { setSessionManager } from "../src/singletons";
import type { SessionManager } from "../src/session-manager";

describe("agent_request_plan_approval tool", () => {
  afterEach(() => {
    setSessionManager(null);
  });

  it("returns an invalid-parameters error when summary is missing", async () => {
    setSessionManager({} as SessionManager);
    const tool = makeAgentRequestPlanApprovalTool();
    const result = await tool.execute("tool-id", { session: "s1" });
    const text = (result as any).content?.[0]?.text ?? "";
    assert.match(text, /Invalid parameters/);
  });

  it("delegates to SessionManager.requestPlanApprovalFromUser", async () => {
    const calls: Array<{ session: string; summary: string }> = [];
    setSessionManager({
      requestPlanApprovalFromUser(session: string, summary: string) {
        calls.push({ session, summary });
        return "Canonical plan approval prompt queued for session test [s1]. Wait for the user's Approve, Revise, or Reject response. Do not send a separate plain-text approval message.";
      },
    } as SessionManager);

    const tool = makeAgentRequestPlanApprovalTool();
    const result = await tool.execute("tool-id", {
      session: "s1",
      summary: "Risk: low\nScope: in bounds",
    });

    assert.deepEqual(calls, [{ session: "s1", summary: "Risk: low\nScope: in bounds" }]);
    assert.equal((result as any).isError, false);
    assert.match((result as any).content?.[0]?.text ?? "", /Canonical plan approval prompt queued/);
  });
});
