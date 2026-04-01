import { Type } from "@sinclair/typebox";

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
    name: "goal_stop",
    description: "Stop an explicit goal task and kill its underlying agent session.",
    parameters: Type.Object({
      task: Type.String({ description: "Goal task name or ID" }),
    }),
    async execute(_id: string, params: unknown) {
      if (!goalController) {
        return { content: [{ type: "text", text: "Error: GoalController not initialized. The code-agent service must be running." }] };
      }
      if (!isGoalStopParams(params)) {
        return { content: [{ type: "text", text: "Error: Invalid parameters. Expected { task }." }] };
      }

      const task = goalController.stopTask(params.task);
      if (!task) {
        return { content: [{ type: "text", text: `Error: Goal task "${params.task}" not found.` }] };
      }

      return {
        content: [{
          type: "text",
          text: `Goal task ${task.name} [${task.id}] stopped.`,
        }],
      };
    },
  };
}
