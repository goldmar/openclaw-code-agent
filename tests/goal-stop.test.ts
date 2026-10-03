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

    assert.equal(result?.text, "ℹ️ [goal-task] Already succeeded; nothing to stop.");
  });

  it("command answers a stop with the task's one stop notice in its own chat", async () => {
    let handler: ((ctx: any) => Promise<{ text: string }>) | undefined;
    const task = { id: "goal-1", name: "goal-task", status: "stopped", route: { provider: "telegram", target: "12345", threadId: "42" } };
    const sameChat: boolean[] = [];
    setGoalController({
      stopTask(ref: string, reply: { sameChat: (task: unknown) => boolean; text?: string }) {
        if (ref === "missing") return undefined;
        sameChat.push(reply.sameChat(task));
        reply.text = "⛔ [goal-task] Goal task stopped | $0.25 | 1m1s\n\nStopped by user.";
        return { action: "stopped", task };
      },
    } as any);
    registerGoalCommand({
      registerCommand(command: { handler: typeof handler }) {
        handler = command.handler;
      },
    });

    const inChat = await handler?.({ args: "stop goal-1", deliveryContext: { channel: "telegram", to: "12345", threadId: 42 } });
    const elsewhere = await handler?.({ args: "stop goal-1", deliveryContext: { channel: "telegram", to: "12345", threadId: 7 } });
    const missing = await handler?.({ args: "stop missing" });

    // In the task's chat the notice is not sent as well; elsewhere it stays there.
    assert.deepEqual(sameChat, [true, false]);
    assert.equal(inChat?.text, "⛔ [goal-task] Goal task stopped | $0.25 | 1m1s\n\nStopped by user.");
    // From another chat: a short line, like /agent_kill; the full notice is in the task's chat.
    assert.equal(elsewhere?.text, "⛔ [goal-task] Stopped.");
    assert.equal(missing?.text, '❌ Goal task "missing" not found.');
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
