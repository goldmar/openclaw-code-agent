import "./test-env";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeAgentRespondTool } from "../src/tools/agent-respond";
import { setSessionManager } from "../src/singletons";
import type { SessionManager } from "../src/session-manager";
import { createStubSession } from "./helpers";
import { FollowUpDeliveryUnconfirmedError } from "../src/harness/follow-up-delivery-error";

describe("agent_respond tool parameter validation", () => {
  afterEach(() => {
    setSessionManager(null);
  });

  it("returns an invalid-parameters error when message is missing", async () => {
    setSessionManager({} as SessionManager);
    const tool = makeAgentRespondTool();
    const result = await tool.execute("tool-id", { session: "s1" });
    const text = (result as any).content?.[0]?.text ?? "";
    assert.match(text, /Invalid parameters/);
  });

  it("returns an invalid-parameters error when session is missing", async () => {
    setSessionManager({} as SessionManager);
    const tool = makeAgentRespondTool();
    const result = await tool.execute("tool-id", { message: "hello" });
    const text = (result as any).content?.[0]?.text ?? "";
    assert.match(text, /Invalid parameters/);
  });

  it("accepts approval_rationale when it is a string", async () => {
    setSessionManager({
      resolve: (): undefined => undefined,
      getPersistedSession: (): undefined => undefined,
    } as unknown as SessionManager);
    const tool = makeAgentRespondTool();
    const result = await tool.execute("tool-id", {
      session: "s1",
      message: "Approved. Go ahead.",
      approve: true,
      approval_rationale: "Low risk and in scope.",
    });
    const text = (result as any).content?.[0]?.text ?? "";
    assert.doesNotMatch(text, /Invalid parameters/);
    assert.match(text, /Session not found/);
  });

  it("returns native unconfirmed delivery without leaking input or asserting no side effect", async () => {
    const sent: string[] = [];
    const session = createStubSession({ id: "PRIVATE_ID", name: "PRIVATE_NAME", currentPermissionMode: "default",
      sendMessage: async (message: string) => { sent.push(message); throw new FollowUpDeliveryUnconfirmedError(); },
    });
    setSessionManager({ resolve: () => session } as unknown as SessionManager);
    const result = await makeAgentRespondTool().execute("same-call-id", { session: "PRIVATE_ID", message: "PRIVATE_MESSAGE" });
    assert.equal(result.isError, true);
    assert.deepEqual(result.details, { status: "error", code: "response_delivery_unconfirmed", targetSelected: true,
      recovery: "Check the originally selected exact session with authorized agent_output before explicitly deciding whether to send again.",
    });
    assert.ok(!("operationStarted" in result.details!));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ID|PRIVATE_NAME|PRIVATE_MESSAGE/);
    assert.match(result.content[0].text, /Error: Follow-up delivery was not confirmed/);
    assert.deepEqual(sent, ["PRIVATE_MESSAGE"]);
    assert.equal(session.autoRespondCount, 0);
  });
});
