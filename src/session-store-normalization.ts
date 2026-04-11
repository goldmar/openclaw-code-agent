import { canonicalizeSessionRoute } from "./session-route";
import type {
  ManagedWorktreeLifecycleState,
  PersistedSessionInfo,
  PersistedWorktreeLifecycle,
  SessionApprovalPromptMessageKind,
  SessionApprovalPromptStatus,
  SessionApprovalPromptTransport,
  SessionStatus,
  KillReason,
  ReasoningEffort,
  PermissionMode,
  CodexApprovalPolicy,
  PlanApprovalMode,
  PlanApprovalContext,
  SessionLifecycle,
  SessionApprovalState,
  SessionWorktreeState,
  SessionRuntimeState,
  SessionDeliveryState,
  ApprovalExecutionState,
  SessionActionToken,
  SessionActionKind,
  SessionRoute,
  SessionBackendRef,
} from "./types";

export const STORE_SCHEMA_VERSION = 6;

export interface SessionStoreSchema {
  schemaVersion: number;
  sessions: PersistedSessionInfo[];
  actionTokens: SessionActionToken[];
}

const VALID_PERSISTED_STATUSES = new Set<SessionStatus>(["running", "completed", "failed", "killed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function toNonEmptyString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function toOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toOptionalReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function toOptionalPermissionMode(value: unknown): PermissionMode | undefined {
  return value === "default" || value === "plan" || value === "bypassPermissions"
    ? value
    : undefined;
}

function toOptionalCodexApprovalPolicy(value: unknown): CodexApprovalPolicy | undefined {
  // Legacy persisted rows may still contain "on-request". Normalize them to
  // the only supported App Server execution policy so reload remains safe.
  return value === "never" || value === "on-request"
    ? "never"
    : undefined;
}

function toOptionalPlanApprovalMode(value: unknown): PlanApprovalMode | undefined {
  return value === "approve" || value === "ask" || value === "delegate"
    ? value
    : undefined;
}

function toOptionalPlanApprovalContext(value: unknown): PlanApprovalContext | undefined {
  if (value === "plan-mode" || value === "codex-first-turn-plan" || value === "soft-plan") {
    return "plan-mode";
  }
  return undefined;
}

function toOptionalKillReason(value: unknown): KillReason | undefined {
  return value === "user" || value === "idle-timeout" || value === "startup-timeout" || value === "shutdown" || value === "done" || value === "unknown"
    ? value
    : undefined;
}

function toOptionalLifecycle(value: unknown): SessionLifecycle | undefined {
  return value === "starting"
    || value === "active"
    || value === "awaiting_plan_decision"
    || value === "awaiting_user_input"
    || value === "awaiting_worktree_decision"
    || value === "suspended"
    || value === "terminal"
    ? value
    : undefined;
}

function toOptionalApprovalState(value: unknown): SessionApprovalState | undefined {
  return value === "not_required"
    || value === "pending"
    || value === "approved"
    || value === "changes_requested"
    || value === "rejected"
    ? value
    : undefined;
}

function toOptionalWorktreeState(value: unknown): SessionWorktreeState | undefined {
  return value === "none"
    || value === "provisioned"
    || value === "pending_decision"
    || value === "merge_conflict_resolving"
    || value === "merge_in_progress"
    || value === "pr_in_progress"
    || value === "merged"
    || value === "released"
    || value === "pr_open"
    || value === "dismissed"
    || value === "cleanup_failed"
    ? value
    : undefined;
}

function toOptionalManagedWorktreeLifecycleState(value: unknown): ManagedWorktreeLifecycleState | undefined {
  return value === "none"
    || value === "provisioned"
    || value === "pending_decision"
    || value === "merge_conflict_resolving"
    || value === "pr_open"
    || value === "merged"
    || value === "released"
    || value === "dismissed"
    || value === "no_change"
    || value === "cleanup_failed"
    ? value
    : undefined;
}

function toOptionalRuntimeState(value: unknown): SessionRuntimeState | undefined {
  return value === "live" || value === "stopped" ? value : undefined;
}

function toOptionalApprovalPromptStatus(value: unknown): SessionApprovalPromptStatus | undefined {
  return value === "not_sent"
    || value === "sending"
    || value === "delivered"
    || value === "fallback_delivered"
    || value === "failed"
    ? value
    : undefined;
}

function toOptionalApprovalPromptTransport(value: unknown): SessionApprovalPromptTransport | undefined {
  return value === "none" || value === "direct-telegram" || value === "wake-only"
    ? value
    : undefined;
}

function toOptionalApprovalPromptMessageKind(value: unknown): SessionApprovalPromptMessageKind | undefined {
  return value === "none" || value === "canonical_buttons" || value === "explicit_fallback_text"
    ? value
    : undefined;
}

function toOptionalDeliveryState(value: unknown): SessionDeliveryState | undefined {
  return value === "idle" || value === "notifying" || value === "wake_pending" || value === "failed"
    ? value
    : undefined;
}

function toOptionalApprovalExecutionState(value: unknown): ApprovalExecutionState | undefined {
  return value === "awaiting_plan_output"
    || value === "awaiting_approval"
    || value === "approved_then_implemented"
    || value === "implemented_without_required_approval"
    || value === "not_plan_gated"
    ? value
    : undefined;
}

function toOptionalActionKind(value: unknown): SessionActionKind | undefined {
  return value === "plan-approve"
    || value === "plan-request-changes"
    || value === "plan-reject"
    || value === "monitor-start-plan"
    || value === "monitor-dismiss"
    || value === "worktree-merge"
    || value === "worktree-create-pr"
    || value === "worktree-update-pr"
    || value === "worktree-view-pr"
    || value === "worktree-decide-later"
    || value === "worktree-dismiss"
    || value === "session-resume"
    || value === "session-restart"
    || value === "view-output"
    || value === "question-answer"
    ? value
    : undefined;
}

function normalizeRoute(raw: unknown): SessionRoute | undefined {
  if (!isRecord(raw)) return undefined;
  const provider = toOptionalString(raw.provider);
  const accountId = toOptionalString(raw.accountId);
  const target = toOptionalString(raw.target);
  const threadId = toOptionalString(raw.threadId);
  const sessionKey = toOptionalString(raw.sessionKey);
  if (!provider || !target) return undefined;
  return { provider, accountId, target, threadId, sessionKey };
}

function normalizeBackendRef(
  raw: unknown,
  fallbackHarness: unknown,
  harnessSessionId: string,
): SessionBackendRef | undefined {
  if (isRecord(raw)) {
    const kind = toOptionalString(raw.kind);
    const conversationId = toOptionalString(raw.conversationId);
    if (
      conversationId &&
      (kind === "claude-code" || kind === "codex-app-server")
    ) {
      return {
        kind,
        conversationId,
        runId: toOptionalString(raw.runId),
        worktreeId: toOptionalString(raw.worktreeId),
        worktreePath: toOptionalString(raw.worktreePath),
      };
    }
  }
  if (fallbackHarness === "claude-code") {
    return {
      kind: "claude-code",
      conversationId: harnessSessionId,
    };
  }
  return undefined;
}

function normalizeWorktreeLifecycle(raw: unknown): PersistedWorktreeLifecycle | undefined {
  if (!isRecord(raw)) return undefined;
  const state = toOptionalManagedWorktreeLifecycleState(raw.state);
  const updatedAt = toOptionalString(raw.updatedAt);
  if (!state || !updatedAt) return undefined;
  const resolutionSource = toOptionalString(raw.resolutionSource);
  return {
    state,
    updatedAt,
    resolvedAt: toOptionalString(raw.resolvedAt),
    resolutionSource: resolutionSource === "agent_merge"
      || resolutionSource === "agent_pr"
      || resolutionSource === "strategy_no_change"
      || resolutionSource === "lifecycle_resolver"
      || resolutionSource === "dismiss"
      || resolutionSource === "maintenance"
      ? resolutionSource
      : undefined,
    baseBranch: toOptionalString(raw.baseBranch),
    targetRepo: toOptionalString(raw.targetRepo),
    pushRemote: toOptionalString(raw.pushRemote),
    notes: Array.isArray(raw.notes) ? raw.notes.filter((note): note is string => typeof note === "string" && note.length > 0) : undefined,
  };
}

function synthesizeLegacyWorktreeLifecycle(raw: Record<string, unknown>): PersistedWorktreeLifecycle | undefined {
  const nowIso = new Date(0).toISOString();
  const updatedAt =
    toOptionalString(raw.worktreeMergedAt)
    ?? toOptionalString(raw.worktreeDismissedAt)
    ?? toOptionalString(raw.pendingWorktreeDecisionSince)
    ?? nowIso;

  if (raw.worktreeMerged === true) {
    return {
      state: "merged",
      updatedAt,
      resolvedAt: toOptionalString(raw.worktreeMergedAt) ?? updatedAt,
      resolutionSource: "agent_merge",
      baseBranch: toOptionalString(raw.worktreeBaseBranch),
      targetRepo: toOptionalString(raw.worktreePrTargetRepo),
      pushRemote: toOptionalString(raw.worktreePushRemote),
    };
  }
  if (raw.worktreeDisposition === "dismissed") {
    return {
      state: "dismissed",
      updatedAt,
      resolvedAt: toOptionalString(raw.worktreeDismissedAt) ?? updatedAt,
      resolutionSource: "dismiss",
      baseBranch: toOptionalString(raw.worktreeBaseBranch),
      targetRepo: toOptionalString(raw.worktreePrTargetRepo),
      pushRemote: toOptionalString(raw.worktreePushRemote),
    };
  }
  if (raw.worktreeDisposition === "no-change-cleaned") {
    return {
      state: "no_change",
      updatedAt,
      resolvedAt: updatedAt,
      resolutionSource: "strategy_no_change",
      baseBranch: toOptionalString(raw.worktreeBaseBranch),
      targetRepo: toOptionalString(raw.worktreePrTargetRepo),
      pushRemote: toOptionalString(raw.worktreePushRemote),
    };
  }
  if (raw.worktreeDisposition === "pr-opened" || raw.worktreeState === "pr_open") {
    return {
      state: "pr_open",
      updatedAt,
      baseBranch: toOptionalString(raw.worktreeBaseBranch),
      targetRepo: toOptionalString(raw.worktreePrTargetRepo),
      pushRemote: toOptionalString(raw.worktreePushRemote),
    };
  }
  if (raw.pendingWorktreeDecisionSince || raw.worktreeState === "pending_decision") {
    return {
      state: "pending_decision",
      updatedAt,
      baseBranch: toOptionalString(raw.worktreeBaseBranch),
      targetRepo: toOptionalString(raw.worktreePrTargetRepo),
      pushRemote: toOptionalString(raw.worktreePushRemote),
    };
  }
  if (raw.worktreeState === "merge_conflict_resolving") {
    return {
      state: "merge_conflict_resolving",
      updatedAt,
      baseBranch: toOptionalString(raw.worktreeBaseBranch),
      targetRepo: toOptionalString(raw.worktreePrTargetRepo),
      pushRemote: toOptionalString(raw.worktreePushRemote),
    };
  }
  if (toOptionalString(raw.worktreePath) || toOptionalString(raw.worktreeBranch)) {
    return {
      state: "provisioned",
      updatedAt,
      baseBranch: toOptionalString(raw.worktreeBaseBranch),
      targetRepo: toOptionalString(raw.worktreePrTargetRepo),
      pushRemote: toOptionalString(raw.worktreePushRemote),
    };
  }
  return undefined;
}

function normalizeStatus(value: unknown): SessionStatus | undefined {
  if (typeof value !== "string") return undefined;
  if (!VALID_PERSISTED_STATUSES.has(value as SessionStatus)) return undefined;
  return value === "running" ? "killed" : (value as SessionStatus);
}

export function normalizePersistedEntry(raw: unknown): PersistedSessionInfo | undefined {
  if (!isRecord(raw)) return undefined;

  const harnessSessionId = toNonEmptyString(raw.harnessSessionId);
  if (!harnessSessionId) return undefined;

  const status = normalizeStatus(raw.status);
  if (!status) return undefined;
  const recoveredFromRunning = raw.status === "running";

  const worktreePath = toOptionalString(raw.worktreePath);
  const persistedWorktreeBranch = toOptionalString(raw.worktreeBranch);
  const originChannel = toOptionalString(raw.originChannel);
  const originThreadId = (typeof raw.originThreadId === "string" || typeof raw.originThreadId === "number")
    ? raw.originThreadId
    : undefined;
  const originSessionKey = toOptionalString(raw.originSessionKey);
  const rawRoute = normalizeRoute(raw.route);
  if (!rawRoute) return undefined;
  const route = canonicalizeSessionRoute({
    route: rawRoute,
    originChannel,
    originThreadId,
    originSessionKey,
  });
  if (!route) return undefined;
  if (worktreePath && !persistedWorktreeBranch) return undefined;
  const harness = toOptionalString(raw.harness);
  const backendRef = normalizeBackendRef(raw.backendRef, harness, harnessSessionId);
  const worktreeLifecycle = normalizeWorktreeLifecycle(raw.worktreeLifecycle) ?? synthesizeLegacyWorktreeLifecycle(raw);

  return {
    sessionId: toOptionalString(raw.sessionId),
    harnessSessionId,
    backendRef,
    name: toNonEmptyString(raw.name, harnessSessionId),
    prompt: toNonEmptyString(raw.prompt),
    workdir: toNonEmptyString(raw.workdir, "(unknown)"),
    model: toOptionalString(raw.model),
    reasoningEffort: toOptionalReasoningEffort(raw.reasoningEffort),
    createdAt: toOptionalNumber(raw.createdAt),
    completedAt: toOptionalNumber(raw.completedAt),
    status,
    lifecycle: recoveredFromRunning ? (toOptionalLifecycle(raw.lifecycle) ?? "suspended") : toOptionalLifecycle(raw.lifecycle),
    approvalState: toOptionalApprovalState(raw.approvalState),
    worktreeState: toOptionalWorktreeState(raw.worktreeState),
    runtimeState: recoveredFromRunning ? "stopped" : toOptionalRuntimeState(raw.runtimeState),
    deliveryState: toOptionalDeliveryState(raw.deliveryState),
    completionWakeIssuedAt: toOptionalString(raw.completionWakeIssuedAt),
    completionWakeSucceededAt: toOptionalString(raw.completionWakeSucceededAt),
    completionWakeFailedAt: toOptionalString(raw.completionWakeFailedAt),
    completionWakeSummaryRequired: raw.completionWakeSummaryRequired === true ? true : undefined,
    killReason: toOptionalKillReason(raw.killReason),
    costUsd: typeof raw.costUsd === "number" && Number.isFinite(raw.costUsd) ? raw.costUsd : 0,
    originAgentId: toOptionalString(raw.originAgentId),
    originChannel,
    originThreadId,
    originSessionKey,
    route,
    outputPath: toOptionalString(raw.outputPath),
    harness,
    requestedPermissionMode: toOptionalPermissionMode(raw.requestedPermissionMode),
    currentPermissionMode: toOptionalPermissionMode(raw.currentPermissionMode),
    approvalExecutionState: toOptionalApprovalExecutionState(raw.approvalExecutionState),
    approvalRationale: toOptionalString(raw.approvalRationale),
    planModeApproved: raw.planModeApproved === true,
    pendingPlanApproval: raw.pendingPlanApproval === true,
    planApprovalContext: toOptionalPlanApprovalContext(raw.planApprovalContext),
    planDecisionVersion: toOptionalNumber(raw.planDecisionVersion),
    actionablePlanDecisionVersion: toOptionalNumber(raw.actionablePlanDecisionVersion),
    canonicalPlanPromptVersion: toOptionalNumber(raw.canonicalPlanPromptVersion),
    approvalPromptRequiredVersion: toOptionalNumber(raw.approvalPromptRequiredVersion),
    approvalPromptVersion: toOptionalNumber(raw.approvalPromptVersion),
    approvalPromptStatus: toOptionalApprovalPromptStatus(raw.approvalPromptStatus),
    approvalPromptTransport: toOptionalApprovalPromptTransport(raw.approvalPromptTransport),
    approvalPromptMessageKind: toOptionalApprovalPromptMessageKind(raw.approvalPromptMessageKind),
    approvalPromptLastAttemptAt: toOptionalString(raw.approvalPromptLastAttemptAt),
    approvalPromptDeliveredAt: toOptionalString(raw.approvalPromptDeliveredAt),
    approvalPromptFailedAt: toOptionalString(raw.approvalPromptFailedAt),
    planApproval: toOptionalPlanApprovalMode(raw.planApproval),
    codexApprovalPolicy: toOptionalCodexApprovalPolicy(raw.codexApprovalPolicy),
    worktreePath,
    worktreeBranch: persistedWorktreeBranch,
    worktreeStrategy: (raw.worktreeStrategy === "off" || raw.worktreeStrategy === "manual" || raw.worktreeStrategy === "ask" || raw.worktreeStrategy === "delegate" || raw.worktreeStrategy === "auto-merge" || raw.worktreeStrategy === "auto-pr") ? raw.worktreeStrategy : undefined,
    worktreeMerged: typeof raw.worktreeMerged === "boolean" ? raw.worktreeMerged : undefined,
    worktreeMergedAt: toOptionalString(raw.worktreeMergedAt),
    worktreePrUrl: toOptionalString(raw.worktreePrUrl),
    worktreePrNumber: toOptionalNumber(raw.worktreePrNumber),
    pendingWorktreeDecisionSince: toOptionalString(raw.pendingWorktreeDecisionSince),
    lastWorktreeReminderAt: toOptionalString(raw.lastWorktreeReminderAt),
    worktreeBaseBranch: toOptionalString(raw.worktreeBaseBranch),
    worktreePrTargetRepo: toOptionalString(raw.worktreePrTargetRepo),
    autoMergeParentSessionId: toOptionalString(raw.autoMergeParentSessionId),
    autoMergeConflictResolutionAttemptCount: toOptionalNumber(raw.autoMergeConflictResolutionAttemptCount),
    autoMergeResolverSessionId: toOptionalString(raw.autoMergeResolverSessionId),
    worktreePushRemote: toOptionalString(raw.worktreePushRemote),
    worktreeDecisionSnoozedUntil: toOptionalString(raw.worktreeDecisionSnoozedUntil),
    worktreeDisposition: (raw.worktreeDisposition === "active" || raw.worktreeDisposition === "pr-opened" || raw.worktreeDisposition === "merged" || raw.worktreeDisposition === "dismissed" || raw.worktreeDisposition === "no-change-cleaned") ? raw.worktreeDisposition : undefined,
    worktreeDismissedAt: toOptionalString(raw.worktreeDismissedAt),
    worktreeLifecycle,
    resumable: recoveredFromRunning ? true : raw.resumable === true,
  };
}

export function normalizeActionToken(raw: unknown): SessionActionToken | undefined {
  if (!isRecord(raw)) return undefined;
  const kind = toOptionalActionKind(raw.kind);
  const id = toNonEmptyString(raw.id);
  const sessionId = toNonEmptyString(raw.sessionId);
  const createdAt = toOptionalNumber(raw.createdAt);
  if (!id || !sessionId || !kind || createdAt == null) return undefined;

  return {
    id,
    sessionId,
    kind,
    createdAt,
    planDecisionVersion: toOptionalNumber(raw.planDecisionVersion),
    expiresAt: toOptionalNumber(raw.expiresAt),
    consumedAt: toOptionalNumber(raw.consumedAt),
    optionIndex: toOptionalNumber(raw.optionIndex),
    label: toOptionalString(raw.label),
    targetUrl: toOptionalString(raw.targetUrl),
    route: normalizeRoute(raw.route),
    launchName: toOptionalString(raw.launchName),
    launchPrompt: toOptionalString(raw.launchPrompt),
    launchWorkdir: toOptionalString(raw.launchWorkdir),
  };
}

export function assertNewSchemaEntry(entry: PersistedSessionInfo): void {
  if (!entry.backendRef?.kind || !entry.backendRef.conversationId) {
    throw new Error(`Persisted session ${entry.harnessSessionId} is missing required backend ref metadata.`);
  }
  if (!entry.route?.provider || !entry.route.target) {
    throw new Error(`Persisted session ${entry.harnessSessionId} is missing required route metadata.`);
  }
  if (entry.worktreePath && !entry.worktreeBranch) {
    throw new Error(`Persisted session ${entry.harnessSessionId} is missing required worktreeBranch metadata.`);
  }
}
