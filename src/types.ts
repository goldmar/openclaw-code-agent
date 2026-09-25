export type { OpenClawPluginToolContext } from "../api";
import type { SessionTaskLifecycleSink } from "./session-task-lifecycle";
import type { HarnessLaunchOptions } from "./harness/types";

// Plugin types

/** Runtime lifecycle state for a session. */
export type SessionStatus = "starting" | "running" | "completed" | "failed" | "killed";
export type SessionLifecycle =
  | "starting"
  | "active"
  | "awaiting_plan_decision"
  | "awaiting_user_input"
  | "awaiting_worktree_decision"
  | "suspended"
  | "terminal";
export type SessionApprovalState =
  | "not_required"
  | "pending"
  | "approved"
  | "changes_requested"
  | "rejected";
export type SessionWorktreeState =
  | "none"
  | "provisioned"
  | "pending_decision"
  | "merge_conflict_resolving"
  | "merge_in_progress"
  | "pr_in_progress"
  | "merged"
  | "released"
  | "pr_open"
  | "dismissed"
  | "cleanup_failed";
export type ManagedWorktreeLifecycleState =
  | "none"
  | "provisioned"
  | "pending_decision"
  | "merge_conflict_resolving"
  | "pr_open"
  | "merged"
  | "released"
  | "dismissed"
  | "no_change"
  | "cleanup_failed";
export type WorktreeLifecycleResolutionSource =
  | "agent_merge"
  | "agent_pr"
  | "strategy_no_change"
  | "lifecycle_resolver"
  | "dismiss"
  | "maintenance";
export type SessionRuntimeState = "live" | "stopped";
export type SessionRuntimeRecoveryReason = "persisted-running-without-runtime";
export type SessionDeliveryState = "idle" | "notifying" | "wake_pending" | "failed";
export type SessionApprovalPromptStatus = "not_sent" | "sending" | "delivered" | "fallback_delivered" | "failed";
export type SessionApprovalPromptTransport = "none" | "direct-message" | "wake-only";
export type SessionApprovalPromptMessageKind = "none" | "canonical_buttons" | "explicit_fallback_text";
export type SessionNotificationDedupeStatus = "in_flight" | "delivered";
export type ApprovalExecutionState =
  | "awaiting_plan_output"
  | "awaiting_approval"
  | "approved_then_implemented"
  | "implemented_without_required_approval"
  | "not_plan_gated";

/** Terminal reason used for lifecycle messaging and auto-resume policy. */
export type KillReason = "user" | "idle-timeout" | "startup-timeout" | "shutdown" | "done" | "unknown";

/** Unified permission modes exposed by tools/commands across harnesses. */
export type PermissionMode = "default" | "plan" | "bypassPermissions";
/** `plan-mode` is the only persisted plan-review context; unknown values are dropped on read. */
export type PlanApprovalContext = "plan-mode";
export const WORKTREE_STRATEGIES = ["off", "manual", "ask", "delegate", "auto-merge", "auto-pr"] as const;
export type WorktreeStrategy = typeof WORKTREE_STRATEGIES[number];
export const WORKTREE_STRATEGY_SET: ReadonlySet<WorktreeStrategy> = new Set(WORKTREE_STRATEGIES);
export const REPO_INTEGRATION_POLICIES = ["pr-required", "pr-allowed", "never-pr", "manual"] as const;
export type RepoIntegrationPolicy = typeof REPO_INTEGRATION_POLICIES[number];
export const REPO_INTEGRATION_POLICY_SET: ReadonlySet<RepoIntegrationPolicy> = new Set(REPO_INTEGRATION_POLICIES);
export type RepoProviderKind = "github" | "unsupported";
/** Built-in Codex permission profiles (`permissionProfile/list`). */
export const CODEX_PERMISSION_PROFILES = [":read-only", ":workspace", ":danger-full-access"] as const;
export type CodexPermissionProfile = typeof CODEX_PERMISSION_PROFILES[number];
/** Codex `AskForApproval` string values OCA exposes. */
export const CODEX_APPROVAL_POLICIES = ["never", "on-request", "untrusted"] as const;
export type CodexApprovalPolicy = typeof CODEX_APPROVAL_POLICIES[number];
/** Codex `ApprovalsReviewer` values OCA exposes. */
export const CODEX_APPROVALS_REVIEWERS = ["user", "auto_review"] as const;
export type CodexApprovalsReviewer = typeof CODEX_APPROVALS_REVIEWERS[number];
export const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];
export const REASONING_EFFORT_SET: ReadonlySet<ReasoningEffort> = new Set(REASONING_EFFORTS);
export type SessionBackendKind = "claude-code" | "codex-app-server" | "opencode-server";

export interface SessionBackendRef {
  kind: SessionBackendKind;
  conversationId: string;
  runId?: string;
}

/** Backend thread maintenance actions exposed through `agent_session_action`. */
export type ThreadAction =
  | { kind: "compact" }
  | {
      kind: "review";
      target:
        | { type: "uncommittedChanges" }
        | { type: "baseBranch"; branch: string }
        | { type: "commit"; sha: string }
        | { type: "custom"; instructions: string };
    };
export type ThreadActionKind = ThreadAction["kind"];

export interface SessionRuntimeRecoveryDiagnostics {
  reason: SessionRuntimeRecoveryReason;
  recoveredAt: string;
  rawStatus?: string;
  rawLifecycle?: string;
  rawRuntimeState?: string;
  rawResumable?: boolean;
  rawCompletedAt?: number;
  rawOutputPath?: string;
  normalizedStatus: SessionStatus;
  normalizedLifecycle?: SessionLifecycle;
  normalizedRuntimeState?: SessionRuntimeState;
}

export interface BackendCapabilityFlags {
  nativePendingInput: boolean;
  nativePlanArtifacts: boolean;
  /** Backend thread actions supported while the session is live. */
  threadActions?: readonly ThreadActionKind[];
  /**
   * The backend carries plan approve/revise decisions natively (Claude
   * ExitPlanMode permission results, OpenCode plan/build agent switching), so
   * OCA forwards the user's words without prompt-level plan-decision framing.
   */
  nativePlanDecisions?: boolean;
}

export type PendingInputDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel";

export type PendingInputAction =
  | {
      kind: "approval";
      label: string;
      decision: PendingInputDecision;
      responseDecision: string;
    }
  | {
      kind: "option";
      label: string;
      value: string;
    }
  | {
      kind: "steer";
      label: string;
    };

export type PendingInputKind = "question" | "approval";

export interface PendingInputOption {
  label: string;
  description?: string;
  value?: string;
  isOther?: boolean;
  recommended?: boolean;
}

export interface PendingInputQuestion {
  id: string;
  header?: string;
  question: string;
  options: PendingInputOption[];
  multiSelect?: boolean;
  allowsFreeText?: boolean;
  isSecret?: boolean;
}

export interface PendingInputState {
  requestId: string;
  kind: PendingInputKind;
  promptText?: string;
  options: string[];
  questions?: PendingInputQuestion[];
  activeQuestionIndex?: number;
  answers?: Record<string, { answers: string[] }>;
  actions?: PendingInputAction[];
  allowsFreeText?: boolean;
  expiresAt?: number;
  responseMode?: "structured" | "compact";
}

export interface PersistedWorktreeLifecycle {
  state: ManagedWorktreeLifecycleState;
  updatedAt: string;
  resolvedAt?: string;
  resolutionSource?: WorktreeLifecycleResolutionSource;
  baseBranch?: string;
  targetRepo?: string;
  pushRemote?: string;
  notes?: string[];
}

export interface WorktreeRepositoryEvidence {
  checkedAt: string;
  repoExists: boolean;
  branchExists: boolean;
  worktreeExists: boolean;
  activeSession: boolean;
  dirtyTracked: boolean;
  topologyMerged: boolean;
  releaseNoopMerge: boolean;
  representedByTargetPrBranch?: boolean;
  branchAheadCount?: number;
  baseAheadCount?: number;
  prState?: "open" | "merged" | "closed" | "none";
  prUrl?: string;
  prNumber?: number;
  reasons: string[];
}

export interface ResolvedWorktreeLifecycle {
  lifecycle: PersistedWorktreeLifecycle;
  evidence: WorktreeRepositoryEvidence;
  derivedState: ManagedWorktreeLifecycleState;
  cleanupSafe: boolean;
  preserve: boolean;
  reasons: string[];
}

export interface PlanArtifactStep {
  step: string;
  status: "pending" | "inProgress" | "completed";
}

export interface PlanArtifact {
  explanation?: string;
  steps: PlanArtifactStep[];
  markdown: string;
}

export type SessionActionKind =
  | "plan-approve"
  | "plan-request-changes"
  | "plan-reject"
  | "plan-offer-start"
  | "plan-offer-dismiss"
  | "repo-policy-set"
  | "worktree-merge"
  | "worktree-create-pr"
  | "worktree-update-pr"
  | "worktree-view-pr"
  | "worktree-decide-later"
  | "worktree-dismiss"
  | "session-resume"
  | "session-restart"
  | "plugin-update-install"
  | "plugin-update-remind-later"
  | "plugin-update-dismiss"
  | "plugin-update-restart"
  | "view-output"
  | "question-answer"
  | "goal-verifiers-confirm"
  | "goal-verifiers-decline";

export interface SessionRoute {
  provider?: string;
  accountId?: string;
  target?: string;
  threadId?: string;
  sessionKey?: string;
}

export interface SessionActionToken {
  id: string;
  sessionId: string;
  kind: SessionActionKind;
  createdAt: number;
  planDecisionVersion?: number;
  expiresAt?: number;
  consumedAt?: number;
  /**
   * Identifies the click that consumed the token. With two writers of the
   * session index, the first consumption persisted wins and only its click acts.
   */
  consumptionId?: string;
  optionIndex?: number;
  pendingInputRequestId?: string;
  pendingInputQuestionId?: string;
  label?: string;
  targetUrl?: string;
  route?: SessionRoute;
  launchName?: string;
  launchPrompt?: string;
  launchWorkdir?: string;
  launchModel?: string;
  launchReasoningEffort?: ReasoningEffort;
  launchFastMode?: boolean;
  launchSystemPrompt?: string;
  launchAllowedTools?: string[];
  launchResumeSessionId?: string;
  launchResumedFromSessionName?: string;
  launchResumeWorktreeFrom?: string;
  launchSessionIdOverride?: string;
  launchRewindTurns?: number;
  launchForkSession?: boolean;
  launchForceNewSession?: boolean;
  launchPermissionMode?: PermissionMode;
  launchPlanApproval?: PlanApprovalMode;
  launchHarness?: string;
  launchWorktreeStrategy?: WorktreeStrategy;
  launchWorktreeBaseBranch?: string;
  launchWorktreePrTargetRepo?: string;
  launchOriginAgentId?: string;
  repoPolicy?: RepoIntegrationPolicy;
  repoPolicyWorkdir?: string;
  pluginUpdateVersion?: string;
}

export interface SessionNotificationDedupeRecord {
  key: string;
  status: SessionNotificationDedupeStatus;
  recordedAt: string;
  label?: string;
}

export type WorktreeRemoteOutcome = "pr-opened" | "pr-updated";

export interface SessionCompletionSummaryRecord {
  key: string;
  linkedKeys?: string[];
  recordedAt: string;
  label?: string;
  skipReason?: string;
}

/** Harness-scoped launch defaults and model restrictions. */
export interface HarnessConfig {
  defaultModel?: string;
  allowedModels?: string[];
  reasoningEffort?: ReasoningEffort;
  fastMode?: boolean;
  /** Codex only: named permission profile sent as `permissions`. */
  permissionProfile?: CodexPermissionProfile;
  /** Codex only: when Codex asks before acting. */
  approvalPolicy?: CodexApprovalPolicy;
  /** Codex only: who reviews Codex approval requests. */
  approvalsReviewer?: CodexApprovalsReviewer;
}

/** Tool-intercept callback type for harnesses that support it. */
export type CanUseToolCallback = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> }>;

/** Session creation options used by SessionManager.launchSession(). */
export interface SessionConfig {
  prompt: string;
  workdir: string;
  /** Reuse an existing OpenClaw session ID when continuing the same logical session. */
  sessionIdOverride?: string;
  name?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  fastMode?: boolean;
  systemPrompt?: string;
  allowedTools?: string[];
  originChannel?: string;
  originThreadId?: string | number;
  originAgentId?: string;
  /** OpenClaw session key of the originating chat (e.g. "agent:main:telegram:group:...:topic:28"). Used to route wake events back to the correct session. */
  originSessionKey?: string;
  /** Explicit delivery route used for notifications and wakes. */
  route?: SessionRoute;
  permissionMode?: PermissionMode;
  requestedPermissionMode?: PermissionMode;
  planApproval?: PlanApprovalMode;
  approvalExecutionState?: ApprovalExecutionState;
  approvalRationale?: string;
  planModeApproved?: boolean;
  approvalState?: SessionApprovalState;
  pendingPlanApproval?: boolean;
  planApprovalContext?: PlanApprovalContext;
  planDecisionVersion?: number;
  actionablePlanDecisionVersion?: number;
  canonicalPlanPromptVersion?: number;
  approvalPromptRequiredVersion?: number;
  approvalPromptVersion?: number;
  approvalPromptStatus?: SessionApprovalPromptStatus;
  approvalPromptTransport?: SessionApprovalPromptTransport;
  approvalPromptMessageKind?: SessionApprovalPromptMessageKind;
  approvalPromptLastAttemptAt?: string;
  approvalPromptDeliveredAt?: string;
  approvalPromptFailedAt?: string;
  resumeSessionId?: string;
  /** Original user-facing session name when a non-fork resume continues an existing session. */
  resumedFromSessionName?: string;
  /** Original requested session ID for worktree inheritance, independent of harness thread resume.
   * Set even when resumeSessionId is cleared (e.g. Codex harness), so the D1 block can still
   * inherit the persisted worktree context. */
  resumeWorktreeFrom?: string;
  forkSession?: boolean;
  /**
   * Usage the fork inherits from its parent conversation, so the fork reports
   * only its own spend. Set by SessionManager for forks; harnesses that count
   * inherited usage (Claude Code) subtract it.
   */
  forkBaselineUsage?: HarnessLaunchOptions["forkBaselineUsage"];
  /** Codex only: drop the latest N turns of the resumed/forked thread before continuing. */
  rewindTurns?: number;
  multiTurn?: boolean;
  /** Optional goal-task owner for explicit iterative loop orchestration. */
  goalTaskId?: string;
  /** Agent harness to use (e.g. "claude-code"). Defaults to the built-in default. */
  harness?: string;
  /** Worktree merge-back strategy. undefined or "off" = no worktree. */
  worktreeStrategy?: WorktreeStrategy;
  /** Repo-scoped integration policy resolved at launch time. */
  repoIntegrationPolicy?: RepoIntegrationPolicy;
  repoIntegrationPolicySource?: "stored" | "seeded" | "unknown";
  repoProvider?: RepoProviderKind;
  /** Base branch for worktree merge/PR operations. */
  worktreeBaseBranch?: string;
  /** Branch checked out in the parent repository when this worktree was created. */
  worktreeParentBranch?: string;
  /** Target repository for cross-repo PRs (e.g. 'openai/codex' for fork-to-upstream workflow). */
  worktreePrTargetRepo?: string;
  /** Internal link back to the original auto-merge session for conflict resolver sessions. */
  autoMergeParentSessionId?: string;
  /** Number of automatic conflict-resolution attempts already used for this session. */
  autoMergeConflictResolutionAttemptCount?: number;
  /** Active conflict-resolver child session for this auto-merge worktree, if any. */
  autoMergeResolverSessionId?: string;
  /** Optional tool-intercept callback (CC sessions only). Used for AskUserQuestion intercept. */
  canUseTool?: CanUseToolCallback;
  /** Explicit backend ref when reconstructing a persisted session against a native backend conversation. */
  backendRef?: SessionBackendRef;
  /** Mirrors the session into a host-managed Task Flow (`runtime.tasks.async.managedFlows`). */
  taskLifecycle?: SessionTaskLifecycleSink;
}

/** Plan-approval policy for orchestrator wake flows. */
export type PlanApprovalMode = "approve" | "ask" | "delegate";

/** Plugin-level configuration loaded from openclaw config schema. */
export interface PluginConfig {
  maxSessions: number;
  defaultWorkdir?: string;
  idleTimeoutMinutes: number;
  sessionGcAgeMinutes?: number;
  maxPersistedSessions: number;
  fallbackChannel?: string;
  permissionMode?: PermissionMode;
  agentChannels?: Record<string, string>;
  maxAutoResponds: number;
  planApproval: PlanApprovalMode;
  defaultHarness?: string;
  harnesses: Record<string, HarnessConfig>;
  /** Default worktree strategy for new sessions when agent_launch omits worktree_strategy. */
  defaultWorktreeStrategy?: WorktreeStrategy;
  /** Override base directory for agent worktrees. Defaults to <repoRoot>/.worktrees when unset. */
  worktreeDir?: string;
  /**
   * Daily update check with button-confirmed install and Gateway restart
   * (default true). `false` disables update checks, installs, and restarts.
   */
  autoUpdate: boolean;
  /**
   * Repository git hooks during OCA's own merge, rebase, commit, push and
   * worktree git operations: "run" (default) or "skip" (`core.hooksPath=/dev/null`).
   */
  worktreeGitHooks: WorktreeGitHooksMode;
  /**
   * Goal verifier commands pre-approved by the operator. A goal launched by the
   * orchestrator with only these commands needs no user confirmation.
   */
  trustedVerifierCommands?: string[];
}

export type WorktreeGitHooksMode = "run" | "skip";

/** Raw plugin config as accepted from OpenClaw (validated against `openclaw.plugin.json` configSchema). */
export interface RawPluginConfig {
  maxSessions?: number;
  defaultWorkdir?: string;
  idleTimeoutMinutes?: number;
  sessionGcAgeMinutes?: number;
  maxPersistedSessions?: number;
  fallbackChannel?: string;
  permissionMode?: PermissionMode;
  agentChannels?: Record<string, string>;
  maxAutoResponds?: number;
  planApproval?: PlanApprovalMode;
  defaultHarness?: string;
  harnesses?: Record<string, HarnessConfig>;
  /** Default worktree strategy for new sessions. */
  defaultWorktreeStrategy?: WorktreeStrategy;
  /** Override base directory for agent worktrees. Defaults to <repoRoot>/.worktrees when unset. */
  worktreeDir?: string;
  /** Update check with button-confirmed install/restart; default true. */
  autoUpdate?: boolean;
  /** Repository git hooks during OCA git operations; default "run". */
  worktreeGitHooks?: WorktreeGitHooksMode;
  /** Operator-approved goal verifier commands (exact strings). */
  trustedVerifierCommands?: string[];
}

/** Persisted session metadata retained for resume/list/output after GC/restart. */
export interface PersistedSessionInfo {
  sessionId?: string;
  /**
   * `<pid>/<runtime instance>` of the runtime that runs this session; written
   * on `running` rows only. Another writer never adopts or overwrites a running
   * row whose owner process is still alive.
   */
  runtimeOwner?: string;
  harnessSessionId: string;
  backendRef?: SessionBackendRef;
  name: string;
  prompt: string;
  workdir: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  fastMode?: boolean;
  createdAt?: number;
  completedAt?: number;
  status: SessionStatus;
  lifecycle?: SessionLifecycle;
  approvalState?: SessionApprovalState;
  worktreeState?: SessionWorktreeState;
  runtimeState?: SessionRuntimeState;
  runtimeRecovery?: SessionRuntimeRecoveryDiagnostics;
  taskFlowMirror?: PersistedTaskFlowMirror;
  deliveryState?: SessionDeliveryState;
  notificationDedupe?: SessionNotificationDedupeRecord[];
  completionSummaryDedupe?: SessionCompletionSummaryRecord[];
  completionWakeIssuedAt?: string;
  /** The required human-visible completion follow-up was confirmed delivered. */
  completionWakeSucceededAt?: string;
  completionWakeFailedAt?: string;
  completionWakeSkippedAt?: string;
  completionWakeSkipReason?: string;
  completionWakeSummaryRequired?: boolean;
  killReason?: KillReason;
  costUsd: number;
  originAgentId?: string;
  originChannel?: string;
  originThreadId?: string | number;
  originSessionKey?: string;
  route?: SessionRoute;
  outputPath?: string;
  harness?: string;
  /** Original user-facing session name when this record represents a relabeled non-fork resume. */
  resumedFromSessionName?: string;
  /** Optional goal-task owner for explicit iterative loop orchestration. */
  goalTaskId?: string;
  requestedPermissionMode?: PermissionMode;
  currentPermissionMode?: PermissionMode;
  approvalExecutionState?: ApprovalExecutionState;
  approvalRationale?: string;
  planModeApproved?: boolean;
  pendingPlanApproval?: boolean;
  planApprovalContext?: PlanApprovalContext;
  planDecisionVersion?: number;
  actionablePlanDecisionVersion?: number;
  canonicalPlanPromptVersion?: number;
  approvalPromptRequiredVersion?: number;
  approvalPromptVersion?: number;
  approvalPromptStatus?: SessionApprovalPromptStatus;
  approvalPromptTransport?: SessionApprovalPromptTransport;
  approvalPromptMessageKind?: SessionApprovalPromptMessageKind;
  approvalPromptLastAttemptAt?: string;
  approvalPromptDeliveredAt?: string;
  approvalPromptFailedAt?: string;
  planApproval?: PlanApprovalMode;
  /** Path to the worktree if one was created. */
  worktreePath?: string;
  /** Branch name of the worktree. */
  worktreeBranch?: string;
  /** Worktree strategy used for this session. */
  worktreeStrategy?: WorktreeStrategy;
  /** Repo-scoped integration policy snapshot used for this session. */
  repoIntegrationPolicy?: RepoIntegrationPolicy;
  repoIntegrationPolicySource?: "stored" | "seeded" | "unknown";
  repoProvider?: RepoProviderKind;
  /** Whether the worktree was merged back to the base branch. */
  worktreeMerged?: boolean;
  /** Timestamp when the worktree was merged. */
  worktreeMergedAt?: string;
  /** PR URL if a PR was created for this worktree. */
  worktreePrUrl?: string;
  /** PR number for commenting and state checks. */
  worktreePrNumber?: number;
  /** ISO timestamp set when "ask" or "delegate" fires and decision is pending. Cleared on merge or PR. */
  pendingWorktreeDecisionSince?: string;
  /** ISO timestamp of last stale-branch reminder sent. */
  lastWorktreeReminderAt?: string;
  /** Base branch used for worktree merge/PR operations. */
  worktreeBaseBranch?: string;
  /** Branch checked out in the parent repository when this worktree was created. */
  worktreeParentBranch?: string;
  /** Target repository for cross-repo PRs (e.g. 'openai/codex'). */
  worktreePrTargetRepo?: string;
  /** Internal link back to the original auto-merge session for conflict resolver sessions. */
  autoMergeParentSessionId?: string;
  /** Number of automatic conflict-resolution attempts already used for this session. */
  autoMergeConflictResolutionAttemptCount?: number;
  /** Active conflict-resolver child session for this auto-merge worktree, if any. */
  autoMergeResolverSessionId?: string;
  /** Remote to push worktree branch to. */
  worktreePushRemote?: string;
  /** ISO timestamp until which stale-decision reminder is snoozed. */
  worktreeDecisionSnoozedUntil?: string;
  /** Current lifecycle disposition of the worktree. */
  worktreeDisposition?: "active" | "pr-opened" | "merged" | "dismissed" | "no-change-cleaned";
  /** Last PR/remote branch outcome completed for this worktree session, if any. */
  worktreeRemoteOutcome?: WorktreeRemoteOutcome;
  /** ISO timestamp when the worktree was dismissed. */
  worktreeDismissedAt?: string;
  worktreeLifecycle?: PersistedWorktreeLifecycle;
  resumable?: boolean;
}

export interface PersistedTaskFlowMirror {
  flowId: string;
  revision: number;
  status?: "queued" | "running" | "waiting" | "blocked" | "succeeded" | "failed" | "cancelled" | "lost";
  /** Host-recorded cancel intent (`openclaw tasks flow cancel` or an OCA user stop). */
  cancelRequestedAt?: number;
}

export interface RepoPolicyRecord {
  key: string;
  policy: RepoIntegrationPolicy;
  repoRoot: string;
  remoteUrl?: string;
  provider: RepoProviderKind;
  createdAt: string;
  updatedAt: string;
  source: "stored" | "seeded";
}

/** In-memory usage metrics shown by `agent_stats`. */
export interface SessionMetrics {
  totalCostUsd: number;
  costPerDay: Map<string, number>;
  sessionsByStatus: { completed: number; failed: number; killed: number };
  totalLaunched: number;
  totalDurationMs: number;
  sessionsWithDuration: number;
  mostExpensive: { id: string; name: string; costUsd: number; prompt: string } | null;
}

export type GoalTaskStatus =
  /** Created by the orchestrator; waits for the user to confirm its verifier commands. */
  | "awaiting_verifier_confirmation"
  | "running"
  | "waiting_for_session"
  /** The first iteration's plan waits for the normal plan decision. */
  | "waiting_for_plan_approval"
  | "waiting_for_user"
  | "succeeded"
  | "failed"
  | "stopped";

export type GoalLoopMode = "verifier" | "ralph";

export interface GoalVerifierSpec {
  label: string;
  command: string;
  timeoutMs?: number;
}

export interface GoalTaskConfig {
  goal: string;
  workdir: string;
  name?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  fastMode?: boolean;
  systemPrompt?: string;
  allowedTools?: string[];
  originChannel?: string;
  originThreadId?: string | number;
  originAgentId?: string;
  originSessionKey?: string;
  route?: SessionRoute;
  harness?: string;
  maxIterations?: number;
  permissionMode?: PermissionMode;
  loopMode?: GoalLoopMode;
  completionPromise?: string;
  verifierCommands: GoalVerifierSpec[];
  /** Optional spend limit: no further iteration starts once the task's sessions cost this much. */
  maxCostUsd?: number;
  /**
   * True when the verifier commands came from the orchestrator (not from the
   * user or the operator's config): the task then waits for one user
   * confirmation that lists the exact commands before anything runs.
   */
  requireVerifierConfirmation?: boolean;
}

export interface GoalVerifierStepResult {
  label: string;
  command: string;
  ok: boolean;
  exitCode: number;
  durationMs: number;
  output: string;
}

export interface GoalVerifierRunResult {
  status: "pass" | "fail";
  steps: GoalVerifierStepResult[];
  summary: string;
  fingerprint: string;
}

export interface GoalTaskState {
  id: string;
  name: string;
  goal: string;
  workdir: string;
  status: GoalTaskStatus;
  createdAt: number;
  updatedAt: number;
  iteration: number;
  maxIterations: number;
  sessionId?: string;
  sessionName?: string;
  harnessSessionId?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  fastMode?: boolean;
  systemPrompt?: string;
  allowedTools?: string[];
  originChannel?: string;
  originThreadId?: string | number;
  originAgentId?: string;
  originSessionKey?: string;
  route?: SessionRoute;
  harness?: string;
  permissionMode?: PermissionMode;
  loopMode: GoalLoopMode;
  completionPromise?: string;
  verifierCommands: GoalVerifierSpec[];
  lastVerifierSummary?: string;
  lastVerifierFingerprint?: string;
  repeatedFailureCount: number;
  waitingForUserReason?: string;
  failureReason?: string;
  /** Set once the first iteration's plan was approved; later iterations continue within that scope. */
  planApproved?: boolean;
  maxCostUsd?: number;
  /** Cost of the task's finished session runs so far. */
  totalCostUsd?: number;
  /** `<session id>:<start time>` of the last run whose cost was added to `totalCostUsd`. */
  lastCostedRun?: string;
}
