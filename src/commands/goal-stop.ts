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

      const result = goalController.stopTask(ref);
      if (!result) {
        return { text: `Error: Goal task "${ref}" not found.` };
      }

      if (result.action === "already_terminal") {
        return { text: `Task is already ${result.task.status}.` };
      }

      return { text: `Task "${result.task.name}" (${result.task.id}) stopped.` };
    },
  });
}
