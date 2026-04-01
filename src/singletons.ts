import type { SessionManager } from "./session-manager";
import type { GoalController } from "./goal-controller";

export let sessionManager: SessionManager | null = null;
export let goalController: GoalController | null = null;

/** Replace the shared SessionManager reference used by tools/commands. */
export function setSessionManager(sm: SessionManager | null): void {
  sessionManager = sm;
}

/** Replace the shared GoalController reference used by tools/commands. */
export function setGoalController(controller: GoalController | null): void {
  goalController = controller;
}
