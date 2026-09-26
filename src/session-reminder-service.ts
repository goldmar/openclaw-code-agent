import { buildDelegateReminderWakeMessage } from "./session-notification-builder";
import type { NotificationButton } from "./session-interactions";
import type { SessionNotificationRequest } from "./wake-dispatcher";
import type { ManagedWorktreeLifecycleState, PersistedSessionInfo } from "./types";
import type { Session } from "./session";
import { getBackendConversationId, getPersistedMutationRefs, getPrimarySessionLookupRef } from "./session-backend-ref";
import { resolveWorktreeLifecycle } from "./worktree-lifecycle-resolver";
import { createLogger } from "./logger";

const log = createLogger("session-reminder-service");

type RoutingProxyBuilder = (session: {
  id?: string;
  sessionId?: string;
  harnessSessionId?: string;
  backendRef?: PersistedSessionInfo["backendRef"];
  route?: PersistedSessionInfo["route"];
}) => Session;

type WorktreeDecisionReminderStatus = "pending" | "resolved" | "inactive";

const RESOLVED_WORKTREE_STATES = new Set([
  "merged",
  "released",
  "dismissed",
  "none",
  "cleanup_failed",
]);

const RESOLVED_LIFECYCLE_STATES = new Set([
  "merged",
  "released",
  "dismissed",
  "no_change",
  "none",
  "cleanup_failed",
]);

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
    private readonly getWorktreeDecisionButtons: (
      sessionId: string,
      session: PersistedSessionInfo,
    ) => NotificationButton[][] | undefined | Promise<NotificationButton[][] | undefined>,
  ) {}

  static readonly REMINDER_THRESHOLD_MS = 3 * 60 * 60 * 1000;
  /**
   * Wait after the Nth reminder before the next one (N38): 3h, 24h, then a
   * week; after `MAX_REMINDERS` no more reminders are sent. Index 0 applies
   * when the only "reminder" was a snooze.
   */
  static readonly REMINDER_BACKOFF_MS = [3 * 60 * 60 * 1000, 24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000] as const;
  static readonly MAX_REMINDERS = 3;

  /** Reminders already sent for the current pending decision. */
  static remindersSent(session: Pick<PersistedSessionInfo, "lastWorktreeReminderAt" | "worktreeReminderCount">): number {
    if (!session.lastWorktreeReminderAt) return 0;
    // Rows from builds without the counter sent at least one reminder.
    return session.worktreeReminderCount ?? 1;
  }

  async getNextReminderAt(session: PersistedSessionInfo): Promise<number | undefined> {
    const pendingSince = new Date(session.pendingWorktreeDecisionSince).getTime();
    if ((await this.getWorktreeDecisionReminderStatus(session, pendingSince)) !== "pending") return undefined;
    const sent = SessionReminderService.remindersSent(session);
    if (sent >= SessionReminderService.MAX_REMINDERS) return undefined;

    const candidates = [pendingSince + SessionReminderService.REMINDER_THRESHOLD_MS];
    if (session.worktreeDecisionSnoozedUntil) {
      const snoozedUntil = new Date(session.worktreeDecisionSnoozedUntil).getTime();
      if (Number.isFinite(snoozedUntil)) candidates.push(snoozedUntil);
    }
    if (session.lastWorktreeReminderAt) {
      const lastReminderAt = new Date(session.lastWorktreeReminderAt).getTime();
      if (Number.isFinite(lastReminderAt)) {
        const backoff = SessionReminderService.REMINDER_BACKOFF_MS;
        candidates.push(lastReminderAt + backoff[Math.min(sent, backoff.length - 1)]);
      }
    }
    return Math.max(...candidates);
  }

  async sendReminderIfDue(
    session: PersistedSessionInfo,
    now: number = Date.now(),
    stillCurrent: () => boolean = () => true,
  ): Promise<boolean> {
    await this.clearResolvedReminderState(session);
    const nextReminderAt = await this.getNextReminderAt(session);
    if (nextReminderAt == null || nextReminderAt > now) return false;
    // The resolution checks above await git; drop the send if the schedule moved meanwhile.
    if (!stillCurrent()) return false;

    const pendingMs = now - new Date(session.pendingWorktreeDecisionSince!).getTime();
    const pendingHours = Math.floor(Math.max(0, pendingMs) / (60 * 60 * 1000));
    const sent = SessionReminderService.remindersSent(session);
    const isLast = sent + 1 >= SessionReminderService.MAX_REMINDERS;
    try {
      if (!(await this.sendReminderNotification(session, pendingHours, stillCurrent, isLast))) return false;
    } catch (err) {
      log.warn(
        `[SessionReminderService] Failed to send stale-decision reminder for session ${session.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }

    for (const mutationRef of getPersistedMutationRefs(session)) {
      this.updatePersistedSession(mutationRef, {
        lastWorktreeReminderAt: new Date(now).toISOString(),
        worktreeReminderCount: sent + 1,
      });
    }
    return true;
  }

  /** @returns false when the schedule moved (for example a snooze) before the reminder could be sent. */
  private async sendReminderNotification(
    session: PersistedSessionInfo,
    pendingHours: number,
    stillCurrent: () => boolean,
    isLast: boolean,
  ): Promise<boolean> {
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
        idempotencyKey: `worktree-stale-reminder:${session.sessionId ?? session.name}:${pendingHours}`,
      });
      return true;
    }

    const text = `⏰ [${session.name}] Branch \`${session.worktreeBranch ?? "unknown"}\` still waits for your decision (${formatPendingAge(pendingHours)})${isLast ? ". Last reminder." : "."}`;

    const buttons = await this.getWorktreeDecisionButtons(
      getPrimarySessionLookupRef(session) ?? session.harnessSessionId,
      session,
    );
    // Building policy-aware buttons awaits git; a snooze may have landed meanwhile.
    if (!stillCurrent()) return false;
    this.dispatchNotification(routingProxy, {
      label: `worktree-stale-reminder-${session.name}`,
      userMessage: text,
      notifyUser: "always",
      buttons,
    });
    return true;
  }

  async clearResolvedReminderState(session: PersistedSessionInfo): Promise<boolean> {
    if (!session.pendingWorktreeDecisionSince && !session.lastWorktreeReminderAt && !session.worktreeDecisionSnoozedUntil) {
      return false;
    }
    if (!(await this.isResolvedWorktreeDecision(session))) return false;

    let updated = false;
    for (const mutationRef of getPersistedMutationRefs(session)) {
      updated = this.updatePersistedSession(mutationRef, {
        pendingWorktreeDecisionSince: undefined,
        lastWorktreeReminderAt: undefined,
        worktreeDecisionSnoozedUntil: undefined,
      }) || updated;
    }
    return updated;
  }

  private async getWorktreeDecisionReminderStatus(
    session: PersistedSessionInfo,
    pendingSince?: number,
  ): Promise<WorktreeDecisionReminderStatus> {
    if (this.hasResolvedWorktreeDecisionMarker(session)) return "resolved";
    if (!session.pendingWorktreeDecisionSince) return "inactive";
    const parsedPendingSince = pendingSince ?? new Date(session.pendingWorktreeDecisionSince).getTime();
    if (!Number.isFinite(parsedPendingSince)) return "inactive";

    const explicitlyPending =
      session.worktreeState === "pending_decision"
      || session.lifecycle === "awaiting_worktree_decision"
      || session.worktreeLifecycle?.state === "pending_decision";
    const unresolvedWithoutExplicitState =
      session.worktreeState == null
      && session.lifecycle == null
      && session.worktreeLifecycle?.state == null
      && !session.worktreeMerged
      && !session.worktreePrUrl;
    if (!explicitlyPending && !unresolvedWithoutExplicitState) return "inactive";

    const resolved = await resolveWorktreeLifecycle(session, {
      activeSession: false,
      includePrSync: false,
    });
    return this.isResolvedDerivedWorktreeState(resolved.derivedState) ? "resolved" : "pending";
  }

  private async isResolvedWorktreeDecision(session: PersistedSessionInfo): Promise<boolean> {
    if (this.hasResolvedWorktreeDecisionMarker(session)) return true;

    const resolved = await resolveWorktreeLifecycle(session, {
      activeSession: false,
      includePrSync: false,
    });
    return this.isResolvedDerivedWorktreeState(resolved.derivedState);
  }

  private hasResolvedWorktreeDecisionMarker(session: PersistedSessionInfo): boolean {
    if (session.worktreeMerged || session.worktreePrUrl) return true;
    if (session.lifecycle === "terminal") return true;
    if (session.worktreeState && RESOLVED_WORKTREE_STATES.has(session.worktreeState)) return true;
    if (session.worktreeLifecycle?.state && RESOLVED_LIFECYCLE_STATES.has(session.worktreeLifecycle.state)) return true;
    return false;
  }

  private isResolvedDerivedWorktreeState(state: ManagedWorktreeLifecycleState): boolean {
    return state === "merged" || state === "released" || state === "no_change" || state === "cleanup_failed";
  }
}

function formatPendingAge(hours: number): string {
  return hours >= 48 ? `${Math.floor(hours / 24)} days` : `${hours}h`;
}
