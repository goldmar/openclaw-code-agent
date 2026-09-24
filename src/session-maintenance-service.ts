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
import { createLogger } from "./logger";

const log = createLogger("session-maintenance-service");

const RESOLVED_WORKTREE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const WORKTREE_REMINDER_RETRY_BACKOFF_MS = 5 * 60 * 1000;
const SESSION_OUTPUT_CLEANUP_KEY = "tmp-output:cleanup";
const SESSION_OUTPUT_CLEANUP_RETRY_BACKOFF_MS = 60 * 1000;

interface SessionMaintenanceDeps {
  store: SessionStore;
  sessions: Map<string, Session>;
  reminders: SessionReminderService;
  removeRuntimeSession: (sessionId: string, reason?: string) => void;
  persistSession: (session: Session, options?: { scheduleRuntimeGc?: boolean }) => void;
  clearRuntimeSessionState: (sessionId: string) => void;
  resolveWorktreeRepoDir: (repoDir: string | undefined, worktreePath?: string) => string | undefined | Promise<string | undefined>;
  updatePersistedSession: (ref: string, patch: Partial<PersistedSessionInfo>) => boolean;
  getMaxPersistedSessions: () => number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class SessionMaintenanceService {
  private readonly scheduler = new KeyedDeadlineScheduler();
  private lastSessionOutputCleanupAttemptAt: number | undefined;
  /** Latest sync request per persisted ref; older in-flight syncs must not apply their schedule. */
  private readonly persistedSyncGenerations = new Map<string, number>();
  private readonly pendingWork = new Set<Promise<void>>();

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
    this.runSessionOutputCleanup(now);
    for (const session of this.deps.store.listPersistedSessions()) {
      this.syncPersistedSessionMaintenance(session);
    }
    this.syncActionTokenExpiryDeadline();
    this.deps.store.cleanupOrphanOutputFiles();
    this.syncSessionOutputCleanupDeadline(now);
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
      this.deps.removeRuntimeSession(session.id, "runtime-gc");
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
    this.nextPersistedSyncGeneration(ref);
    this.cancelPrefix(`persisted:${ref}:`);
  }

  /**
   * Recompute a persisted session's reminder and retention deadlines. Deciding
   * them needs git evidence, so the work runs asynchronously; only the most
   * recent request for a ref applies its schedule.
   */
  syncPersistedSessionMaintenance(session: PersistedSessionInfo): void {
    const ref = this.persistedMaintenanceRef(session);
    if (!ref) return;
    const generation = this.nextPersistedSyncGeneration(ref);
    this.track(this.syncPersistedSessionMaintenanceNow(session, ref, generation), `maintenance sync for ${ref}`);
  }

  /** Resolve once every maintenance sync and scheduled callback started so far has settled. */
  async whenIdle(): Promise<void> {
    while (this.pendingWork.size > 0) {
      await Promise.all([...this.pendingWork]);
    }
  }

  private nextPersistedSyncGeneration(ref: string): number {
    const generation = (this.persistedSyncGenerations.get(ref) ?? 0) + 1;
    this.persistedSyncGenerations.set(ref, generation);
    return generation;
  }

  private isCurrentPersistedSync(ref: string, generation: number): boolean {
    return this.persistedSyncGenerations.get(ref) === generation;
  }

  private track(work: Promise<void>, description: string): void {
    const pending = work
      .catch((err) => log.warn(`[SessionManager] ${description} failed: ${errorMessage(err)}`))
      .finally(() => this.pendingWork.delete(pending));
    this.pendingWork.add(pending);
  }

  private async syncPersistedSessionMaintenanceNow(session: PersistedSessionInfo, ref: string, generation: number): Promise<void> {
    const nextReminderAt = await this.deps.reminders.getNextReminderAt(session);
    if (!this.isCurrentPersistedSync(ref, generation)) return;
    this.cancel(this.persistedMaintenanceKey(ref, "worktree-reminder"));
    if (nextReminderAt != null) {
      this.schedulePersistedWorktreeReminder(ref, nextReminderAt);
    } else {
      await this.deps.reminders.clearResolvedReminderState(session);
      if (!this.isCurrentPersistedSync(ref, generation)) return;
    }

    const resolved = await resolveWorktreeLifecycle(session, {
      activeSession: false,
      includePrSync: session.worktreeLifecycle?.state === "pr_open" || Boolean(session.worktreePrUrl),
    });
    if (!this.isCurrentPersistedSync(ref, generation)) return;
    this.cancel(this.persistedMaintenanceKey(ref, "worktree-retention"));
    const resolvedAtIso = this.resolvedAtIso(session);
    if (resolved.cleanupSafe && typeof resolvedAtIso === "string") {
      const resolvedAt = new Date(resolvedAtIso).getTime();
      if (Number.isFinite(resolvedAt)) {
        this.schedule(this.persistedMaintenanceKey(ref, "worktree-retention"), resolvedAt + RESOLVED_WORKTREE_RETENTION_MS, () => {
          const latest = this.deps.store.getPersistedSession(ref);
          if (!latest) return;
          this.track(this.reconcileResolvedWorktreeRetention(latest, Date.now()), `worktree retention for ${ref}`);
        });
      }
    }
  }

  async reconcileResolvedWorktreeRetention(session: PersistedSessionInfo, now: number): Promise<void> {
    const resolved = await resolveWorktreeLifecycle(session, {
      activeSession: false,
      includePrSync: session.worktreeLifecycle?.state === "pr_open" || Boolean(session.worktreePrUrl),
    });
    const resolvedAtIso = this.resolvedAtIso(session);
    const resolvedAt = resolvedAtIso ? new Date(resolvedAtIso).getTime() : 0;
    if (!resolved.cleanupSafe || !resolvedAtIso || !Number.isFinite(resolvedAt) || now - resolvedAt < RESOLVED_WORKTREE_RETENTION_MS) return;

    try {
      if (!session.worktreePath && !usesNativeBackendWorktree(session)) return;
      const repoDir = await this.deps.resolveWorktreeRepoDir(session.workdir, session.worktreePath);
      if (!repoDir) return;
      const removed = usesNativeBackendWorktree(session)
        ? false
        : await removeWorktree(repoDir, session.worktreePath!);
      if (!usesNativeBackendWorktree(session) && !removed) return;
      for (const mutationRef of getPersistedMutationRefs(session)) {
        this.deps.updatePersistedSession(mutationRef, {
          worktreePath: undefined,
          worktreeBranch: undefined,
          worktreeState: "none",
          pendingWorktreeDecisionSince: undefined,
          lastWorktreeReminderAt: undefined,
          worktreeDecisionSnoozedUntil: undefined,
          worktreeLifecycle: {
            ...(session.worktreeLifecycle ?? resolved.lifecycle),
            state: resolved.derivedState,
            updatedAt: new Date(now).toISOString(),
            resolvedAt: session.worktreeLifecycle?.resolvedAt ?? resolvedAtIso,
            resolutionSource: session.worktreeLifecycle?.resolutionSource ?? "maintenance",
            notes: resolved.reasons,
          },
        });
      }
    } catch (err) {
      log.warn(`[SessionManager] Failed maintenance cleanup for worktree ${session.worktreePath}: ${errorMessage(err)}`);
    }
  }

  syncActionTokenExpiryDeadline(): void {
    const key = "tokens:expiry";
    this.cancel(key);
    const nextExpiryAt = this.deps.store.getNextActionTokenExpiry();
    if (nextExpiryAt == null) return;
    this.schedule(key, nextExpiryAt, () => {
      const changed = this.deps.store.purgeExpiredActionTokens(Date.now());
      if (!changed) {
        this.syncActionTokenExpiryDeadline();
      }
    });
  }

  syncSessionOutputCleanupDeadline(now: number = Date.now()): void {
    this.cancel(SESSION_OUTPUT_CLEANUP_KEY);
    const nextCleanupAt = this.deps.store.getNextSessionOutputCleanupAt(now);
    if (nextCleanupAt == null) {
      this.lastSessionOutputCleanupAttemptAt = undefined;
      return;
    }
    if (nextCleanupAt > now) {
      this.lastSessionOutputCleanupAttemptAt = undefined;
    }
    this.schedule(SESSION_OUTPUT_CLEANUP_KEY, this.getSessionOutputCleanupScheduleAt(nextCleanupAt, now), () => {
      const cleanupNow = Date.now();
      this.runSessionOutputCleanup(cleanupNow);
      this.syncSessionOutputCleanupDeadline(cleanupNow);
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

  private runSessionOutputCleanup(now: number): void {
    this.lastSessionOutputCleanupAttemptAt = now;
    this.deps.store.cleanupSessionOutputFiles(now);
  }

  private getSessionOutputCleanupScheduleAt(nextCleanupAt: number, now: number): number {
    if (nextCleanupAt > now || this.lastSessionOutputCleanupAttemptAt == null) return nextCleanupAt;
    const retryAt = this.lastSessionOutputCleanupAttemptAt + SESSION_OUTPUT_CLEANUP_RETRY_BACKOFF_MS;
    return retryAt > now ? retryAt : nextCleanupAt;
  }

  private schedulePersistedWorktreeReminder(ref: string, at: number): void {
    const key = this.persistedMaintenanceKey(ref, "worktree-reminder");
    this.schedule(key, at, () => {
      const latest = this.deps.store.getPersistedSession(ref);
      if (!latest) return;
      this.track((async () => {
        const delivered = await this.deps.reminders.sendReminderIfDue(latest, Date.now());
        if (delivered) return;

        const nextReminderAt = await this.deps.reminders.getNextReminderAt(latest);
        if (nextReminderAt == null) return;
        this.schedulePersistedWorktreeReminder(
          ref,
          Math.max(nextReminderAt, Date.now() + WORKTREE_REMINDER_RETRY_BACKOFF_MS),
        );
      })(), `worktree reminder for ${ref}`);
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
}
