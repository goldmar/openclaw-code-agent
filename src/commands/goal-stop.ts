import {
  GOAL_CONTROLLER_MISSING_MESSAGE,
  GoalCommandApi,
  GoalCommandContext,
  renderGoalStopResult,
} from "../application/goal-view";
import { goalController } from "../singletons";

export function registerGoalStopCommand(api: GoalCommandApi): void {
  api.registerCommand({
    name: "agent_goal_stop",
    description: "Stop a goal task. Usage: /agent_goal_stop <task-id-or-name>",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: GoalCommandContext) => {
      if (!goalController) {
        return { text: GOAL_CONTROLLER_MISSING_MESSAGE };
      }

      const ref = (ctx.args ?? "").trim();
      if (!ref) {
        return { text: "Usage: /agent_goal_stop <task-id-or-name>" };
      }

      const result = goalController.stopTask(ref);
      return { text: renderGoalStopResult(result, ref) };
    },
  });
}
