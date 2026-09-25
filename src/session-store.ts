import { existsSync, statSync, writeFileSync } from "fs";
import type {
  PersistedSessionInfo,
  RepoIntegrationPolicy,
  RepoPolicyRecord,
  SessionStatus,
  SessionActionToken,
} from "./types";
import type { Session } from "./session";
import { getSessionOutputFilePath } from "./session";
import { ensureSessionOutputDir } from "./session-output";
import { canonicalizeSessionRoute } from "./session-route";
import { SessionActionTokenStore } from "./session-action-token-store";
import { getBackendConversationId, resolveHarnessName } from "./session-backend-ref";
import { SessionStoreQueries } from "./session-store-queries";
import {
  cleanupOrphanOutputFiles,
  cleanupSessionOutputFiles,
  getNextSessionOutputCleanupAt,
  loadSessionStoreIndex,
  backupUnmergeableSessionIndex,
  isForeignLiveRunningRow,
  readSessionStoreSnapshot,
  resolveSessionIndexPath,
  runtimeOwnerMarker,
  saveSessionStoreIndex,
  statSessionStoreIndex,
  tryAcquireSessionStoreLock,
  type SessionStoreDiskSnapshot,
} from "./session-store-storage";
import {
  assertNewSchemaEntry,
  normalizeActionToken,
  normalizePersistedEntry,
  normalizeRepoPolicyRecord,
} from "./session-store-normalization";
import { createLogger } from "./logger";

const log = createLogger("session-store");

const TERMINAL_STATUSES = new Set<SessionStatus>(["completed", "failed", "killed"]);
const SESSION_OUTPUT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Retry interval and budget for a save deferred because another writer holds the index lock. */
const LOCKED_SAVE_RETRY_MS = 25;
const LOCKED_SAVE_MAX_DEFER_MS = 5_000;

export interface SessionStoreOptions {
  env?: NodeJS.ProcessEnv;
  indexPath?: string;
  /** Runtime identity for diagnostics (shared runtime id and build). */
  instanceId?: string;
}

type MergeChoice = "local" | "disk" | "drop";

/**
 * Three-way merge of one keyed collection. `base` is what this writer last read
 * or wrote, `local` its memory, `disk` the current file. A side that changed
 * relative to base wins; local wins a conflict. Deleting an unchanged row on one
 * side deletes it; a row changed on the other side survives the delete.
 */
export function mergeKeyedRows(
  base: ReadonlyMap<string, string>,
  local: ReadonlyMap<string, string>,
  disk: ReadonlyMap<string, string>,
): Map<string, MergeChoice> {
  const choices = new Map<string, MergeChoice>();
  for (const key of new Set([...local.keys(), ...disk.keys()])) {
    const b = base.get(key);
    const l = local.get(key);
    const d = disk.get(key);
    if (l !== undefined && d !== undefined) {
      choices.set(key, l === d || l !== b ? "local" : "disk");
    } else if (l !== undefined) {
      choices.set(key, b === undefined || l !== b ? "local" : "drop");
    } else if (d !== undefined) {
      choices.set(key, b === undefined || d !== b ? "disk" : "drop");
    }
  }
  return choices;
}

function sessionRowKey(row: unknown): string | undefined {
  if (!row || typeof row !== "object") return undefined;
  const record = row as { sessionId?: unknown; harnessSessionId?: unknown };
  if (typeof record.sessionId === "string" && record.sessionId) return record.sessionId;
  return typeof record.harnessSessionId === "string" && record.harnessSessionId ? record.harnessSessionId : undefined;
}

function idRowKey(field: "id" | "key") {
  return (row: unknown): string | undefined => {
    if (!row || typeof row !== "object") return undefined;
    const value = (row as Record<string, unknown>)[field];
    return typeof value === "string" && value ? value : undefined;
  };
}

function toKeyedJson(rows: Iterable<unknown>, keyOf: (row: unknown) => string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key) map.set(key, JSON.stringify(row));
  }
  return map;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const sessionStoreInternals = {
  statSync,
};

function pathExistsAsDirectory(path: string): boolean {
  try {
    return sessionStoreInternals.statSync(path).isDirectory();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

/**
 * Durable storage/index for resumable sessions and lightweight output snapshots.
 */
export class SessionStore {
  readonly persisted: Map<string, PersistedSessionInfo> = new Map();
  readonly repoPolicies: Map<string, RepoPolicyRecord> = new Map();
  readonly idIndex: Map<string, string> = new Map();
  readonly nameIndex: Map<string, string> = new Map();
  readonly backendIdIndex: Map<string, string> = new Map();
  readonly actionTokens: Map<string, SessionActionToken>;
  readonly actionTokenStore: SessionActionTokenStore;
  private readonly indexPath: string;
  private readonly queries: SessionStoreQueries;
  readonly instanceId: string;
  /** Write counter of the index this store last read or wrote. */
  private revision = 0;
  /** `statSessionStoreIndex` after this store's last read or write. */
  private diskSignature: string | undefined;
  /** Rows (as JSON) this store last read from or wrote to disk: the merge base. */
  private base = {
    sessions: new Map<string, string>(),
    tokens: new Map<string, string>(),
    policies: new Map<string, string>(),
  };
  /**
   * Rows another writer persisted that this store must keep on disk but must not
   * act on: sessions that writer reports as running (it owns them), and rows this
   * build cannot normalize. Keyed by session id.
   */
  private readonly carriedSessions = new Map<string, unknown>();
  private syncing = false;
  /** A save deferred because another writer held the lock (never blocks the event loop). */
  private deferredSave: { timer: ReturnType<typeof setTimeout>; since: number } | undefined;

  constructor(options: SessionStoreOptions = {}) {
    const env = options.env ?? process.env;
    this.indexPath = options.indexPath ?? resolveSessionIndexPath(env);
    this.instanceId = options.instanceId ?? "standalone";
    this.actionTokenStore = new SessionActionTokenStore(() => this.saveIndex(), SESSION_OUTPUT_MAX_AGE_MS);
    this.actionTokens = this.actionTokenStore.tokens;
    this.queries = new SessionStoreQueries({
      persisted: this.persisted,
      idIndex: this.idIndex,
      nameIndex: this.nameIndex,
      backendIdIndex: this.backendIdIndex,
    });

    if (env.OPENCLAW_DEBUG_SESSION_STORE === "1") {
      log.info(`[SessionStore] index path: ${this.indexPath}`);
    }
    this.loadIndex();
    this.captureBase();
    this.diskSignature = statSessionStoreIndex(this.indexPath);
    this.actionTokenStore.setDiskHooks({
      sync: (reason) => { this.syncFromDisk(reason); },
      onMiss: ({ reason }) => {
        log.debug(JSON.stringify({
          component: "SessionStore",
          event: "action_token_lookup_miss",
          reason,
          instanceId: this.instanceId,
          storeRevision: this.revision,
          tokensInMemory: this.actionTokens.size,
          adoptedTokens: this.actionTokenStore.adoptedTokenIds.size,
        }));
      },
    });
  }

  /** Store revision and identity, for diagnostics. */
  getDiagnostics(): { instanceId: string; storeRevision: number; tokensInMemory: number; carriedSessions: number } {
    return {
      instanceId: this.instanceId,
      storeRevision: this.revision,
      tokensInMemory: this.actionTokens.size,
      carriedSessions: this.carriedSessions.size,
    };
  }

  /** True when another live process runs this session (its row is carried, not adopted). */
  isSessionOwnedElsewhere(ref: string): boolean {
    this.syncFromDisk("ownership-check");
    return isForeignLiveRunningRow(this.carriedSessions.get(ref));
  }

  /** True when this store's own row for the session is a running row it wrote. */
  private isOwnRunningRow(key: string): boolean {
    const entry = this.persisted.get(this.idIndex.get(key) ?? key);
    return entry?.status === "running" && entry.runtimeOwner === runtimeOwnerMarker(this.instanceId);
  }

  private persistedRows(): unknown[] {
    return [...this.persisted.values(), ...this.carriedSessions.values()];
  }

  private localKeyedRows() {
    return {
      sessions: toKeyedJson(this.persistedRows(), sessionRowKey),
      tokens: toKeyedJson(this.actionTokenStore.listForPersistence(), idRowKey("id")),
      policies: toKeyedJson(this.repoPolicies.values(), idRowKey("key")),
    };
  }

  private captureBase(): void {
    this.base = this.localKeyedRows();
  }

  /**
   * Reload rows another writer changed since this store last read or wrote the
   * index (a no-op stat when nothing changed). Adoption never makes this runtime
   * act on another writer's live session: rows it reports as running are carried
   * for persistence only.
   */
  syncFromDisk(reason: string): boolean {
    if (this.syncing) return false;
    const signature = statSessionStoreIndex(this.indexPath);
    if (signature === this.diskSignature || signature === "missing") return false;
    const read = readSessionStoreSnapshot(this.indexPath);
    if (!read) return false;
    if ("unreadable" in read) {
      // Never replace another writer's data without a recoverable copy.
      backupUnmergeableSessionIndex(this.indexPath, read.unreadable);
      this.diskSignature = signature;
      return false;
    }
    const snapshot = read;
    this.syncing = true;
    try {
      const changed = this.mergeSnapshot(snapshot);
      this.revision = Math.max(this.revision, snapshot.revision);
      this.diskSignature = signature;
      this.base = {
        sessions: toKeyedJson(snapshot.sessions, sessionRowKey),
        tokens: toKeyedJson(snapshot.actionTokens, idRowKey("id")),
        policies: toKeyedJson(snapshot.repoPolicies, idRowKey("key")),
      };
      log.debug(JSON.stringify({
        component: "SessionStore",
        event: "index_reloaded_after_external_write",
        reason,
        instanceId: this.instanceId,
        storeRevision: this.revision,
        changedRows: changed,
      }));
      return changed > 0;
    } finally {
      this.syncing = false;
    }
  }

  /** Apply another writer's changes to memory; returns the number of rows taken from disk or dropped. */
  private mergeSnapshot(snapshot: SessionStoreDiskSnapshot): number {
    const local = this.localKeyedRows();
    let changed = 0;

    const diskSessions = new Map<string, unknown>();
    for (const row of snapshot.sessions) {
      const key = sessionRowKey(row);
      if (key) diskSessions.set(key, row);
    }
    const sessionChoices = mergeKeyedRows(this.base.sessions, local.sessions, toKeyedJson(snapshot.sessions, sessionRowKey));
    for (const [key, choice] of sessionChoices) {
      // A session another live process runs belongs to that process: its row
      // wins even over a local edit of this store's cached (stopped) copy.
      if (choice === "local" && isForeignLiveRunningRow(diskSessions.get(key))
        && diskSessions.get(key) !== undefined && !this.isOwnRunningRow(key)) {
        changed += 1;
        const existing = this.persisted.get(this.idIndex.get(key) ?? key);
        if (existing) this.removePersistedIndexes(existing);
        this.carriedSessions.set(key, diskSessions.get(key));
        continue;
      }
      if (choice === "local") continue;
      changed += 1;
      const existing = this.persisted.get(this.idIndex.get(key) ?? key);
      if (existing) this.removePersistedIndexes(existing);
      this.carriedSessions.delete(key);
      if (choice === "drop") continue;
      const raw = diskSessions.get(key);
      const entry = isForeignLiveRunningRow(raw) ? undefined : normalizePersistedEntry(raw);
      if (entry) this.indexPersistedEntry(entry);
      else this.carriedSessions.set(key, raw);
    }

    const diskTokens = new Map<string, unknown>();
    for (const row of snapshot.actionTokens) {
      const key = idRowKey("id")(row);
      if (key) diskTokens.set(key, row);
    }
    const tokenChoices = mergeKeyedRows(this.base.tokens, local.tokens, toKeyedJson(snapshot.actionTokens, idRowKey("id")));
    for (const [key, choice] of tokenChoices) {
      const localToken = this.actionTokens.get(key);
      if (choice === "local") {
        // A consumption recorded on either side is final.
        const diskToken = normalizeActionToken(diskTokens.get(key));
        if (localToken && localToken.consumedAt == null && diskToken?.consumedAt != null) {
          localToken.consumedAt = diskToken.consumedAt;
          changed += 1;
        }
        continue;
      }
      changed += 1;
      if (choice === "drop") {
        this.actionTokens.delete(key);
        this.actionTokenStore.adoptedTokenIds.delete(key);
        continue;
      }
      const token = normalizeActionToken(diskTokens.get(key));
      if (!token) continue;
      if (localToken?.consumedAt != null && token.consumedAt == null) token.consumedAt = localToken.consumedAt;
      if (!localToken) this.actionTokenStore.adoptedTokenIds.add(key);
      this.actionTokens.set(key, token);
    }

    const diskPolicies = new Map<string, unknown>();
    for (const row of snapshot.repoPolicies) {
      const key = idRowKey("key")(row);
      if (key) diskPolicies.set(key, row);
    }
    const policyChoices = mergeKeyedRows(this.base.policies, local.policies, toKeyedJson(snapshot.repoPolicies, idRowKey("key")));
    for (const [key, choice] of policyChoices) {
      if (choice === "local") continue;
      changed += 1;
      if (choice === "drop") {
        this.repoPolicies.delete(key);
        continue;
      }
      const policy = normalizeRepoPolicyRecord(diskPolicies.get(key));
      if (policy) this.repoPolicies.set(policy.key, policy);
    }
    return changed;
  }

  private loadIndex(): void {
    loadSessionStoreIndex({
      indexPath: this.indexPath,
      clearAll: () => {
        this.persisted.clear();
        this.repoPolicies.clear();
        this.idIndex.clear();
        this.nameIndex.clear();
        this.backendIdIndex.clear();
        this.actionTokenStore.clear();
      },
      indexPersistedEntry: (entry) => this.indexPersistedEntry(entry),
      setActionToken: (token) => { this.actionTokens.set(token.id, token); },
      setRepoPolicy: (policy) => { this.repoPolicies.set(policy.key, policy); },
      purgeExpiredActionTokens: () => this.actionTokenStore.purgeExpiredActionTokens(),
      saveIndex: () => this.saveIndex(),
      setRevision: (revision) => { this.revision = revision; },
      carrySession: (raw) => {
        const key = sessionRowKey(raw);
        if (key) this.carriedSessions.set(key, raw);
      },
    });
  }

  /**
   * Persist the index. When another writer changed the file since this store last
   * read or wrote it, merge its rows first instead of overwriting them. The write
   * itself stays atomic (temp file + rename).
   */
  saveIndex(): void {
    if (this.writeIndex({ force: false })) return;
    // Another writer holds the lock: keep the change in memory and retry shortly
    // instead of blocking the Gateway thread. Local changes stay the merge winner.
    if (this.deferredSave) return;
    const since = Date.now();
    const retry = (): void => {
      const force = Date.now() - since >= LOCKED_SAVE_MAX_DEFER_MS;
      if (force) log.warn("[SessionStore] Session store lock still held after 5 s; breaking it to save (with a merge).");
      if (this.writeIndex({ force })) {
        this.deferredSave = undefined;
        return;
      }
      this.deferredSave = { timer: setTimeout(retry, LOCKED_SAVE_RETRY_MS), since };
      this.deferredSave.timer.unref?.();
    };
    this.deferredSave = { timer: setTimeout(retry, LOCKED_SAVE_RETRY_MS), since };
    this.deferredSave.timer.unref?.();
  }

  /** Write a deferred save now (shutdown), breaking a held lock if necessary. */
  flushPendingSave(): void {
    if (!this.deferredSave) return;
    clearTimeout(this.deferredSave.timer);
    this.deferredSave = undefined;
    this.writeIndex({ force: true });
  }

  /**
   * Read-merge-write under the index lock. Returns false when another live
   * writer holds the lock (nothing written). The write itself is atomic.
   */
  private writeIndex(options: { force: boolean }): boolean {
    const lock = tryAcquireSessionStoreLock(this.indexPath, options);
    if (lock === "busy") return false;
    try {
      // Before load completes, the constructor has no base yet; write as loaded.
      if (this.diskSignature !== undefined) this.syncFromDisk("save");
      const revision = this.revision + 1;
      const written = saveSessionStoreIndex(
        this.indexPath,
        this.persistedRows(),
        this.actionTokenStore.listForPersistence(),
        [...this.repoPolicies.values()],
        revision,
      );
      if (written && this.diskSignature !== undefined) {
        this.revision = revision;
        this.captureBase();
        this.diskSignature = statSessionStoreIndex(this.indexPath);
      }
      return true;
    } finally {
      if (lock !== "unavailable") lock.release();
    }
  }

  assertPersistedEntry(entry: PersistedSessionInfo): void {
    assertNewSchemaEntry(entry);
  }

  private getEntryStorageKey(entry: PersistedSessionInfo): string {
    // Persisted map storage still uses harnessSessionId for compatibility with the
    // on-disk shape, but backend conversation ids are the preferred runtime identity.
    return entry.harnessSessionId;
  }

  private buildPersistedBackendRef(session: Session): PersistedSessionInfo["backendRef"] {
    const harnessName = resolveHarnessName(session);
    const fallbackKind = harnessName === "codex"
      ? "codex-app-server"
      : harnessName === "opencode"
        ? "opencode-server"
        : "claude-code";
    return session.backendRef ?? {
      kind: session.backendKind ?? fallbackKind,
      conversationId: session.harnessSessionId!,
    };
  }

  private getSessionApprovalSnapshot(session: Session): ReturnType<Session["approvalSnapshot"]> {
    if (typeof session.approvalSnapshot === "function") {
      return session.approvalSnapshot();
    }
    const control = typeof session.controlStateSnapshot === "function"
      ? session.controlStateSnapshot()
      : { planModeApproved: false };
    return {
      requestedPermissionMode: session.requestedPermissionMode,
      currentPermissionMode: session.currentPermissionMode,
      approvalExecutionState: session.approvalExecutionState,
      approvalRationale: session.approvalRationale,
      planModeApproved: control.planModeApproved,
      pendingPlanApproval: session.pendingPlanApproval,
      planApprovalContext: session.planApprovalContext,
      planDecisionVersion: session.planDecisionVersion,
      actionablePlanDecisionVersion: session.actionablePlanDecisionVersion,
      canonicalPlanPromptVersion: session.canonicalPlanPromptVersion,
      approvalPromptRequiredVersion: session.approvalPromptRequiredVersion,
      approvalPromptVersion: session.approvalPromptVersion,
      approvalPromptStatus: session.approvalPromptStatus,
      approvalPromptTransport: session.approvalPromptTransport,
      approvalPromptMessageKind: session.approvalPromptMessageKind,
      approvalPromptLastAttemptAt: session.approvalPromptLastAttemptAt,
      approvalPromptDeliveredAt: session.approvalPromptDeliveredAt,
      approvalPromptFailedAt: session.approvalPromptFailedAt,
      planApproval: session.planApproval,
    };
  }

  private getSessionRoutingSnapshot(session: Session): ReturnType<Session["routingSnapshot"]> {
    return typeof session.routingSnapshot === "function"
      ? session.routingSnapshot()
      : {
          route: session.route,
          originAgentId: session.originAgentId,
          originChannel: session.originChannel,
          originThreadId: session.originThreadId,
          originSessionKey: session.originSessionKey,
        };
  }

  private getSessionWorktreeSnapshot(session: Session): ReturnType<Session["worktreeSnapshot"]> {
    return typeof session.worktreeSnapshot === "function"
      ? session.worktreeSnapshot()
      : {
      worktreePath: session.worktreePath,
      worktreeBranch: session.worktreeBranch,
      worktreeStrategy: session.worktreeStrategy,
      repoIntegrationPolicy: session.repoIntegrationPolicy,
      repoIntegrationPolicySource: session.repoIntegrationPolicySource,
      repoProvider: session.repoProvider,
      worktreeBaseBranch: session.worktreeBaseBranch,
      worktreeParentBranch: session.worktreeParentBranch,
          worktreePrTargetRepo: session.worktreePrTargetRepo,
          autoMergeParentSessionId: session.autoMergeParentSessionId,
          autoMergeConflictResolutionAttemptCount: session.autoMergeConflictResolutionAttemptCount,
          autoMergeResolverSessionId: session.autoMergeResolverSessionId,
          worktreeLifecycle: session.worktreeLifecycle,
        };
  }

  private indexPersistedEntry(entry: PersistedSessionInfo): void {
    const storageKey = this.getEntryStorageKey(entry);
    if (entry.sessionId) {
      const replacedStorageKey = this.idIndex.get(entry.sessionId);
      if (replacedStorageKey && replacedStorageKey !== storageKey) {
        const replaced = this.persisted.get(replacedStorageKey);
        if (replaced) this.removePersistedIndexes(replaced);
      }
    }
    this.persisted.set(storageKey, entry);
    // This store now owns the row: drop any copy carried from another writer.
    if (entry.sessionId) this.carriedSessions.delete(entry.sessionId);
    this.carriedSessions.delete(entry.harnessSessionId);
    if (entry.sessionId) this.idIndex.set(entry.sessionId, storageKey);
    if (entry.name) this.nameIndex.set(entry.name, storageKey);
    const backendConversationId = getBackendConversationId(entry);
    if (backendConversationId) this.backendIdIndex.set(backendConversationId, storageKey);
  }

  private removePersistedIndexes(entry: PersistedSessionInfo): void {
    const storageKey = this.getEntryStorageKey(entry);
    this.persisted.delete(storageKey);

    for (const [k, v] of this.idIndex) {
      if (v === storageKey) this.idIndex.delete(k);
    }
    for (const [k, v] of this.nameIndex) {
      if (v === storageKey) this.nameIndex.delete(k);
    }
    for (const [k, v] of this.backendIdIndex) {
      if (v === storageKey) this.backendIdIndex.delete(k);
    }
  }

  /** Persist a running-session stub so crash/restart can recover routing metadata. */
  markRunning(session: Session): void {
    if (!session.harnessSessionId) return;
    const approval = this.getSessionApprovalSnapshot(session);
    const routing = this.getSessionRoutingSnapshot(session);
    const worktree = this.getSessionWorktreeSnapshot(session);
    const route = canonicalizeSessionRoute({
      route: routing.route,
      originChannel: routing.originChannel,
      originThreadId: routing.originThreadId,
      originSessionKey: routing.originSessionKey,
    });
    if (!route) {
      throw new Error(`Cannot persist running session ${session.id}: canonical lifecycle route is missing.`);
    }
    const stub: PersistedSessionInfo = {
      sessionId: session.id,
      harnessSessionId: session.harnessSessionId,
      backendRef: this.buildPersistedBackendRef(session),
      name: session.name,
      prompt: session.prompt,
      workdir: session.originalWorkdir ?? session.workdir, // E1: Always write originalWorkdir
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      fastMode: session.fastMode,
      createdAt: session.startedAt,
      status: "running",
      runtimeOwner: runtimeOwnerMarker(this.instanceId),
      lifecycle: session.lifecycle,
      approvalState: session.approvalState,
      worktreeState: session.worktreeState,
      runtimeState: session.runtimeState,
      taskFlowMirror: session.taskFlowMirror,
      deliveryState: session.deliveryState,
      notificationDedupe: this.getExistingNotificationDedupe(session),
      completionSummaryDedupe: this.getExistingCompletionSummaryDedupe(session),
      costUsd: 0,
      originAgentId: routing.originAgentId,
      originChannel: routing.originChannel,
      originThreadId: routing.originThreadId,
      originSessionKey: routing.originSessionKey,
      route,
      outputPath: getSessionOutputFilePath(session.id),
      harness: session.harnessName,
      resumedFromSessionName: session.resumedFromSessionName,
      requestedPermissionMode: approval.requestedPermissionMode,
      currentPermissionMode: approval.currentPermissionMode,
      approvalExecutionState: approval.approvalExecutionState,
      approvalRationale: approval.approvalRationale,
      planModeApproved: approval.planModeApproved,
      pendingPlanApproval: approval.pendingPlanApproval,
      planApprovalContext: approval.planApprovalContext,
      planDecisionVersion: approval.planDecisionVersion,
      actionablePlanDecisionVersion: approval.actionablePlanDecisionVersion,
      canonicalPlanPromptVersion: approval.canonicalPlanPromptVersion,
      approvalPromptRequiredVersion: approval.approvalPromptRequiredVersion,
      approvalPromptVersion: approval.approvalPromptVersion,
      approvalPromptStatus: approval.approvalPromptStatus,
      approvalPromptTransport: approval.approvalPromptTransport,
      approvalPromptMessageKind: approval.approvalPromptMessageKind,
      approvalPromptLastAttemptAt: approval.approvalPromptLastAttemptAt,
      approvalPromptDeliveredAt: approval.approvalPromptDeliveredAt,
      approvalPromptFailedAt: approval.approvalPromptFailedAt,
      planApproval: approval.planApproval,
      worktreePath: worktree.worktreePath,
      worktreeBranch: worktree.worktreeBranch,
      worktreeStrategy: worktree.worktreeStrategy,
      repoIntegrationPolicy: worktree.repoIntegrationPolicy,
      repoIntegrationPolicySource: worktree.repoIntegrationPolicySource,
      repoProvider: worktree.repoProvider,
      worktreeBaseBranch: worktree.worktreeBaseBranch,
      worktreeParentBranch: worktree.worktreeParentBranch,
      worktreePrTargetRepo: worktree.worktreePrTargetRepo,
      autoMergeParentSessionId: worktree.autoMergeParentSessionId,
      autoMergeConflictResolutionAttemptCount: worktree.autoMergeConflictResolutionAttemptCount,
      autoMergeResolverSessionId: worktree.autoMergeResolverSessionId,
      worktreeLifecycle: worktree.worktreeLifecycle,
      resumable: session.isExplicitlyResumable,
    };
    assertNewSchemaEntry(stub);
    this.indexPersistedEntry(stub);
    this.saveIndex();
  }

  /** Persist terminal session metadata and write a best-effort tmp output snapshot. */
  persistTerminal(session: Session): void {
    if (!session.harnessSessionId) return;
    const approval = this.getSessionApprovalSnapshot(session);
    const routing = this.getSessionRoutingSnapshot(session);
    const worktree = this.getSessionWorktreeSnapshot(session);
    const route = canonicalizeSessionRoute({
      route: routing.route,
      originChannel: routing.originChannel,
      originThreadId: routing.originThreadId,
      originSessionKey: routing.originSessionKey,
    });
    if (!route) {
      throw new Error(`Cannot persist terminal session ${session.id}: canonical lifecycle route is missing.`);
    }

    let outputPath: string | undefined;
    try {
      const outputFile = getSessionOutputFilePath(session.id);
      if (existsSync(outputFile)) {
        // The incremental appendFileSync writes during session execution already
        // produced a complete file. Using it directly preserves output that may
        // have been evicted from the in-memory buffer (capped at 2000 items).
        outputPath = outputFile;
      } else {
        // Fallback: no incremental file exists (e.g. disk error during session),
        // so write the in-memory buffer as a best-effort snapshot.
        const fullOutput = session.getOutput().join("\n");
        if (fullOutput.length > 0) {
          ensureSessionOutputDir(outputFile);
          writeFileSync(outputFile, fullOutput, { encoding: "utf-8", mode: 0o600 });
          outputPath = outputFile;
        }
      }
    } catch (err: unknown) {
      log.warn(`[SessionStore] Failed to write output file for session ${session.id}: ${errorMessage(err)}`);
    }

    const info: PersistedSessionInfo = {
      sessionId: session.id,
      harnessSessionId: session.harnessSessionId,
      backendRef: this.buildPersistedBackendRef(session),
      name: session.name,
      prompt: session.prompt,
      workdir: session.originalWorkdir ?? session.workdir, // E1: Always write originalWorkdir
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      fastMode: session.fastMode,
      createdAt: session.startedAt,
      completedAt: session.completedAt,
      status: session.status,
      lifecycle: session.lifecycle,
      approvalState: session.approvalState,
      worktreeState: session.worktreeState,
      runtimeState: session.runtimeState,
      taskFlowMirror: session.taskFlowMirror,
      deliveryState: session.deliveryState,
      notificationDedupe: this.getExistingNotificationDedupe(session),
      completionSummaryDedupe: this.getExistingCompletionSummaryDedupe(session),
      killReason: session.killReason,
      costUsd: session.costUsd,
      originAgentId: routing.originAgentId,
      originChannel: routing.originChannel,
      originThreadId: routing.originThreadId,
      originSessionKey: routing.originSessionKey,
      route,
      outputPath,
      harness: session.harnessName,
      resumedFromSessionName: session.resumedFromSessionName,
      goalTaskId: session.goalTaskId,
      requestedPermissionMode: approval.requestedPermissionMode,
      currentPermissionMode: approval.currentPermissionMode,
      approvalExecutionState: approval.approvalExecutionState,
      approvalRationale: approval.approvalRationale,
      planModeApproved: approval.planModeApproved,
      pendingPlanApproval: approval.pendingPlanApproval,
      planApprovalContext: approval.planApprovalContext,
      planDecisionVersion: approval.planDecisionVersion,
      actionablePlanDecisionVersion: approval.actionablePlanDecisionVersion,
      canonicalPlanPromptVersion: approval.canonicalPlanPromptVersion,
      approvalPromptRequiredVersion: approval.approvalPromptRequiredVersion,
      approvalPromptVersion: approval.approvalPromptVersion,
      approvalPromptStatus: approval.approvalPromptStatus,
      approvalPromptTransport: approval.approvalPromptTransport,
      approvalPromptMessageKind: approval.approvalPromptMessageKind,
      approvalPromptLastAttemptAt: approval.approvalPromptLastAttemptAt,
      approvalPromptDeliveredAt: approval.approvalPromptDeliveredAt,
      approvalPromptFailedAt: approval.approvalPromptFailedAt,
      planApproval: approval.planApproval,
      worktreePath: worktree.worktreePath,
      worktreeBranch: worktree.worktreeBranch,
      worktreeStrategy: worktree.worktreeStrategy,
      worktreeBaseBranch: worktree.worktreeBaseBranch,
      worktreeParentBranch: worktree.worktreeParentBranch,
      worktreePrTargetRepo: worktree.worktreePrTargetRepo,
      autoMergeParentSessionId: worktree.autoMergeParentSessionId,
      autoMergeConflictResolutionAttemptCount: worktree.autoMergeConflictResolutionAttemptCount,
      autoMergeResolverSessionId: worktree.autoMergeResolverSessionId,
      worktreeLifecycle: worktree.worktreeLifecycle,
      resumable: session.isExplicitlyResumable,
    };
    assertNewSchemaEntry(info);

    this.indexPersistedEntry(info);
    this.saveIndex();
  }

  private getExistingNotificationDedupe(session: Session): PersistedSessionInfo["notificationDedupe"] {
    return this.getPersistedSession(session.id)?.notificationDedupe
      ?? (getBackendConversationId(session) ? this.getPersistedSession(getBackendConversationId(session)!)?.notificationDedupe : undefined);
  }

  private getExistingCompletionSummaryDedupe(session: Session): PersistedSessionInfo["completionSummaryDedupe"] {
    return this.getPersistedSession(session.id)?.completionSummaryDedupe
      ?? (getBackendConversationId(session) ? this.getPersistedSession(getBackendConversationId(session)!)?.completionSummaryDedupe : undefined);
  }

  /** Return newest persisted entry for a user-facing name, handling name collisions. */
  getLatestPersistedByName(name: string): PersistedSessionInfo | undefined {
    return this.queries.getLatestPersistedByName(name);
  }

  /** Resolve any session reference to the canonical backend conversation id when available. */
  resolveBackendConversationId(ref: string, activeBackendConversationId?: string): string | undefined {
    return this.queries.resolveBackendConversationId(ref, activeBackendConversationId);
  }

  /** Resolve persisted session metadata by session id, name, backend id, or compatibility key. */
  getPersistedSession(ref: string): PersistedSessionInfo | undefined {
    // Pick up another writer's changes first (a stat when nothing changed), so a
    // session it resumed is never returned from this store's stale cache.
    if (!this.syncing) this.syncFromDisk("session-lookup");
    return this.queries.getPersistedSession(ref);
  }

  replacePersistedSession(entry: PersistedSessionInfo): void {
    const existing = entry.sessionId ? this.getPersistedSession(entry.sessionId) : undefined;
    if (existing) this.removePersistedIndexes(existing);
    this.indexPersistedEntry(entry);
    this.saveIndex();
  }

  /** List persisted sessions sorted by completion time (newest first). */
  listPersistedSessions(): PersistedSessionInfo[] {
    return this.queries.listPersistedSessions();
  }

  getRepoPolicy(key: string): RepoPolicyRecord | undefined {
    return this.repoPolicies.get(key);
  }

  listRepoPolicies(): RepoPolicyRecord[] {
    return [...this.repoPolicies.values()]
      .sort((a, b) => a.repoRoot.localeCompare(b.repoRoot) || a.key.localeCompare(b.key));
  }

  setRepoPolicy(record: RepoPolicyRecord): RepoPolicyRecord {
    const existing = this.repoPolicies.get(record.key);
    const next: RepoPolicyRecord = {
      ...record,
      createdAt: existing?.createdAt ?? record.createdAt,
      updatedAt: new Date().toISOString(),
      source: "stored",
    };
    this.repoPolicies.set(next.key, next);
    this.saveIndex();
    return next;
  }

  updateRepoPolicy(key: string, policy: RepoIntegrationPolicy): RepoPolicyRecord | undefined {
    const existing = this.repoPolicies.get(key);
    if (!existing) return undefined;
    return this.setRepoPolicy({ ...existing, policy });
  }

  resetRepoPolicy(key: string): boolean {
    const deleted = this.repoPolicies.delete(key);
    if (deleted) this.saveIndex();
    return deleted;
  }

  removeRepoPolicies(keys: Iterable<string>): RepoPolicyRecord[] {
    const removed: RepoPolicyRecord[] = [];
    for (const key of keys) {
      const record = this.repoPolicies.get(key);
      if (!record) continue;
      this.repoPolicies.delete(key);
      removed.push(record);
    }
    if (removed.length > 0) this.saveIndex();
    return removed.sort((a, b) => a.repoRoot.localeCompare(b.repoRoot) || a.key.localeCompare(b.key));
  }

  cleanupRepoPolicies(): RepoPolicyRecord[] {
    const removed: RepoPolicyRecord[] = [];
    for (const [key, record] of this.repoPolicies) {
      if (pathExistsAsDirectory(record.repoRoot)) continue;
      this.repoPolicies.delete(key);
      removed.push(record);
    }
    if (removed.length > 0) this.saveIndex();
    return removed.sort((a, b) => a.repoRoot.localeCompare(b.repoRoot) || a.key.localeCompare(b.key));
  }

  /** Best-effort cleanup for stale tmp output files written by persistTerminal. */
  cleanupSessionOutputFiles(now: number): void {
    this.actionTokenStore.purgeExpiredActionTokens(now);
    cleanupSessionOutputFiles(now, SESSION_OUTPUT_MAX_AGE_MS, this.getReferencedOutputPaths());
  }

  getNextSessionOutputCleanupAt(now: number): number | undefined {
    return getNextSessionOutputCleanupAt(now, SESSION_OUTPUT_MAX_AGE_MS, this.getReferencedOutputPaths());
  }

  /** Enforce max persisted session retention by evicting oldest records and indexes. */
  evictOldestPersisted(maxPersistedSessions: number): PersistedSessionInfo[] {
    const all = this.listPersistedSessions();
    if (all.length <= maxPersistedSessions) return [];

    const toEvict = all.slice(maxPersistedSessions);
    for (const info of toEvict) {
      this.removePersistedIndexes(info);
    }
    this.saveIndex();
    return toEvict;
  }

  /** True when a runtime terminal session exceeded the configured in-memory TTL. */
  shouldGcActiveSession(session: Session, now: number, cleanupMaxAgeMs: number): boolean {
    if (!session.completedAt) return false;
    if (!TERMINAL_STATUSES.has(session.status)) return false;
    return now - session.completedAt > cleanupMaxAgeMs;
  }

  getActionToken(tokenId: string): SessionActionToken | undefined {
    return this.actionTokenStore.getActionToken(tokenId);
  }

  consumeActionToken(tokenId: string): SessionActionToken | undefined {
    return this.actionTokenStore.consumeActionToken(tokenId);
  }

  deleteActionTokensForSession(sessionId: string): void {
    this.actionTokenStore.deleteActionTokensForSession(sessionId);
  }

  purgeExpiredActionTokens(now: number = Date.now()): boolean {
    return this.actionTokenStore.purgeExpiredActionTokens(now);
  }

  getNextActionTokenExpiry(): number | undefined {
    return this.actionTokenStore.nextExpiryAt();
  }

  onActionTokensChanged(listener: (() => void) | undefined): void {
    this.actionTokenStore.setAfterChangeListener(listener);
  }

  hasOutputPathReference(outputPath: string): boolean {
    for (const session of this.persisted.values()) {
      if (session.outputPath === outputPath) return true;
    }
    return false;
  }

  getReferencedOutputPaths(): string[] {
    return [...new Set(
      [...this.persisted.values()]
        .map((session) => session.outputPath)
        .filter((path): path is string => typeof path === "string" && path.length > 0),
    )];
  }

  cleanupOrphanOutputFiles(): void {
    cleanupOrphanOutputFiles(this.getReferencedOutputPaths());
  }
}
