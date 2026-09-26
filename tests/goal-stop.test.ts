import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { registerGoalCommand } from "../src/commands/goal";
import { setGoalController } from "../src/singletons";
import { makeAgentGoalTool } from "../src/tools/agent-goal";

describe("agent_goal stop surfaces already-terminal tasks clearly", () => {
  afterEach(() => {
    setGoalController(null);
  });

  it("command reports already-terminal tasks without claiming they were stopped", async () => {
    let handler: ((ctx: any) => Promise<{ text: string }>) | undefined;
    setGoalController({
      stopTask() {
        return {
          action: "already_terminal",
          task: {
            id: "goal-1",
            name: "goal-task",
            status: "succeeded",
          },
        };
      },
    } as any);

    registerGoalCommand({
      registerCommand(command: { handler: typeof handler }) {
        handler = command.handler;
      },
    });

    const result = await handler?.({ args: "stop goal-1" });

    assert.equal(result?.text, "Task is already succeeded.");
  });

  it("tool reports already-terminal tasks without claiming they were stopped", async () => {
    setGoalController({
      stopTask() {
        return {
          action: "already_terminal",
          task: {
            id: "goal-1",
            name: "goal-task",
            status: "failed",
          },
        };
      },
    } as any);

    const tool = makeAgentGoalTool({} as any);
    const result = await tool.execute("tool-id", { action: "stop", task: "goal-1" });

    assert.equal((result.content[0] as { text: string }).text, "Task is already failed.");
  });
});
