import type { Session } from "./session";
import { getBackendConversationId, getPrimarySessionLookupRef } from "./session-backend-ref";
import type { PersistedSessionInfo } from "./types";

type PersistedStore = Pick<
  import("./session-store").SessionStore,
  "getPersistedSession" | "assertPersistedEntry" | "saveIndex"
>;

/**
 * Bridges persisted session patches and live in-memory Session instances.
 * This is the only place that knows how persisted fields map back onto a live
 * reducer-backed Session object.
 */
export class SessionStateSyncService {
  constructor(
    private readonly deps: {
      store: PersistedStore;
      sessions: Map<string, Session>;
      resolveSession: (ref: string) => Session | undefined;
    },
  ) {}

  applySessionPatch(ref: string, patch: Partial<PersistedSessionInfo>): boolean {
    const existing = this.deps.store.getPersistedSession(ref);
    if (existing) {
      Object.assign(existing, patch);
      this.deps.store.assertPersistedEntry(existing);
    }

    const active = this.findActiveSessionForRef(ref, existing);
    if (active) {
      this.applyPatchToActiveSession(active, patch);
    }

    if (!existing && !active) return false;
    if (existing) this.deps.store.saveIndex();
    return true;
  }

  private matchesExistingSession(session: Session, existing?: PersistedSessionInfo): boolean {
    if (!existing) return false;
    const sessionBackendConversationId = getBackendConversationId(session);
    const existingBackendConversationId = getBackendConversationId(existing);
    if (existing.sessionId && session.id === existing.sessionId) return true;
    if (existingBackendConversationId && existingBackendConversationId === sessionBackendConversationId) return true;
    if (existing?.harnessSessionId && session.harnessSessionId === existing.harnessSessionId) return true;
    if (existing?.name && session.name === existing.name) return true;
    return false;
  }

  private findActiveSessionForRef(ref: string, existing?: PersistedSessionInfo): Session | undefined {
    const byResolve = this.deps.resolveSession(ref);
    if (byResolve) return byResolve;

    for (const session of this.deps.sessions.values()) {
      if (getPrimarySessionLookupRef(session) === ref) return session;
      if (getBackendConversationId(session) === ref) return session;
      if (session.harnessSessionId === ref) return session; // compatibility-only lookup
      if (this.matchesExistingSession(session, existing)) return session;
    }

    return undefined;
  }

  private applyPatchToActiveSession(session: Session, patch: Partial<PersistedSessionInfo>): void {
    this.applyControlStatePatch(session, patch);
    this.applySessionMetadataPatch(session, patch);
    this.applyWorktreeMetadataPatch(session, patch);
  }

  private applyControlStatePatch(session: Session, patch: Partial<PersistedSessionInfo>): void {
    const controlPatch = {
      lifecycle: patch.lifecycle,
      approvalState: patch.approvalState,
      worktreeState: patch.worktreeState,
      runtimeState: patch.runtimeState,
      deliveryState: patch.deliveryState,
      pendingPlanApproval: patch.pendingPlanApproval,
      planApprovalContext: patch.planApprovalContext,
      planDecisionVersion: patch.planDecisionVersion,
      actionablePlanDecisionVersion: patch.actionablePlanDecisionVersion,
      canonicalPlanPromptVersion: patch.canonicalPlanPromptVersion,
      approvalPromptRequiredVersion: patch.approvalPromptRequiredVersion,
      approvalPromptVersion: patch.approvalPromptVersion,
      approvalPromptStatus: patch.approvalPromptStatus,
      approvalPromptTransport: patch.approvalPromptTransport,
      approvalPromptMessageKind: patch.approvalPromptMessageKind,
      approvalPromptLastAttemptAt: patch.approvalPromptLastAttemptAt,
      approvalPromptDeliveredAt: patch.approvalPromptDeliveredAt,
      approvalPromptFailedAt: patch.approvalPromptFailedAt,
      pendingWorktreeDecisionSince: patch.pendingWorktreeDecisionSince,
    };

    if (typeof (session as Session & { applyControlPatch?: unknown }).applyControlPatch === "function") {
      session.applyControlPatch(controlPatch);
      return;
    }

    this.assignIfDefined(session, "lifecycle", patch.lifecycle);
    this.assignIfDefined(session, "approvalState", patch.approvalState);
    this.assignIfDefined(session, "worktreeState", patch.worktreeState);
    this.assignIfDefined(session, "runtimeState", patch.runtimeState);
    this.assignIfDefined(session, "deliveryState", patch.deliveryState);
    this.assignIfDefined(session, "pendingPlanApproval", patch.pendingPlanApproval);
    this.assignIfDefined(session, "planApprovalContext", patch.planApprovalContext);
    this.assignIfDefined(session, "planDecisionVersion", patch.planDecisionVersion);
    this.assignIfDefined(session, "actionablePlanDecisionVersion", patch.actionablePlanDecisionVersion);
    this.assignIfDefined(session, "canonicalPlanPromptVersion", patch.canonicalPlanPromptVersion);
    this.assignIfDefined(session, "approvalPromptRequiredVersion", patch.approvalPromptRequiredVersion);
    this.assignIfDefined(session, "approvalPromptVersion", patch.approvalPromptVersion);
    this.assignIfDefined(session, "approvalPromptStatus", patch.approvalPromptStatus);
    this.assignIfDefined(session, "approvalPromptTransport", patch.approvalPromptTransport);
    this.assignIfDefined(session, "approvalPromptMessageKind", patch.approvalPromptMessageKind);
    this.assignIfDefined(session, "approvalPromptLastAttemptAt", patch.approvalPromptLastAttemptAt);
    this.assignIfDefined(session, "approvalPromptDeliveredAt", patch.approvalPromptDeliveredAt);
    this.assignIfDefined(session, "approvalPromptFailedAt", patch.approvalPromptFailedAt);
  }

  private applySessionMetadataPatch(session: Session, patch: Partial<PersistedSessionInfo>): void {
    this.assignIfDefined(session, "approvalRationale", patch.approvalRationale);
  }

  private applyWorktreeMetadataPatch(session: Session, patch: Partial<PersistedSessionInfo>): void {
    this.assignIfDefined(session, "worktreePath", patch.worktreePath);
    this.assignIfDefined(session, "worktreeBranch", patch.worktreeBranch);
    this.assignIfDefined(session, "worktreePrUrl", patch.worktreePrUrl);
    this.assignIfDefined(session, "worktreePrNumber", patch.worktreePrNumber);
    this.assignIfDefined(session, "worktreeMerged", patch.worktreeMerged);
    this.assignIfDefined(session, "worktreeMergedAt", patch.worktreeMergedAt);
    this.assignIfDefined(session, "worktreeDisposition", patch.worktreeDisposition);
    this.assignIfDefined(session, "worktreePrTargetRepo", patch.worktreePrTargetRepo);
    this.assignIfDefined(session, "worktreePushRemote", patch.worktreePushRemote);
    this.assignIfDefined(session, "worktreeLifecycle", patch.worktreeLifecycle);
    if ("autoMergeParentSessionId" in patch) {
      session.autoMergeParentSessionId = patch.autoMergeParentSessionId;
    }
    if ("autoMergeConflictResolutionAttemptCount" in patch) {
      session.autoMergeConflictResolutionAttemptCount = patch.autoMergeConflictResolutionAttemptCount;
    }
    if ("autoMergeResolverSessionId" in patch) {
      session.autoMergeResolverSessionId = patch.autoMergeResolverSessionId;
    }
  }

  private assignIfDefined<K extends keyof Session>(session: Session, key: K, value: Session[K] | undefined): void {
    if (value !== undefined) {
      session[key] = value;
    }
  }
}
