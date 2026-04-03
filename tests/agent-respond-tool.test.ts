import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeAgentRespondTool } from "../src/tools/agent-respond";
import { setSessionManager } from "../src/singletons";
import type { SessionManager } from "../src/session-manager";

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
      resolve: () => undefined,
      getPersistedSession: () => undefined,
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
    assert.match(text, /Session "s1" not found/);
  });
});
