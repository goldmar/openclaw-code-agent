import type {
  PersistedSessionInfo,
  PersistedWorktreeLifecycle,
  WorktreeLifecycleResolutionSource,
} from "./types";

export type WorktreeTransitionContext = Pick<
  PersistedSessionInfo,
  "worktreeBaseBranch" | "worktreePrTargetRepo" | "worktreePushRemote"
>;

function buildLifecycle(
  context: WorktreeTransitionContext,
  lifecycle: PersistedWorktreeLifecycle,
): PersistedWorktreeLifecycle {
  return {
    ...lifecycle,
    baseBranch: lifecycle.baseBranch ?? context.worktreeBaseBranch,
    targetRepo: lifecycle.targetRepo ?? context.worktreePrTargetRepo,
    pushRemote: lifecycle.pushRemote ?? context.worktreePushRemote,
  };
}

export function buildPendingDecisionPatch(
  context: WorktreeTransitionContext,
  options: {
    updatedAt?: string;
    pendingSince?: string;
    notes?: string[];
    clearResolverSessionId?: boolean;
  } = {},
): Partial<PersistedSessionInfo> {
  const updatedAt = options.updatedAt ?? new Date().toISOString();
  const patch: Partial<PersistedSessionInfo> = {
    pendingWorktreeDecisionSince: options.pendingSince ?? updatedAt,
    lastWorktreeReminderAt: undefined,
    worktreeDecisionSnoozedUntil: undefined,
    lifecycle: "awaiting_worktree_decision",
    worktreeState: "pending_decision",
    worktreeLifecycle: buildLifecycle(context, {
      state: "pending_decision",
      updatedAt,
      notes: options.notes,
    }),
  };
  if (options.clearResolverSessionId) {
    patch.autoMergeResolverSessionId = undefined;
  }
  return patch;
}

export function buildMergeConflictResolvingPatch(
  context: WorktreeTransitionContext,
  resolverSessionId: string,
  attemptCount: number,
  options: {
    updatedAt?: string;
    notes?: string[];
  } = {},
): Partial<PersistedSessionInfo> {
  const updatedAt = options.updatedAt ?? new Date().toISOString();
  return {
    autoMergeConflictResolutionAttemptCount: attemptCount,
    autoMergeResolverSessionId: resolverSessionId,
    pendingWorktreeDecisionSince: undefined,
    lastWorktreeReminderAt: undefined,
    worktreeDecisionSnoozedUntil: undefined,
    lifecycle: "terminal",
    worktreeState: "merge_conflict_resolving",
    worktreeLifecycle: buildLifecycle(context, {
      state: "merge_conflict_resolving",
      updatedAt,
      notes: options.notes,
    }),
  };
}

export function buildMergedPatch(
  context: WorktreeTransitionContext,
  options: {
    mergedAt?: string;
    updatedAt?: string;
    resolvedAt?: string;
    resolutionSource?: WorktreeLifecycleResolutionSource;
    clearResolverSessionId?: boolean;
  } = {},
): Partial<PersistedSessionInfo> {
  const updatedAt = options.updatedAt ?? new Date().toISOString();
  const resolvedAt = options.resolvedAt ?? updatedAt;
  const patch: Partial<PersistedSessionInfo> = {
    worktreeMerged: true,
    worktreeMergedAt: options.mergedAt ?? resolvedAt,
    lifecycle: "terminal",
    worktreeState: "merged",
    pendingWorktreeDecisionSince: undefined,
    lastWorktreeReminderAt: undefined,
    worktreeDecisionSnoozedUntil: undefined,
    worktreeLifecycle: buildLifecycle(context, {
      state: "merged",
      updatedAt,
      resolvedAt,
      resolutionSource: options.resolutionSource ?? "agent_merge",
    }),
  };
  if (options.clearResolverSessionId) {
    patch.autoMergeResolverSessionId = undefined;
  }
  return patch;
}

export function buildPrOpenPatch(
  context: WorktreeTransitionContext,
  options: {
    prUrl: string;
    prNumber?: number;
    updatedAt?: string;
    targetRepo?: string;
    baseBranch?: string;
    disposition?: "pr-opened";
  },
): Partial<PersistedSessionInfo> {
  const updatedAt = options.updatedAt ?? new Date().toISOString();
  const patch: Partial<PersistedSessionInfo> = {
    worktreePrUrl: options.prUrl,
    lifecycle: "terminal",
    worktreeState: "pr_open",
    pendingWorktreeDecisionSince: undefined,
    lastWorktreeReminderAt: undefined,
    worktreeDecisionSnoozedUntil: undefined,
    worktreeLifecycle: buildLifecycle(context, {
      state: "pr_open",
      updatedAt,
      resolutionSource: "agent_pr",
      baseBranch: options.baseBranch,
      targetRepo: options.targetRepo,
    }),
  };
  if (options.prNumber !== undefined) {
    patch.worktreePrNumber = options.prNumber;
  }
  if (options.disposition !== undefined) {
    patch.worktreeDisposition = options.disposition;
  }
  return patch;
}
