import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { registerAgentOutputCommand } from "../src/commands/agent-output";
import { setSessionManager } from "../src/singletons";

type AgentOutputCommandHandler = (ctx: { args?: string }) => { text: string };

function captureAgentOutputCommand(): AgentOutputCommandHandler {
  let handler: AgentOutputCommandHandler | undefined;
  registerAgentOutputCommand({
    registerCommand(command: { handler: AgentOutputCommandHandler }) {
      handler = command.handler;
    },
  });
  assert.ok(handler, "expected /agent_output handler");
  return handler;
}

describe("agent_output command", () => {
  afterEach(() => {
    setSessionManager(null);
  });

  it("supports quoted session names with flags", () => {
    let resolvedRef: string | undefined;
    setSessionManager({
      resolve(ref: string) {
        resolvedRef = ref;
        return {
          id: "sess-1",
          name: "agent command",
          status: "running",
          phase: "active",
          duration: 1000,
          costUsd: 0,
          getOutput() {
            return ["one", "two", "three"];
          },
        };
      },
      getPersistedSession: () => undefined,
    } as any);

    const handler = captureAgentOutputCommand();
    const result = handler({ args: '"agent command" --lines 2 --full' });

    assert.equal(resolvedRef, "agent command");
    assert.match(result.text, /agent command/);
    assert.match(result.text, /one\ntwo\nthree/);
  });
});
