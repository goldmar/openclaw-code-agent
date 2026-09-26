import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { registerGoalCommand } from "../src/commands/goal";
import { setGoalController } from "../src/singletons";
import { agentGoalParamsError, makeAgentGoalTool } from "../src/tools/agent-goal";

describe("agent_goal tool", () => {
  afterEach(() => setGoalController(null));

  it("is one tool with a launch | status | edit | stop action", () => {
    const tool = makeAgentGoalTool({} as any);
    assert.equal(tool.name, "agent_goal");
    const action = (tool.parameters as any).properties.action;
    assert.deepEqual(action.enum, ["launch", "status", "edit", "stop"]);
    assert.equal(action.type, "string");
    // The removed status aliases are gone.
    assert.equal((tool.parameters as any).properties.id, undefined);
  });

  it("validates the fields each action needs", () => {
    assert.match(agentGoalParamsError({}) ?? "", /action must be one of/);
    assert.match(agentGoalParamsError({ action: "launch" }) ?? "", /requires goal/);
    assert.match(agentGoalParamsError({ action: "stop" }) ?? "", /requires task/);
    assert.match(agentGoalParamsError({ action: "edit", task: "t" }) ?? "", /requires task and goal/);
    assert.equal(agentGoalParamsError({ action: "status" }), undefined);
    assert.equal(agentGoalParamsError({ action: "launch", goal: "g" }), undefined);
  });

  it("status filters by task instead of listing every goal", async () => {
    const seen: string[] = [];
    setGoalController({
      getTask(ref: string): undefined { seen.push(ref); return undefined; },
      listTasks(): never[] { seen.push("*"); return []; },
    } as any);
    const tool = makeAgentGoalTool({} as any);
    const one = await tool.execute("id", { action: "status", task: "fix-auth" });
    const all = await tool.execute("id", { action: "status" });
    assert.deepEqual(seen, ["fix-auth", "*"]);
    assert.match((one.content[0] as { text: string }).text, /not found/);
    assert.equal((all.content[0] as { text: string }).text, "No goal tasks found.");
  });

  it("/agent_goal status|stop|edit subcommands route to the controller; other text launches", async () => {
    const calls: string[] = [];
    setGoalController({
      getTask: (): undefined => undefined,
      listTasks: (): never[] => [],
      stopTask: (ref: string): undefined => { calls.push(`stop:${ref}`); return undefined; },
      editTask: (ref: string, goal: string) => { calls.push(`edit:${ref}:${goal}`); return { action: "not_found" }; },
    } as any);
    let handler: ((ctx: any) => Promise<{ text: string }>) | undefined;
    registerGoalCommand({ registerCommand(command: any) { handler = command.handler; } });
    assert.equal((await handler!({ args: "status" })).text, "No goal tasks found.");
    await handler!({ args: "stop t1" });
    await handler!({ args: "edit t1 new goal text" });
    assert.deepEqual(calls, ["stop:t1", "edit:t1:new goal text"]);
    assert.match((await handler!({ args: "stop" })).text, /Usage: \/agent_goal stop/);
    assert.match((await handler!({ args: "" })).text, /\/agent_goal status/);
  });
});
