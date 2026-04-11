import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeAgentShowFullPlanTool } from "../src/tools/agent-show-full-plan";
import { setSessionManager } from "../src/singletons";
import type { SessionManager } from "../src/session-manager";

describe("agent_show_full_plan tool", () => {
  afterEach(() => {
    setSessionManager(null);
  });

  it("returns an invalid-parameters error when session is missing", async () => {
    setSessionManager({} as SessionManager);
    const tool = makeAgentShowFullPlanTool();
    const result = await tool.execute("tool-id", {});
    const text = (result as any).content?.[0]?.text ?? "";
    assert.match(text, /Invalid parameters/);
  });

  it("delegates to SessionManager.sendFullPlanToUser", async () => {
    const calls: string[] = [];
    setSessionManager({
      sendFullPlanToUser(session: string) {
        calls.push(session);
        return "Full plan sent to the user for session test [s1]. The plugin reused the paginated plan renderer and approval buttons for this plan version.";
      },
    } as SessionManager);

    const tool = makeAgentShowFullPlanTool();
    const result = await tool.execute("tool-id", { session: "s1" });

    assert.deepEqual(calls, ["s1"]);
    assert.equal((result as any).isError, false);
    assert.match((result as any).content?.[0]?.text ?? "", /Full plan sent to the user/);
  });
});
