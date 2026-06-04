import { goalController } from "../singletons";
import { consumeFirstCommandArg } from "./args";
import { formatGoalEditResult } from "../tools/goal-edit";

const GOAL_EDIT_USAGE = "Usage: /goal_edit <task-id-or-name> <replacement-goal>";

export function registerGoalEditCommand(api: any): void {
  api.registerCommand({
    name: "goal_edit",
    description: "Edit a running goal task. Usage: /goal_edit <task-id-or-name> <replacement-goal>",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => {
      if (!goalController) {
        return { text: "Error: GoalController not initialized. The code-agent service must be running." };
      }

      const raw = (ctx.args ?? "").trim();
      if (!raw) {
        return { text: GOAL_EDIT_USAGE };
      }

      const consumed = consumeFirstCommandArg(raw);
      const ref = consumed?.value.trim();
      const replacementGoal = consumed?.rest.trim();
      if (!ref || !replacementGoal) {
        return { text: GOAL_EDIT_USAGE };
      }

      const result = goalController.editTask(ref, replacementGoal);
      return { text: formatGoalEditResult(result, ref) };
    },
  });
}
