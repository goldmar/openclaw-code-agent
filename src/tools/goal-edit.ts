import { Type } from "../tool-schema";

import { goalController } from "../singletons";
import type { GoalTaskEditResult } from "../goal-controller";
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

export function formatGoalEditResult(result: GoalTaskEditResult, ref: string): string {
  switch (result.action) {
    case "updated":
      return `Task "${result.task.name}" (${result.task.id}) goal updated.`;
    case "not_found":
      return `Error: Goal task "${ref}" not found.`;
    case "invalid_goal":
      return "Error: replacement goal must not be empty.";
    case "not_editable":
      if (result.task.status !== "waiting_for_user") {
        return `Task is already ${result.task.status}.`;
      }
      return `Error: Goal task "${result.task.name}" is ${result.task.status} and cannot be edited.`;
  }
}

export function makeGoalEditTool(_ctx: OpenClawPluginToolContext) {
  return {
    name: "goal_edit",
    description: "Edit the goal text for an active goal task without stopping or relaunching its session.",
    parameters: Type.Object({
      task: Type.String({ description: "Goal task name or ID" }),
      goal: Type.String({ description: "Replacement goal text" }),
    }),
    async execute(_id: string, params: unknown) {
      if (!goalController) {
        return { content: [{ type: "text", text: "Error: GoalController not initialized. The code-agent service must be running." }] };
      }
      if (!isGoalEditParams(params)) {
        return { content: [{ type: "text", text: "Error: Invalid parameters. Expected { task, goal }." }] };
      }

      const result = goalController.editTask(params.task, params.goal);
      return {
        content: [{
          type: "text",
          text: formatGoalEditResult(result, params.task),
        }],
      };
    },
  };
}
