import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { registerGoalCommand } from "../src/commands/goal";
import { setGoalController } from "../src/singletons";
import { makeAgentGoalTool } from "../src/tools/agent-goal";

describe("agent_goal edit", () => {
  afterEach(() => {
    setGoalController(null);
  });

  it("tool edits a running goal and reports success", async () => {
    let editCall: { ref: string; goal: string } | undefined;
    setGoalController({
      editTask(ref: string, goal: string) {
        editCall = { ref, goal };
        return {
          action: "updated",
          previousGoal: "Old goal",
          task: {
            id: "goal-1",
            name: "goal-task",
            status: "running",
          },
        };
      },
    } as any);

    const tool = makeAgentGoalTool({} as any);
    const result = await tool.execute("tool-id", {
      action: "edit",
      task: "goal-task",
      goal: "New goal",
    });

    assert.deepEqual(editCall, { ref: "goal-task", goal: "New goal" });
    assert.equal((result.content[0] as { text: string }).text, 'Task "goal-task" (goal-1) goal updated.');
  });

  it("command parses task ref and replacement goal", async () => {
    let editCall: { ref: string; goal: string } | undefined;
    setGoalController({
      editTask(ref: string, goal: string) {
        editCall = { ref, goal };
        return {
          action: "updated",
          previousGoal: "Old goal",
          task: {
            id: "goal-1",
            name: "goal-task",
            status: "running",
          },
        };
      },
    } as any);

    let handler: ((ctx: any) => Promise<{ text: string }>) | undefined;
    registerGoalCommand({
      registerCommand(command: { handler: typeof handler }) {
        handler = command.handler;
      },
    });

    const result = await handler?.({ args: 'edit goal-task New  goal   with spacing' });

    assert.deepEqual(editCall, { ref: "goal-task", goal: "New  goal   with spacing" });
    assert.equal(result?.text, 'Task "goal-task" (goal-1) goal updated.');
  });

  it("tool rejects invalid params before calling the controller", async () => {
    let called = false;
    setGoalController({
      editTask() {
        called = true;
        throw new Error("editTask should not be called");
      },
    } as any);

    const tool = makeAgentGoalTool({} as any);
    const result = await tool.execute("tool-id", { action: "edit", task: "goal-1" });

    assert.equal(called, false);
    assert.equal((result.content[0] as { text: string }).text, "Error: Invalid parameters. action 'edit' requires task and goal.");
  });

  it("reports already-terminal tasks without claiming they were edited", async () => {
    setGoalController({
      editTask() {
        return {
          action: "not_editable",
          task: {
            id: "goal-1",
            name: "goal-task",
            status: "succeeded",
          },
        };
      },
    } as any);

    const tool = makeAgentGoalTool({} as any);
    const result = await tool.execute("tool-id", {
      action: "edit",
      task: "goal-1",
      goal: "New goal",
    });

    assert.equal((result.content[0] as { text: string }).text, "Task is already succeeded.");
  });

  it("command reports non-running non-terminal states clearly", async () => {
    setGoalController({
      editTask() {
        return {
          action: "not_editable",
          task: {
            id: "goal-1",
            name: "goal-task",
            status: "waiting_for_user",
          },
        };
      },
    } as any);

    let handler: ((ctx: any) => Promise<{ text: string }>) | undefined;
    registerGoalCommand({
      registerCommand(command: { handler: typeof handler }) {
        handler = command.handler;
      },
    });

    const result = await handler?.({ args: "edit goal-1 New goal" });

    assert.equal(result?.text, 'Error: Goal task "goal-task" is waiting_for_user and cannot be edited.');
  });
});
