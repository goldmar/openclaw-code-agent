import type { Session } from "./session";
import type { SessionControlPatch } from "./session-state";
import { getBackendConversationId, getPrimarySessionLookupRef } from "./session-backend-ref";
import type { PersistedSessionInfo } from "./types";

type PersistedStore = Pick<
  import("./session-store").SessionStore,
  "getPersistedSession" | "assertPersistedEntry" | "saveIndex"
>;

type ControlFieldSetter = {
  setControlField?: <K extends keyof SessionControlPatch>(key: K, value: SessionControlPatch[K]) => void;
};

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
    const normalizedPatch = this.normalizeCompletionWakePatch(patch);
    const existing = this.deps.store.getPersistedSession(ref);
    if (existing) {
      Object.assign(existing, normalizedPatch);
      this.deps.store.assertPersistedEntry(existing);
    }

    const active = this.findActiveSessionForRef(ref, existing);
    if (active) {
      this.applyPatchToActiveSession(active, normalizedPatch);
    }

    if (!existing && !active) return false;
    if (existing) this.deps.store.saveIndex();
    return true;
  }

  private normalizeCompletionWakePatch(
    patch: Partial<PersistedSessionInfo>,
  ): Partial<PersistedSessionInfo> {
    const completed =
      ("completionWakeSucceededAt" in patch && patch.completionWakeSucceededAt)
      || ("completionWakeSkippedAt" in patch && patch.completionWakeSkippedAt);
    if (!completed) {
      return patch;
    }
    return {
      ...patch,
      completionWakeSummaryRequired: undefined,
    };
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
    const controlPatch: SessionControlPatch = {};
    this.copyControlPatchField(controlPatch, patch, "lifecycle");
    this.copyControlPatchField(controlPatch, patch, "approvalState");
    this.copyControlPatchField(controlPatch, patch, "approvalExecutionState");
    this.copyControlPatchField(controlPatch, patch, "worktreeState");
    this.copyControlPatchField(controlPatch, patch, "runtimeState");
    this.copyControlPatchField(controlPatch, patch, "deliveryState");
    this.copyControlPatchField(controlPatch, patch, "requestedPermissionMode");
    this.copyControlPatchField(controlPatch, patch, "currentPermissionMode");
    this.copyControlPatchField(controlPatch, patch, "pendingPlanApproval");
    this.copyControlPatchField(controlPatch, patch, "planApprovalContext");
    this.copyControlPatchField(controlPatch, patch, "planDecisionVersion");
    this.copyControlPatchField(controlPatch, patch, "actionablePlanDecisionVersion");
    this.copyControlPatchField(controlPatch, patch, "canonicalPlanPromptVersion");
    this.copyControlPatchField(controlPatch, patch, "approvalPromptRequiredVersion");
    this.copyControlPatchField(controlPatch, patch, "approvalPromptVersion");
    this.copyControlPatchField(controlPatch, patch, "approvalPromptStatus");
    this.copyControlPatchField(controlPatch, patch, "approvalPromptTransport");
    this.copyControlPatchField(controlPatch, patch, "approvalPromptMessageKind");
    this.copyControlPatchField(controlPatch, patch, "approvalPromptLastAttemptAt");
    this.copyControlPatchField(controlPatch, patch, "approvalPromptDeliveredAt");
    this.copyControlPatchField(controlPatch, patch, "approvalPromptFailedAt");
    this.copyControlPatchField(controlPatch, patch, "planModeApproved");
    this.copyControlPatchField(controlPatch, patch, "pendingWorktreeDecisionSince");

    if (typeof (session as Session & { applyControlPatch?: unknown }).applyControlPatch === "function") {
      session.applyControlPatch(controlPatch);
      return;
    }

    this.assignIfPresent(session, "lifecycle", patch, "lifecycle");
    this.assignIfPresent(session, "approvalState", patch, "approvalState");
    this.assignIfPresent(session, "approvalExecutionState", patch, "approvalExecutionState");
    this.assignIfPresent(session, "worktreeState", patch, "worktreeState");
    this.assignIfPresent(session, "runtimeState", patch, "runtimeState");
    this.assignIfPresent(session, "deliveryState", patch, "deliveryState");
    this.assignIfPresent(session, "requestedPermissionMode", patch, "requestedPermissionMode");
    this.assignIfPresent(session, "currentPermissionMode", patch, "currentPermissionMode");
    this.assignIfPresent(session, "pendingPlanApproval", patch, "pendingPlanApproval");
    this.assignIfPresent(session, "planApprovalContext", patch, "planApprovalContext");
    this.assignIfPresent(session, "planDecisionVersion", patch, "planDecisionVersion");
    this.assignIfPresent(session, "actionablePlanDecisionVersion", patch, "actionablePlanDecisionVersion");
    this.assignIfPresent(session, "canonicalPlanPromptVersion", patch, "canonicalPlanPromptVersion");
    this.assignIfPresent(session, "approvalPromptRequiredVersion", patch, "approvalPromptRequiredVersion");
    this.assignIfPresent(session, "approvalPromptVersion", patch, "approvalPromptVersion");
    this.assignIfPresent(session, "approvalPromptStatus", patch, "approvalPromptStatus");
    this.assignIfPresent(session, "approvalPromptTransport", patch, "approvalPromptTransport");
    this.assignIfPresent(session, "approvalPromptMessageKind", patch, "approvalPromptMessageKind");
    this.assignIfPresent(session, "approvalPromptLastAttemptAt", patch, "approvalPromptLastAttemptAt");
    this.assignIfPresent(session, "approvalPromptDeliveredAt", patch, "approvalPromptDeliveredAt");
    this.assignIfPresent(session, "approvalPromptFailedAt", patch, "approvalPromptFailedAt");
    this.setControlFieldIfPresent(session, "planModeApproved", patch);
  }

  private applySessionMetadataPatch(session: Session, patch: Partial<PersistedSessionInfo>): void {
    this.assignIfDefined(session, "approvalRationale", patch.approvalRationale);
    this.assignIfDefined(session, "taskFlowMirror", patch.taskFlowMirror);
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

  private assignIfPresent<K extends keyof Session, P extends keyof PersistedSessionInfo>(
    session: Session,
    sessionKey: K,
    patch: Partial<PersistedSessionInfo>,
    patchKey: P,
  ): void {
    if (Object.hasOwn(patch, patchKey)) {
      session[sessionKey] = patch[patchKey] as unknown as Session[K];
    }
  }

  private copyControlPatchField<K extends keyof SessionControlPatch & keyof PersistedSessionInfo>(
    controlPatch: SessionControlPatch,
    patch: Partial<PersistedSessionInfo>,
    key: K,
  ): void {
    if (Object.hasOwn(patch, key)) {
      controlPatch[key] = patch[key] as SessionControlPatch[K];
    }
  }

  private setControlFieldIfPresent<K extends keyof SessionControlPatch>(
    session: Session,
    key: K,
    patch: Partial<PersistedSessionInfo>,
  ): void {
    if (Object.hasOwn(patch, key)) {
      (session as Session & ControlFieldSetter).setControlField?.(key, patch[key] as SessionControlPatch[K]);
    }
  }
}
