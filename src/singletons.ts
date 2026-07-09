import type { SessionManager } from "./session-manager";
import type { GoalController } from "./goal-controller";
import type { AutoUpdateService } from "./auto-update";

export let sessionManager: SessionManager | null = null;
export let goalController: GoalController | null = null;
export let autoUpdateService: AutoUpdateService | null = null;

/** Replace the shared SessionManager reference used by tools/commands. */
export function setSessionManager(sm: SessionManager | null): void {
  sessionManager = sm;
}

/** Replace the shared GoalController reference used by tools/commands. */
export function setGoalController(controller: GoalController | null): void {
  goalController = controller;
}

/** Replace the shared AutoUpdateService reference used by callbacks. */
export function setAutoUpdateService(service: AutoUpdateService | null): void {
  autoUpdateService = service;
}
