import { Type } from "@sinclair/typebox";

import { buildGoalTaskRuntimeSnapshot, formatGoalTask } from "../goal-format";
import { goalController, sessionManager } from "../singletons";
import type { OpenClawPluginToolContext } from "../types";

interface GoalStatusParams {
  task?: string;
}

export function makeGoalStatusTool(_ctx: OpenClawPluginToolContext) {
  return {
    name: "goal_status",
    description: "Show status for explicit goal tasks managed by the goal controller. Use this to inspect one goal task or list all goal tasks.",
    parameters: Type.Object({
      task: Type.Optional(Type.String({ description: "Task name or ID. Omit to list all tasks." })),
    }),
    async execute(_id: string, params: unknown) {
      if (!goalController) {
        return { content: [{ type: "text", text: "Error: GoalController not initialized. The code-agent service must be running." }] };
      }

      const taskRef = params && typeof params === "object" && typeof (params as GoalStatusParams).task === "string"
        ? (params as GoalStatusParams).task
        : undefined;

      if (taskRef) {
        const task = goalController.getTask(taskRef);
        if (!task) {
          return { content: [{ type: "text", text: `Error: Goal task "${taskRef}" not found.` }] };
        }
        const session = task.sessionId ? sessionManager?.resolve(task.sessionId) : undefined;
        return { content: [{ type: "text", text: formatGoalTask(task, buildGoalTaskRuntimeSnapshot(session)) }] };
      }

      const tasks = goalController.listTasks();
      if (tasks.length === 0) {
        return { content: [{ type: "text", text: "No goal tasks found." }] };
      }

      return {
        content: [{
          type: "text",
          text: tasks.map((task) => {
            const session = task.sessionId ? sessionManager?.resolve(task.sessionId) : undefined;
            return formatGoalTask(task, buildGoalTaskRuntimeSnapshot(session));
          }).join("\n\n"),
        }],
      };
    },
  };
}
