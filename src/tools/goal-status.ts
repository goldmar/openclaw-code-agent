import { Type } from "../tool-schema";

import { GOAL_CONTROLLER_MISSING_MESSAGE, renderGoalStatus } from "../application/goal-view";
import { goalController, sessionManager } from "../singletons";
import type { OpenClawPluginToolContext } from "../types";

interface GoalStatusParams {
  task?: string;
}

export function makeGoalStatusTool(_ctx: OpenClawPluginToolContext) {
  return {
    name: "agent_goal_status",
    description: "Show status for explicit goal tasks managed by the goal controller. Use this to inspect one goal task or list all goal tasks.",
    parameters: Type.Object({
      task: Type.Optional(Type.String({ description: "Task name or ID. Omit to list all tasks." })),
    }),
    async execute(_id: string, params: unknown) {
      if (!goalController) {
        return { content: [{ type: "text", text: GOAL_CONTROLLER_MISSING_MESSAGE }] };
      }

      const taskRef = params && typeof params === "object" && typeof (params as GoalStatusParams).task === "string"
        ? (params as GoalStatusParams).task
        : undefined;

      return {
        content: [{
          type: "text",
          text: renderGoalStatus(goalController, (sessionId) => sessionManager?.resolve(sessionId), taskRef),
        }],
      };
    },
  };
}
