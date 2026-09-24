import { Type } from "../tool-parameter-schema";

import { GOAL_CONTROLLER_MISSING_MESSAGE, renderGoalStatus } from "../application/goal-view";
import { goalController, sessionManager } from "../singletons";
import type { OpenClawPluginToolContext } from "../types";

interface GoalStatusParams {
  task?: string;
  name?: string;
  id?: string;
}

/** `task` is canonical; `name` and `id` are accepted as aliases so a filtered call never lists every goal. */
export function resolveGoalStatusRef(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const record = params as GoalStatusParams;
  for (const value of [record.task, record.name, record.id]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function makeGoalStatusTool(_ctx: OpenClawPluginToolContext) {
  return {
    name: "agent_goal_status",
    description: "Show status for explicit goal tasks managed by the goal controller. Use this to inspect one goal task or list all goal tasks.",
    parameters: Type.Object({
      task: Type.Optional(Type.String({ description: "Task name or ID. Omit to list all tasks." })),
      name: Type.Optional(Type.String({ description: "Alias for task: goal task name or ID." })),
    }),
    async execute(_id: string, params: unknown) {
      if (!goalController) {
        return { content: [{ type: "text", text: GOAL_CONTROLLER_MISSING_MESSAGE }] };
      }

      const taskRef = resolveGoalStatusRef(params);

      return {
        content: [{
          type: "text",
          text: renderGoalStatus(goalController, (sessionId) => sessionManager?.resolve(sessionId), taskRef),
        }],
      };
    },
  };
}
