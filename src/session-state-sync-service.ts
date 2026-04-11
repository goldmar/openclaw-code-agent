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
    if (typeof (session as Session & { applyControlPatch?: unknown }).applyControlPatch === "function") {
      session.applyControlPatch({
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
      });
    } else {
      if (patch.lifecycle !== undefined) session.lifecycle = patch.lifecycle;
      if (patch.approvalState !== undefined) session.approvalState = patch.approvalState;
      if (patch.worktreeState !== undefined) session.worktreeState = patch.worktreeState;
      if (patch.runtimeState !== undefined) session.runtimeState = patch.runtimeState;
      if (patch.deliveryState !== undefined) session.deliveryState = patch.deliveryState;
      if (patch.pendingPlanApproval !== undefined) session.pendingPlanApproval = patch.pendingPlanApproval;
      if (patch.planApprovalContext !== undefined) session.planApprovalContext = patch.planApprovalContext;
      if (patch.planDecisionVersion !== undefined) session.planDecisionVersion = patch.planDecisionVersion;
      if (patch.actionablePlanDecisionVersion !== undefined) session.actionablePlanDecisionVersion = patch.actionablePlanDecisionVersion;
      if (patch.canonicalPlanPromptVersion !== undefined) session.canonicalPlanPromptVersion = patch.canonicalPlanPromptVersion;
      if (patch.approvalPromptRequiredVersion !== undefined) session.approvalPromptRequiredVersion = patch.approvalPromptRequiredVersion;
      if (patch.approvalPromptVersion !== undefined) session.approvalPromptVersion = patch.approvalPromptVersion;
      if (patch.approvalPromptStatus !== undefined) session.approvalPromptStatus = patch.approvalPromptStatus;
      if (patch.approvalPromptTransport !== undefined) session.approvalPromptTransport = patch.approvalPromptTransport;
      if (patch.approvalPromptMessageKind !== undefined) session.approvalPromptMessageKind = patch.approvalPromptMessageKind;
      if (patch.approvalPromptLastAttemptAt !== undefined) session.approvalPromptLastAttemptAt = patch.approvalPromptLastAttemptAt;
      if (patch.approvalPromptDeliveredAt !== undefined) session.approvalPromptDeliveredAt = patch.approvalPromptDeliveredAt;
      if (patch.approvalPromptFailedAt !== undefined) session.approvalPromptFailedAt = patch.approvalPromptFailedAt;
    }
    if (patch.approvalRationale !== undefined) session.approvalRationale = patch.approvalRationale;
    if (patch.worktreePath !== undefined) session.worktreePath = patch.worktreePath;
    if (patch.worktreeBranch !== undefined) session.worktreeBranch = patch.worktreeBranch;
    if (patch.worktreePrUrl !== undefined) session.worktreePrUrl = patch.worktreePrUrl;
    if (patch.worktreePrNumber !== undefined) session.worktreePrNumber = patch.worktreePrNumber;
    if (patch.worktreeMerged !== undefined) session.worktreeMerged = patch.worktreeMerged;
    if (patch.worktreeMergedAt !== undefined) session.worktreeMergedAt = patch.worktreeMergedAt;
    if (patch.worktreeDisposition !== undefined) session.worktreeDisposition = patch.worktreeDisposition;
    if (patch.worktreePrTargetRepo !== undefined) session.worktreePrTargetRepo = patch.worktreePrTargetRepo;
    if ("autoMergeParentSessionId" in patch) session.autoMergeParentSessionId = patch.autoMergeParentSessionId;
    if ("autoMergeConflictResolutionAttemptCount" in patch) {
      session.autoMergeConflictResolutionAttemptCount = patch.autoMergeConflictResolutionAttemptCount;
    }
    if ("autoMergeResolverSessionId" in patch) session.autoMergeResolverSessionId = patch.autoMergeResolverSessionId;
    if (patch.worktreePushRemote !== undefined) session.worktreePushRemote = patch.worktreePushRemote;
    if (patch.worktreeLifecycle !== undefined) session.worktreeLifecycle = patch.worktreeLifecycle;
  }
}
