import type { SessionManager } from "./session-manager";
import type { NotificationService } from "./notifications";

export let sessionManager: SessionManager | null = null;
export let notificationService: NotificationService | null = null;

/** Replace the shared SessionManager reference used by tools/commands. */
export function setSessionManager(sm: SessionManager | null): void {
  sessionManager = sm;
}

/** Replace the shared NotificationService reference used by the service. */
export function setNotificationService(ns: NotificationService | null): void {
  notificationService = ns;
}
