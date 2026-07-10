import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeGoalEditTool } from "../src/tools/goal-edit";
import { makeGoalLaunchTool } from "../src/tools/goal-launch";
import { makeGoalStatusTool } from "../src/tools/goal-status";
import { makeGoalStopTool } from "../src/tools/goal-stop";

describe("agent goal tool names", () => {
  it("exposes goal tools through the agent_goal namespace", () => {
    assert.equal(makeGoalLaunchTool({} as any).name, "agent_goal_launch");
    assert.equal(makeGoalStatusTool({} as any).name, "agent_goal_status");
    assert.equal(makeGoalStopTool({} as any).name, "agent_goal_stop");
    assert.equal(makeGoalEditTool({} as any).name, "agent_goal_edit");
  });
});
