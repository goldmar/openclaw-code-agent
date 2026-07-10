import { Type } from "../tool-schema";

import { GOAL_CONTROLLER_MISSING_MESSAGE, renderGoalEditResult } from "../application/goal-view";
import { goalController } from "../singletons";
import type { OpenClawPluginToolContext } from "../types";

interface GoalEditParams {
  task: string;
  goal: string;
}

function isGoalEditParams(value: unknown): value is GoalEditParams {
  if (!value || typeof value !== "object") return false;
  const params = value as Record<string, unknown>;
  return typeof params.task === "string" && typeof params.goal === "string";
}

export { renderGoalEditResult as formatGoalEditResult };

export function makeGoalEditTool(_ctx: OpenClawPluginToolContext) {
  return {
    name: "agent_goal_edit",
    description: "Edit the goal text for an active goal task without stopping or relaunching its session.",
    parameters: Type.Object({
      task: Type.String({ description: "Goal task name or ID" }),
      goal: Type.String({ description: "Replacement goal text" }),
    }),
    async execute(_id: string, params: unknown) {
      if (!goalController) {
        return { content: [{ type: "text", text: GOAL_CONTROLLER_MISSING_MESSAGE }] };
      }
      if (!isGoalEditParams(params)) {
        return { content: [{ type: "text", text: "Error: Invalid parameters. Expected { task, goal }." }] };
      }

      const result = goalController.editTask(params.task, params.goal);
      return {
        content: [{
          type: "text",
          text: renderGoalEditResult(result, params.task),
        }],
      };
    },
  };
}
