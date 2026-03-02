import type { SessionManager } from "./session-manager";
import type { NotificationService } from "./notifications";

export let sessionManager: SessionManager | null = null;
export let notificationService: NotificationService | null = null;

export function setSessionManager(sm: SessionManager | null): void {
  sessionManager = sm;
}

export function setNotificationService(ns: NotificationService | null): void {
  notificationService = ns;
}
