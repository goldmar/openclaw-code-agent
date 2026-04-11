import { existsSync, writeFileSync } from "fs";
import type {
  PersistedSessionInfo,
  SessionStatus,
  SessionActionToken,
} from "./types";
import type { Session } from "./session";
import { getSessionOutputFilePath } from "./session";
import { canonicalizeSessionRoute } from "./session-route";
import { SessionActionTokenStore } from "./session-action-token-store";
import { getBackendConversationId, resolveHarnessName } from "./session-backend-ref";
import { SessionStoreQueries } from "./session-store-queries";
import {
  archiveLegacyCodexEntries,
  archiveLegacySessionIndex,
  cleanupOrphanOutputFiles,
  cleanupTmpOutputFiles,
  getNextTmpOutputCleanupAt,
  loadSessionStoreIndex,
  resolveSessionIndexPath,
  saveSessionStoreIndex,
} from "./session-store-storage";
import {
  assertNewSchemaEntry,
  STORE_SCHEMA_VERSION,
} from "./session-store-normalization";

const TERMINAL_STATUSES = new Set<SessionStatus>(["completed", "failed", "killed"]);
const TMP_OUTPUT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface SessionStoreOptions {
  env?: NodeJS.ProcessEnv;
  indexPath?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Durable storage/index for resumable sessions and lightweight output snapshots.
 */
export class SessionStore {
  readonly persisted: Map<string, PersistedSessionInfo> = new Map();
  readonly idIndex: Map<string, string> = new Map();
  readonly nameIndex: Map<string, string> = new Map();
  readonly backendIdIndex: Map<string, string> = new Map();
  readonly actionTokens: Map<string, SessionActionToken>;
  readonly actionTokenStore: SessionActionTokenStore;
  private readonly indexPath: string;
  private readonly queries: SessionStoreQueries;

  constructor(options: SessionStoreOptions = {}) {
    const env = options.env ?? process.env;
    this.indexPath = options.indexPath ?? resolveSessionIndexPath(env);
    this.actionTokenStore = new SessionActionTokenStore(() => this.saveIndex(), TMP_OUTPUT_MAX_AGE_MS);
    this.actionTokens = this.actionTokenStore.tokens;
    this.queries = new SessionStoreQueries({
      persisted: this.persisted,
      idIndex: this.idIndex,
      nameIndex: this.nameIndex,
      backendIdIndex: this.backendIdIndex,
    });

    if (env.OPENCLAW_DEBUG_SESSION_STORE === "1") {
      console.warn(`[SessionStore] index path: ${this.indexPath}`);
    }
    this.loadIndex();
  }

  private loadIndex(): void {
    loadSessionStoreIndex({
      indexPath: this.indexPath,
      clearAll: () => {
        this.persisted.clear();
        this.idIndex.clear();
        this.nameIndex.clear();
        this.backendIdIndex.clear();
        this.actionTokenStore.clear();
      },
      indexPersistedEntry: (entry) => this.indexPersistedEntry(entry),
      setActionToken: (token) => { this.actionTokens.set(token.id, token); },
      purgeExpiredActionTokens: () => this.actionTokenStore.purgeExpiredActionTokens(),
      saveIndex: () => this.saveIndex(),
    });
  }

  saveIndex(): void {
    saveSessionStoreIndex(
      this.indexPath,
      [...this.persisted.values()],
      this.actionTokenStore.listForPersistence(),
    );
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
    return session.backendRef ?? {
      kind: resolveHarnessName(session) === "codex" ? "codex-app-server" : "claude-code",
      conversationId: session.harnessSessionId!,
    };
  }

  private indexPersistedEntry(entry: PersistedSessionInfo): void {
    const storageKey = this.getEntryStorageKey(entry);
    this.persisted.set(storageKey, entry);
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
    const control = typeof session.controlStateSnapshot === "function"
      ? session.controlStateSnapshot()
      : {
          planModeApproved: false,
        };
    const route = canonicalizeSessionRoute({
      route: session.route,
      originChannel: session.originChannel,
      originThreadId: session.originThreadId,
      originSessionKey: session.originSessionKey,
    });
    if (!route) return;
    const stub: PersistedSessionInfo = {
      sessionId: session.id,
      harnessSessionId: session.harnessSessionId,
      backendRef: this.buildPersistedBackendRef(session),
      name: session.name,
      prompt: session.prompt,
      workdir: session.originalWorkdir ?? session.workdir, // E1: Always write originalWorkdir
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      createdAt: session.startedAt,
      status: "running",
      lifecycle: session.lifecycle,
      approvalState: session.approvalState,
      worktreeState: session.worktreeState,
      runtimeState: session.runtimeState,
      deliveryState: session.deliveryState,
      costUsd: 0,
      originAgentId: session.originAgentId,
      originChannel: session.originChannel,
      originThreadId: session.originThreadId,
      originSessionKey: session.originSessionKey,
      route,
      harness: session.harnessName,
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
      codexApprovalPolicy: session.codexApprovalPolicy,
      worktreePath: session.worktreePath,
      worktreeBranch: session.worktreeBranch,
      worktreeStrategy: session.worktreeStrategy,
      worktreeBaseBranch: session.worktreeBaseBranch,
      worktreePrTargetRepo: session.worktreePrTargetRepo,
      autoMergeParentSessionId: session.autoMergeParentSessionId,
      autoMergeConflictResolutionAttemptCount: session.autoMergeConflictResolutionAttemptCount,
      autoMergeResolverSessionId: session.autoMergeResolverSessionId,
      worktreeLifecycle: session.worktreeLifecycle,
      resumable: session.isExplicitlyResumable,
    };
    assertNewSchemaEntry(stub);
    this.indexPersistedEntry(stub);
    this.saveIndex();
  }

  /** True when this internal session id was already indexed in persisted storage. */
  hasRecordedSession(sessionId: string): boolean {
    return this.queries.hasRecordedSession(sessionId);
  }

  /** Persist terminal session metadata and write a best-effort tmp output snapshot. */
  persistTerminal(session: Session): void {
    if (!session.harnessSessionId) return;
    const control = typeof session.controlStateSnapshot === "function"
      ? session.controlStateSnapshot()
      : {
          planModeApproved: false,
        };
    const route = canonicalizeSessionRoute({
      route: session.route,
      originChannel: session.originChannel,
      originThreadId: session.originThreadId,
      originSessionKey: session.originSessionKey,
    });
    if (!route) return;

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
          writeFileSync(outputFile, fullOutput, "utf-8");
          outputPath = outputFile;
        }
      }
    } catch (err: unknown) {
      console.warn(`[SessionStore] Failed to write output file for session ${session.id}: ${errorMessage(err)}`);
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
      createdAt: session.startedAt,
      completedAt: session.completedAt,
      status: session.status,
      lifecycle: session.lifecycle,
      approvalState: session.approvalState,
      worktreeState: session.worktreeState,
      runtimeState: session.runtimeState,
      deliveryState: session.deliveryState,
      killReason: session.killReason,
      costUsd: session.costUsd,
      originAgentId: session.originAgentId,
      originChannel: session.originChannel,
      originThreadId: session.originThreadId,
      originSessionKey: session.originSessionKey,
      route,
      outputPath,
      harness: session.harnessName,
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
      codexApprovalPolicy: session.codexApprovalPolicy,
      worktreePath: session.worktreePath,
      worktreeBranch: session.worktreeBranch,
      worktreeStrategy: session.worktreeStrategy,
      worktreeBaseBranch: session.worktreeBaseBranch,
      worktreePrTargetRepo: session.worktreePrTargetRepo,
      autoMergeParentSessionId: session.autoMergeParentSessionId,
      autoMergeConflictResolutionAttemptCount: session.autoMergeConflictResolutionAttemptCount,
      autoMergeResolverSessionId: session.autoMergeResolverSessionId,
      worktreeLifecycle: session.worktreeLifecycle,
      resumable: session.isExplicitlyResumable,
    };
    assertNewSchemaEntry(info);

    this.indexPersistedEntry(info);
    this.saveIndex();
  }

  /** Return newest persisted entry for a user-facing name, handling name collisions. */
  getLatestPersistedByName(name: string): PersistedSessionInfo | undefined {
    return this.queries.getLatestPersistedByName(name);
  }

  /** Resolve any session reference to the canonical backend conversation id when available. */
  resolveBackendConversationId(ref: string, activeBackendConversationId?: string): string | undefined {
    return this.queries.resolveBackendConversationId(ref, activeBackendConversationId);
  }

  /** Compatibility wrapper retained for older call sites and tests. */
  resolveHarnessSessionId(ref: string, activeHarnessSessionId?: string): string | undefined {
    return this.queries.resolveHarnessSessionId(ref, activeHarnessSessionId);
  }

  /** Resolve persisted session metadata by session id, name, backend id, or compatibility key. */
  getPersistedSession(ref: string): PersistedSessionInfo | undefined {
    return this.queries.getPersistedSession(ref);
  }

  /** List persisted sessions sorted by completion time (newest first). */
  listPersistedSessions(): PersistedSessionInfo[] {
    return this.queries.listPersistedSessions();
  }

  /** Best-effort cleanup for stale tmp output files written by persistTerminal. */
  cleanupTmpOutputFiles(now: number): void {
    this.actionTokenStore.purgeExpiredActionTokens(now);
    cleanupTmpOutputFiles(now, TMP_OUTPUT_MAX_AGE_MS);
  }

  getNextTmpOutputCleanupAt(now: number): number | undefined {
    return getNextTmpOutputCleanupAt(now, TMP_OUTPUT_MAX_AGE_MS);
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

  purgeExpiredActionTokens(now: number = Date.now()): void {
    this.actionTokenStore.purgeExpiredActionTokens(now);
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
