import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeGoalEditTool } from "../src/tools/goal-edit";
import { makeGoalLaunchTool } from "../src/tools/goal-launch";
import { makeGoalStatusTool, resolveGoalStatusRef } from "../src/tools/goal-status";
import { makeGoalStopTool } from "../src/tools/goal-stop";

describe("agent goal tool names", () => {
  it("exposes goal tools through the agent_goal namespace", () => {
    assert.equal(makeGoalLaunchTool({} as any).name, "agent_goal_launch");
    assert.equal(makeGoalStatusTool({} as any).name, "agent_goal_status");
    assert.equal(makeGoalStopTool({} as any).name, "agent_goal_stop");
    assert.equal(makeGoalEditTool({} as any).name, "agent_goal_edit");
  });
});

describe("agent_goal_status filtering", () => {
  it("filters by task, name, or id instead of listing every goal", () => {
    assert.equal(resolveGoalStatusRef({ task: "fix-auth" }), "fix-auth");
    assert.equal(resolveGoalStatusRef({ name: "fix-auth" }), "fix-auth");
    assert.equal(resolveGoalStatusRef({ id: "goal-1" }), "goal-1");
    assert.equal(resolveGoalStatusRef({ name: "  " }), undefined);
    assert.equal(resolveGoalStatusRef({}), undefined);
  });
});
