import { unlinkSync } from "fs";

import { pluginConfig } from "./config";
import { KeyedDeadlineScheduler } from "./keyed-deadline-scheduler";
import { getPersistedMutationRefs, getBackendConversationId, usesNativeBackendWorktree } from "./session-backend-ref";
import type { Session } from "./session";
import type { SessionReminderService } from "./session-reminder-service";
import type { SessionStore } from "./session-store";
import type { PersistedSessionInfo } from "./types";
import { resolveWorktreeLifecycle } from "./worktree-lifecycle-resolver";
import { removeWorktree } from "./worktree";

const RESOLVED_WORKTREE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const WORKTREE_REMINDER_RETRY_BACKOFF_MS = 5 * 60 * 1000;
const TMP_OUTPUT_CLEANUP_KEY = "tmp-output:cleanup";

interface SessionMaintenanceDeps {
  store: SessionStore;
  sessions: Map<string, Session>;
  reminders: SessionReminderService;
  removeRuntimeSession: (sessionId: string) => void;
  persistSession: (session: Session, options?: { scheduleRuntimeGc?: boolean }) => void;
  clearRuntimeSessionState: (sessionId: string) => void;
  resolveWorktreeRepoDir: (repoDir: string | undefined, worktreePath?: string) => string | undefined;
  updatePersistedSession: (ref: string, patch: Partial<PersistedSessionInfo>) => boolean;
  getMaxPersistedSessions: () => number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class SessionMaintenanceService {
  private readonly scheduler = new KeyedDeadlineScheduler();

  constructor(private readonly deps: SessionMaintenanceDeps) {}

  schedule(key: string, at: number, cb: () => void): void {
    this.scheduler.schedule(key, at, cb);
  }

  cancel(key: string): void {
    this.scheduler.cancel(key);
  }

  cancelPrefix(prefix: string): void {
    this.scheduler.cancelPrefix(prefix);
  }

  bootstrapMaintenanceSchedules(): void {
    const now = Date.now();
    this.deps.store.cleanupTmpOutputFiles(now);
    for (const session of this.deps.store.listPersistedSessions()) {
      this.syncPersistedSessionMaintenance(session);
    }
    this.syncActionTokenExpiryDeadline();
    this.deps.store.cleanupOrphanOutputFiles();
    this.syncTmpOutputCleanupDeadline(now);
  }

  syncRuntimeGcDeadline(session: Pick<Session, "id" | "completedAt">): void {
    if (!session.completedAt) return;
    const key = this.runtimeGcKey(session.id);
    this.schedule(key, session.completedAt + this.runtimeGcMaxAgeMs(), () => {
      const active = this.deps.sessions.get(session.id);
      if (!active || !active.completedAt) return;
      const cleanupMaxAgeMs = this.runtimeGcMaxAgeMs();
      if (!this.deps.store.shouldGcActiveSession(active, Date.now(), cleanupMaxAgeMs)) {
        this.syncRuntimeGcDeadline(active);
        return;
      }
      this.deps.removeRuntimeSession(session.id);
      this.deps.persistSession(active, { scheduleRuntimeGc: false });
      this.deps.clearRuntimeSessionState(session.id);
    });
  }

  cancelRuntimeGc(sessionId: string): void {
    this.cancel(this.runtimeGcKey(sessionId));
  }

  cancelPersistedMaintenance(
    session: Pick<PersistedSessionInfo, "sessionId" | "harnessSessionId" | "backendRef">,
  ): void {
    const ref = this.persistedMaintenanceRef(session);
    if (!ref) return;
    this.cancelPrefix(`persisted:${ref}:`);
  }

  syncPersistedSessionMaintenance(session: PersistedSessionInfo): void {
    const ref = this.persistedMaintenanceRef(session);
    if (!ref) return;

    this.cancel(this.persistedMaintenanceKey(ref, "worktree-reminder"));
    const nextReminderAt = this.deps.reminders.getNextReminderAt(session);
    if (nextReminderAt != null) {
      this.schedulePersistedWorktreeReminder(ref, nextReminderAt);
    } else {
      this.deps.reminders.clearResolvedReminderState(session);
    }

    this.cancel(this.persistedMaintenanceKey(ref, "worktree-retention"));
    const resolved = resolveWorktreeLifecycle(session, {
      activeSession: false,
      includePrSync: session.worktreeLifecycle?.state === "pr_open" || Boolean(session.worktreePrUrl),
    });
    const resolvedAtIso = this.resolvedAtIso(session);
    const legacyResolved = this.isLegacyResolvedWorktree(session);
    if ((resolved.cleanupSafe || legacyResolved) && typeof resolvedAtIso === "string") {
      const resolvedAt = new Date(resolvedAtIso).getTime();
      if (Number.isFinite(resolvedAt)) {
        this.schedule(this.persistedMaintenanceKey(ref, "worktree-retention"), resolvedAt + RESOLVED_WORKTREE_RETENTION_MS, () => {
          const latest = this.deps.store.getPersistedSession(ref);
          if (!latest) return;
          this.reconcileResolvedWorktreeRetention(latest, Date.now());
        });
      }
    }
  }

  reconcileResolvedWorktreeRetention(session: PersistedSessionInfo, now: number): void {
    const resolved = resolveWorktreeLifecycle(session, {
      activeSession: false,
      includePrSync: session.worktreeLifecycle?.state === "pr_open" || Boolean(session.worktreePrUrl),
    });
    const resolvedAtIso = this.resolvedAtIso(session);
    const resolvedAt = resolvedAtIso ? new Date(resolvedAtIso).getTime() : 0;
    const legacyResolved = this.isLegacyResolvedWorktree(session);
    if ((!resolved.cleanupSafe && !legacyResolved) || !resolvedAt || now - resolvedAt < RESOLVED_WORKTREE_RETENTION_MS) return;

    try {
      if (!session.worktreePath && !usesNativeBackendWorktree(session)) return;
      const repoDir = this.deps.resolveWorktreeRepoDir(session.workdir, session.worktreePath);
      if (!repoDir) return;
      const removed = usesNativeBackendWorktree(session)
        ? false
        : removeWorktree(repoDir, session.worktreePath!);
      if (!usesNativeBackendWorktree(session) && !removed) return;
      for (const mutationRef of getPersistedMutationRefs(session)) {
        this.deps.updatePersistedSession(mutationRef, {
          worktreePath: undefined,
          worktreeBranch: undefined,
          worktreeState: "none",
          worktreeLifecycle: {
            ...(session.worktreeLifecycle ?? resolved.lifecycle),
            state: resolved.derivedState,
            updatedAt: new Date(now).toISOString(),
            resolvedAt: session.worktreeLifecycle?.resolvedAt ?? new Date(now).toISOString(),
            resolutionSource: session.worktreeLifecycle?.resolutionSource ?? "maintenance",
            notes: resolved.reasons,
          },
        });
      }
    } catch (err) {
      console.warn(`[SessionManager] Failed maintenance cleanup for worktree ${session.worktreePath}: ${errorMessage(err)}`);
    }
  }

  syncActionTokenExpiryDeadline(): void {
    const key = "tokens:expiry";
    this.cancel(key);
    const nextExpiryAt = this.deps.store.getNextActionTokenExpiry();
    if (nextExpiryAt == null) return;
    this.schedule(key, nextExpiryAt, () => {
      this.deps.store.purgeExpiredActionTokens(Date.now());
    });
  }

  syncTmpOutputCleanupDeadline(now: number = Date.now()): void {
    this.cancel(TMP_OUTPUT_CLEANUP_KEY);
    const nextCleanupAt = this.deps.store.getNextTmpOutputCleanupAt(now);
    if (nextCleanupAt == null) return;
    this.schedule(TMP_OUTPUT_CLEANUP_KEY, nextCleanupAt, () => {
      const cleanupNow = Date.now();
      this.deps.store.cleanupTmpOutputFiles(cleanupNow);
      this.syncTmpOutputCleanupDeadline(cleanupNow);
    });
  }

  enforcePersistedRetention(): void {
    const evicted = this.deps.store.evictOldestPersisted(this.deps.getMaxPersistedSessions());
    for (const session of evicted) {
      this.cancelPersistedMaintenance(session);
      if (session.sessionId) {
        this.cancelRuntimeGc(session.sessionId);
      }
      this.cleanupOutputPathIfUnreferenced(session.outputPath);
    }
  }

  dispose(): void {
    this.scheduler.dispose();
  }

  private persistedMaintenanceRef(
    session: Pick<PersistedSessionInfo, "sessionId" | "harnessSessionId" | "backendRef">,
  ): string | undefined {
    return session.sessionId ?? getBackendConversationId(session) ?? session.harnessSessionId;
  }

  private runtimeGcKey(sessionId: string): string {
    return `runtime-gc:${sessionId}`;
  }

  private persistedMaintenanceKey(ref: string, kind: "worktree-reminder" | "worktree-retention"): string {
    return `persisted:${ref}:${kind}`;
  }

  private runtimeGcMaxAgeMs(): number {
    return (pluginConfig.sessionGcAgeMinutes ?? 1440) * 60_000;
  }

  private schedulePersistedWorktreeReminder(ref: string, at: number): void {
    const key = this.persistedMaintenanceKey(ref, "worktree-reminder");
    this.schedule(key, at, () => {
      const latest = this.deps.store.getPersistedSession(ref);
      if (!latest) return;
      const delivered = this.deps.reminders.sendReminderIfDue(latest, Date.now());
      if (delivered) return;

      const nextReminderAt = this.deps.reminders.getNextReminderAt(latest);
      if (nextReminderAt == null) return;
      this.schedulePersistedWorktreeReminder(
        ref,
        Math.max(nextReminderAt, Date.now() + WORKTREE_REMINDER_RETRY_BACKOFF_MS),
      );
    });
  }

  private cleanupOutputPathIfUnreferenced(outputPath: string | undefined): void {
    if (!outputPath || this.deps.store.hasOutputPathReference(outputPath)) return;
    try {
      unlinkSync(outputPath);
    } catch {
      // best-effort
    }
  }

  private resolvedAtIso(session: PersistedSessionInfo): string | undefined {
    return session.worktreeLifecycle?.resolvedAt
      ?? session.worktreeMergedAt
      ?? session.worktreeDismissedAt
      ?? (session.completedAt ? new Date(session.completedAt).toISOString() : undefined);
  }

  private isLegacyResolvedWorktree(session: Pick<
    PersistedSessionInfo,
    "worktreeMerged" | "worktreeDisposition" | "worktreeState"
  >): boolean {
    return session.worktreeMerged === true
      || session.worktreeDisposition === "dismissed"
      || session.worktreeDisposition === "no-change-cleaned"
      || session.worktreeState === "merged"
      || session.worktreeState === "dismissed";
  }
}
