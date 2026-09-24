import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeAgentKillTool } from "../src/tools/agent-kill";
import { setSessionManager } from "../src/singletons";

function fakeSessionManager() {
  const killed: string[] = [];
  const session = { id: "s-run", name: "runner", status: "running" };
  const sm = {
    resolve: (ref: string) => (ref === "runner" || ref === "s-run" ? session : undefined),
    getPersistedSession: () => undefined,
    kill: (id: string) => { killed.push(id); return true; },
  };
  return { sm, killed };
}

const text = (result: { content: Array<{ text: string }> }): string => result.content[0]!.text;

describe("agent_kill tool parameters", () => {
  afterEach(() => setSessionManager(null));

  it("declares a closed parameter schema", () => {
    const tool = makeAgentKillTool();
    assert.equal((tool.parameters as { additionalProperties?: unknown }).additionalProperties, false);
  });

  it("kills a running session with valid parameters", async () => {
    const { sm, killed } = fakeSessionManager();
    setSessionManager(sm as never);
    const result = await makeAgentKillTool().execute("id", { session: "runner" });
    assert.match(text(result), /Session runner \[s-run\] has been terminated\./);
    assert.deepEqual(killed, ["s-run"]);
  });

  it("refuses unknown parameters instead of killing the session", async () => {
    const { sm, killed } = fakeSessionManager();
    setSessionManager(sm as never);
    const tool = makeAgentKillTool();
    for (const params of [{ session: "runner", purge: true }, { session: "runner", reason: "killed", extra: 1 }]) {
      assert.match(text(await tool.execute("id", params)), /Invalid parameters\. Expected \{ session, reason\? \}\./);
    }
    assert.match(text(await tool.execute("id", { session: "runner", reason: "stopped" })), /Invalid parameters/);
    assert.deepEqual(killed, [], "no invalid call reaches kill");
  });
});
