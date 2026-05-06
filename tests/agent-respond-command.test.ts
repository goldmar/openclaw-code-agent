import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { registerAgentRespondCommand } from "../src/commands/agent-respond";
import { setSessionManager } from "../src/singletons";

type AgentRespondCommandHandler = (ctx: { args?: string }) => Promise<{ text: string }>;

function captureAgentRespondCommand(): AgentRespondCommandHandler {
  let handler: AgentRespondCommandHandler | undefined;
  registerAgentRespondCommand({
    registerCommand(command: { handler: AgentRespondCommandHandler }) {
      handler = command.handler;
    },
  });
  assert.ok(handler, "expected /agent_respond handler");
  return handler;
}

describe("agent_respond command", () => {
  afterEach(() => {
    setSessionManager(null);
  });

  it("supports quoted session names and preserves the follow-up message text", async () => {
    let sentMessage: string | undefined;
    setSessionManager({
      resolve(ref: string) {
        if (ref !== "agent command") return undefined;
        return {
          id: "sess-1",
          name: "agent command",
          status: "running",
          lifecycle: "active",
          currentPermissionMode: "default",
          pendingPlanApproval: false,
          autoRespondCount: 0,
          resetAutoRespond() {},
          async interrupt() { return false; },
          async sendMessage(message: string) {
            sentMessage = message;
          },
        };
      },
      getPersistedSession: () => undefined,
      notifySession: () => {},
    } as any);

    const handler = captureAgentRespondCommand();
    const result = await handler({ args: '"agent command" continue  with   spacing' });

    assert.match(result.text, /Message sent to session agent command \[sess-1\]/);
    assert.equal(sentMessage, "continue  with   spacing");
  });
});
