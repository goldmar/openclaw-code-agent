import {
  GOAL_CONTROLLER_MISSING_MESSAGE,
  GoalCommandApi,
  GoalCommandContext,
  renderGoalEditResult,
} from "../application/goal-view";
import { goalController } from "../singletons";
import { consumeFirstCommandArg } from "./args";

const GOAL_EDIT_USAGE = "Usage: /agent_goal_edit <task-id-or-name> <replacement-goal>";

export function registerGoalEditCommand(api: GoalCommandApi): void {
  api.registerCommand({
    name: "agent_goal_edit",
    description: "Edit a running goal task. Usage: /agent_goal_edit <task-id-or-name> <replacement-goal>",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: GoalCommandContext) => {
      if (!goalController) {
        return { text: GOAL_CONTROLLER_MISSING_MESSAGE };
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
      return { text: renderGoalEditResult(result, ref) };
    },
  });
}
