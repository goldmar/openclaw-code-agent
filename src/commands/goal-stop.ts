import { goalController } from "../singletons";

export function registerGoalStopCommand(api: any): void {
  api.registerCommand({
    name: "goal_stop",
    description: "Stop a goal task. Usage: /goal_stop <task-id-or-name>",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => {
      if (!goalController) {
        return { text: "Error: GoalController not initialized. The code-agent service must be running." };
      }

      const ref = (ctx.args ?? "").trim();
      if (!ref) {
        return { text: "Usage: /goal_stop <task-id-or-name>" };
      }

      const task = goalController.stopTask(ref);
      if (!task) {
        return { text: `Error: Goal task "${ref}" not found.` };
      }

      return { text: `Goal task ${task.name} [${task.id}] stopped.` };
    },
  });
}
