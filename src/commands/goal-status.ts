import { buildGoalTaskRuntimeSnapshot, formatGoalTask } from "../goal-format";
import { goalController, sessionManager } from "../singletons";

export function registerGoalStatusCommand(api: any): void {
  api.registerCommand({
    name: "goal_status",
    description: "Show one goal task or list all explicit goal tasks. Usage: /goal_status [<task-id-or-name>]",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => {
      if (!goalController) {
        return { text: "Error: GoalController not initialized. The code-agent service must be running." };
      }

      const ref = (ctx.args ?? "").trim();
      if (ref) {
        const task = goalController.getTask(ref);
        if (!task) {
          return { text: `Error: Goal task "${ref}" not found.` };
        }
        const session = task.sessionId ? sessionManager?.resolve(task.sessionId) : undefined;
        return { text: formatGoalTask(task, buildGoalTaskRuntimeSnapshot(session)) };
      }

      const tasks = goalController.listTasks();
      if (tasks.length === 0) {
        return { text: "No goal tasks found." };
      }
      return {
        text: tasks.map((task: any) => {
          const session = task.sessionId ? sessionManager?.resolve(task.sessionId) : undefined;
          return formatGoalTask(task, buildGoalTaskRuntimeSnapshot(session));
        }).join("\n\n"),
      };
    },
  });
}
