import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { registerGoalStopCommand } from "../src/commands/goal-stop";
import { setGoalController } from "../src/singletons";
import { makeGoalStopTool } from "../src/tools/goal-stop";

describe("goal_stop surfaces already-terminal tasks clearly", () => {
  afterEach(() => {
    setGoalController(null);
  });

  it("command reports already-terminal tasks without claiming they were stopped", () => {
    let handler: ((ctx: any) => { text: string }) | undefined;
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

    registerGoalStopCommand({
      registerCommand(command: { handler: typeof handler }) {
        handler = command.handler;
      },
    });

    const result = handler?.({ args: "goal-1" });

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

    const tool = makeGoalStopTool({} as any);
    const result = await tool.execute("tool-id", { task: "goal-1" });

    assert.equal((result.content[0] as { text: string }).text, "Task is already failed.");
  });
});
