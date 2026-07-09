import { Type } from "../tool-schema";

import { GOAL_CONTROLLER_MISSING_MESSAGE, renderGoalStopResult } from "../application/goal-view";
import { goalController } from "../singletons";
import type { OpenClawPluginToolContext } from "../types";

interface GoalStopParams {
  task: string;
}

function isGoalStopParams(value: unknown): value is GoalStopParams {
  return Boolean(value) && typeof value === "object" && typeof (value as GoalStopParams).task === "string";
}

export function makeGoalStopTool(_ctx: OpenClawPluginToolContext) {
  return {
    name: "agent_goal_stop",
    description: "Stop an explicit goal task and kill its underlying agent session.",
    parameters: Type.Object({
      task: Type.String({ description: "Goal task name or ID" }),
    }),
    async execute(_id: string, params: unknown) {
      if (!goalController) {
        return { content: [{ type: "text", text: GOAL_CONTROLLER_MISSING_MESSAGE }] };
      }
      if (!isGoalStopParams(params)) {
        return { content: [{ type: "text", text: "Error: Invalid parameters. Expected { task }." }] };
      }

      const result = goalController.stopTask(params.task);
      return {
        content: [{
          type: "text",
          text: renderGoalStopResult(result, params.task),
        }],
      };
    },
  };
}
