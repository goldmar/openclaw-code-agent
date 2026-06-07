import type { GoalController, GoalTaskEditResult } from "../goal-controller";
import { buildGoalTaskRuntimeSnapshot, formatGoalTask } from "../goal-format";
import type { Session } from "../session";

export interface GoalCommandContext {
  args?: string;
}

export interface GoalCommandApi {
  registerCommand(config: {
    name: string;
    description: string;
    acceptsArgs: boolean;
    requireAuth: boolean;
    handler: (ctx: GoalCommandContext) => { text: string };
  }): void;
}

export type GoalSessionResolver = (ref: string) => Session | undefined;

export const GOAL_CONTROLLER_MISSING_MESSAGE = "Error: GoalController not initialized. The code-agent service must be running.";

export function renderGoalStatus(
  controller: GoalController,
  resolveSession: GoalSessionResolver,
  ref?: string,
): string {
  const taskRef = ref?.trim();
  if (taskRef) {
    const task = controller.getTask(taskRef);
    if (!task) {
      return `Error: Goal task "${taskRef}" not found.`;
    }
    const session = task.sessionId ? resolveSession(task.sessionId) : undefined;
    return formatGoalTask(task, buildGoalTaskRuntimeSnapshot(session));
  }

  const tasks = controller.listTasks();
  if (tasks.length === 0) {
    return "No goal tasks found.";
  }

  return tasks.map((task) => {
    const session = task.sessionId ? resolveSession(task.sessionId) : undefined;
    return formatGoalTask(task, buildGoalTaskRuntimeSnapshot(session));
  }).join("\n\n");
}

export function renderGoalStopResult(
  result: ReturnType<GoalController["stopTask"]>,
  ref: string,
): string {
  if (!result) {
    return `Error: Goal task "${ref}" not found.`;
  }

  if (result.action === "already_terminal") {
    return `Task is already ${result.task.status}.`;
  }

  return `Task "${result.task.name}" (${result.task.id}) stopped.`;
}

export function renderGoalEditResult(result: GoalTaskEditResult, ref: string): string {
  switch (result.action) {
    case "updated":
      return `Task "${result.task.name}" (${result.task.id}) goal updated.`;
    case "not_found":
      return `Error: Goal task "${ref}" not found.`;
    case "invalid_goal":
      return "Error: replacement goal must not be empty.";
    case "not_editable":
      if (result.task.status !== "waiting_for_user") {
        return `Task is already ${result.task.status}.`;
      }
      return `Error: Goal task "${result.task.name}" is ${result.task.status} and cannot be edited.`;
  }
}
