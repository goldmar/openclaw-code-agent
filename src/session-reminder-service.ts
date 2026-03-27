import { buildDelegateReminderWakeMessage } from "./session-notification-builder";
import type { NotificationButton } from "./session-interactions";
import type { SessionNotificationRequest } from "./wake-dispatcher";
import type { PersistedSessionInfo } from "./types";
import type { Session } from "./session";

type RoutingProxyBuilder = (session: {
  id?: string;
  harnessSessionId?: string;
  route?: PersistedSessionInfo["route"];
}) => Session;

export class SessionReminderService {
  constructor(
    private readonly buildRoutingProxy: RoutingProxyBuilder,
    private readonly dispatchNotification: (
      session: Session,
      request: SessionNotificationRequest,
    ) => void,
    private readonly updatePersistedSession: (
      ref: string,
      patch: Partial<PersistedSessionInfo>,
    ) => boolean,
    private readonly getWorktreeDecisionButtons: (sessionId: string) => NotificationButton[][] | undefined,
  ) {}

  remindStaleDecisions(
    sessions: PersistedSessionInfo[],
    now: number = Date.now(),
  ): void {
    const REMINDER_THRESHOLD_MS = 3 * 60 * 60 * 1000;
    const REMINDER_INTERVAL_MS = 3 * 60 * 60 * 1000;

    for (const session of sessions) {
      if (!session.pendingWorktreeDecisionSince) continue;
      const explicitlyPending =
        session.worktreeState === "pending_decision" || session.lifecycle === "awaiting_worktree_decision";
      const unresolvedWithoutExplicitState =
        session.worktreeState == null && session.lifecycle == null && !session.worktreeMerged && !session.worktreePrUrl;
      if (!explicitlyPending && !unresolvedWithoutExplicitState) continue;
      if (session.worktreeDecisionSnoozedUntil) {
        const snoozedUntil = new Date(session.worktreeDecisionSnoozedUntil).getTime();
        if (Number.isFinite(snoozedUntil) && snoozedUntil > now) continue;
      }

      const pendingMs = now - new Date(session.pendingWorktreeDecisionSince).getTime();
      if (!Number.isFinite(pendingMs) || pendingMs < REMINDER_THRESHOLD_MS) continue;

      if (session.lastWorktreeReminderAt) {
        const lastReminderMs = now - new Date(session.lastWorktreeReminderAt).getTime();
        if (lastReminderMs < REMINDER_INTERVAL_MS) continue;
      }

      const pendingHours = Math.floor(pendingMs / (60 * 60 * 1000));
      try {
        this.sendReminderNotification(session, pendingHours);
      } catch (err) {
        console.warn(
          `[SessionReminderService] Failed to send stale-decision reminder for session ${session.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      this.updatePersistedSession(session.harnessSessionId, {
        lastWorktreeReminderAt: new Date(now).toISOString(),
      });
    }
  }

  private sendReminderNotification(session: PersistedSessionInfo, pendingHours: number): void {
    const routingProxy = this.buildRoutingProxy({
      id: session.harnessSessionId,
      harnessSessionId: session.harnessSessionId,
      route: session.route,
    });

    if (session.worktreeStrategy === "delegate") {
      this.dispatchNotification(routingProxy, {
        label: `worktree-stale-reminder-${session.name}`,
        wakeMessage: buildDelegateReminderWakeMessage(session, pendingHours),
        notifyUser: "never",
      });
      return;
    }

    const text = [
      `⏰ Reminder: branch \`${session.worktreeBranch ?? "unknown"}\` is still waiting for a merge decision.`,
      `Session: ${session.name} | Pending: ${pendingHours}h`,
      ``,
      `agent_merge(session="${session.name}") or agent_pr(session="${session.name}") or agent_worktree_cleanup() to resolve.`,
    ].join("\n");

    this.dispatchNotification(routingProxy, {
      label: `worktree-stale-reminder-${session.name}`,
      userMessage: text,
      notifyUser: "always",
      buttons: this.getWorktreeDecisionButtons(session.harnessSessionId),
    });
  }
}
