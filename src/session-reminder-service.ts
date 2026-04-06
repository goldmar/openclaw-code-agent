import { buildDelegateReminderWakeMessage } from "./session-notification-builder";
import type { NotificationButton } from "./session-interactions";
import type { SessionNotificationRequest } from "./wake-dispatcher";
import type { PersistedSessionInfo } from "./types";
import type { Session } from "./session";
import { getBackendConversationId, getPersistedMutationRefs, getPrimarySessionLookupRef } from "./session-backend-ref";

type RoutingProxyBuilder = (session: {
  id?: string;
  sessionId?: string;
  harnessSessionId?: string;
  backendRef?: PersistedSessionInfo["backendRef"];
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

  static readonly REMINDER_THRESHOLD_MS = 3 * 60 * 60 * 1000;
  static readonly REMINDER_INTERVAL_MS = 3 * 60 * 60 * 1000;

  getNextReminderAt(session: PersistedSessionInfo): number | undefined {
    if (!session.pendingWorktreeDecisionSince) return undefined;
    const explicitlyPending =
      session.worktreeState === "pending_decision" || session.lifecycle === "awaiting_worktree_decision";
    const unresolvedWithoutExplicitState =
      session.worktreeState == null && session.lifecycle == null && !session.worktreeMerged && !session.worktreePrUrl;
    if (!explicitlyPending && !unresolvedWithoutExplicitState) return undefined;

    const pendingSince = new Date(session.pendingWorktreeDecisionSince).getTime();
    if (!Number.isFinite(pendingSince)) return undefined;

    const candidates = [pendingSince + SessionReminderService.REMINDER_THRESHOLD_MS];
    if (session.worktreeDecisionSnoozedUntil) {
      const snoozedUntil = new Date(session.worktreeDecisionSnoozedUntil).getTime();
      if (Number.isFinite(snoozedUntil)) candidates.push(snoozedUntil);
    }
    if (session.lastWorktreeReminderAt) {
      const lastReminderAt = new Date(session.lastWorktreeReminderAt).getTime();
      if (Number.isFinite(lastReminderAt)) {
        candidates.push(lastReminderAt + SessionReminderService.REMINDER_INTERVAL_MS);
      }
    }
    return Math.max(...candidates);
  }

  sendReminderIfDue(
    session: PersistedSessionInfo,
    now: number = Date.now(),
  ): boolean {
    const nextReminderAt = this.getNextReminderAt(session);
    if (nextReminderAt == null || nextReminderAt > now) return false;

    const pendingMs = now - new Date(session.pendingWorktreeDecisionSince!).getTime();
    const pendingHours = Math.floor(Math.max(0, pendingMs) / (60 * 60 * 1000));
    try {
      this.sendReminderNotification(session, pendingHours);
    } catch (err) {
      console.warn(
        `[SessionReminderService] Failed to send stale-decision reminder for session ${session.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }

    for (const mutationRef of getPersistedMutationRefs(session)) {
      this.updatePersistedSession(mutationRef, {
        lastWorktreeReminderAt: new Date(now).toISOString(),
      });
    }
    return true;
  }

  private sendReminderNotification(session: PersistedSessionInfo, pendingHours: number): void {
    const routingProxy = this.buildRoutingProxy({
      id: session.sessionId ?? session.name ?? getBackendConversationId(session) ?? session.harnessSessionId,
      sessionId: session.sessionId,
      harnessSessionId: session.harnessSessionId,
      backendRef: session.backendRef,
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
      buttons: this.getWorktreeDecisionButtons(getPrimarySessionLookupRef(session) ?? session.harnessSessionId),
    });
  }
}
