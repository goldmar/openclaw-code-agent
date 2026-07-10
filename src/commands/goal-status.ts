import {
  GOAL_CONTROLLER_MISSING_MESSAGE,
  GoalCommandApi,
  GoalCommandContext,
  renderGoalStatus,
} from "../application/goal-view";
import { goalController, sessionManager } from "../singletons";

export function registerGoalStatusCommand(api: GoalCommandApi): void {
  api.registerCommand({
    name: "agent_goal_status",
    description: "Show one goal task or list all explicit goal tasks. Usage: /agent_goal_status [<task-id-or-name>]",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: GoalCommandContext) => {
      if (!goalController) {
        return { text: GOAL_CONTROLLER_MISSING_MESSAGE };
      }

      const ref = (ctx.args ?? "").trim();
      return { text: renderGoalStatus(goalController, (sessionId) => sessionManager?.resolve(sessionId), ref) };
    },
  });
}
