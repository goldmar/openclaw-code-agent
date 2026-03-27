// Plugin types

/** Context provided by OpenClaw's tool factory pattern. */
export interface OpenClawPluginToolContext {
  config?: Record<string, unknown>;
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  id?: string | number;
  channel?: string;
  chatId?: string | number;
  senderId?: string | number;
  channelId?: string;
  messageThreadId?: string | number;
  sessionKey?: string;
  messageChannel?: string;
  agentAccountId?: string;
  sandboxed?: boolean;
}

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
  | "merge_in_progress"
  | "pr_in_progress"
  | "merged"
  | "pr_open"
  | "dismissed"
  | "cleanup_failed";
export type SessionRuntimeState = "live" | "stopped";
export type SessionDeliveryState = "idle" | "notifying" | "wake_pending" | "failed";

/** Terminal reason used for lifecycle messaging and auto-resume policy. */
export type KillReason = "user" | "idle-timeout" | "startup-timeout" | "shutdown" | "done" | "unknown";

/** Unified permission modes exposed by tools/commands across harnesses. */
export type PermissionMode = "default" | "plan" | "bypassPermissions";
/**
 * `plan-mode` is the native structured plan gate for harnesses that support it directly.
 * `codex-first-turn-plan` is the Codex-only first-turn planning gate inferred by the
 * bounded semantic adapter before implementation begins.
 */
export type PlanApprovalContext = "plan-mode" | "codex-first-turn-plan";
export type WorktreeStrategy = "off" | "manual" | "ask" | "delegate" | "auto-merge" | "auto-pr";
export type CodexApprovalPolicy = "never" | "on-request";
export type ReasoningEffort = "low" | "medium" | "high";
export type SessionBackendKind = "claude-code" | "codex-app-server";
export type BackendWorktreeCapability = "plugin-managed" | "native";

export interface SessionBackendRef {
  kind: SessionBackendKind;
  conversationId: string;
  runId?: string;
  worktreeId?: string;
  worktreePath?: string;
}

export interface BackendCapabilityFlags {
  nativePendingInput: boolean;
  nativePlanArtifacts: boolean;
  worktrees: BackendWorktreeCapability;
  nativeWorktreeRestore: boolean;
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
      proposedExecpolicyAmendment?: Record<string, unknown>;
      sessionPrefix?: string;
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

export interface PendingInputState {
  requestId: string;
  kind: PendingInputKind;
  promptText?: string;
  options: string[];
  actions?: PendingInputAction[];
  allowsFreeText?: boolean;
  expiresAt?: number;
  responseMode?: "structured" | "compact";
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
  | "worktree-merge"
  | "worktree-create-pr"
  | "worktree-update-pr"
  | "worktree-view-pr"
  | "worktree-decide-later"
  | "worktree-dismiss"
  | "session-resume"
  | "session-restart"
  | "view-output"
  | "question-answer";

export type TurnBoundaryDecision =
  | "complete"
  | "awaiting_user_input"
  | "awaiting_plan_decision";

export interface TurnBoundaryDecisionContext {
  sessionId: string;
  sessionName: string;
  prompt: string;
  workdir: string;
  harnessName: string;
  permissionMode: PermissionMode;
  currentPermissionMode: PermissionMode;
  originAgentId?: string;
  turnText: string;
}

export type TurnBoundaryDecisionCallback = (
  context: TurnBoundaryDecisionContext,
) => Promise<TurnBoundaryDecision>;

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
  optionIndex?: number;
  label?: string;
  targetUrl?: string;
}

/** Harness-scoped launch defaults and model restrictions. */
export interface HarnessConfig {
  defaultModel?: string;
  allowedModels?: string[];
  reasoningEffort?: ReasoningEffort;
  approvalPolicy?: CodexApprovalPolicy;
}

/** Tool-intercept callback type for harnesses that support it. */
export type CanUseToolCallback = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> }>;

/** Session creation options used by SessionManager.spawn(). */
export interface SessionConfig {
  prompt: string;
  workdir: string;
  name?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
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
  planApproval?: PlanApprovalMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  resumeSessionId?: string;
  /** Original requested session ID for worktree inheritance, independent of harness thread resume.
   * Set even when resumeSessionId is cleared (e.g. Codex harness), so the D1 block can still
   * inherit the persisted worktree context. */
  resumeWorktreeFrom?: string;
  forkSession?: boolean;
  multiTurn?: boolean;
  /** Agent harness to use (e.g. "claude-code"). Defaults to the built-in default. */
  harness?: string;
  /** Worktree merge-back strategy. undefined or "off" = no worktree. */
  worktreeStrategy?: WorktreeStrategy;
  /** Base branch for worktree merge/PR operations. */
  worktreeBaseBranch?: string;
  /** Target repository for cross-repo PRs (e.g. 'openai/codex' for fork-to-upstream workflow). */
  worktreePrTargetRepo?: string;
  /** Optional tool-intercept callback (CC sessions only). Used for AskUserQuestion intercept. */
  canUseTool?: CanUseToolCallback;
  /** Optional semantic turn-boundary classifier used to decide whether a turn should wait for input instead of completing. */
  turnBoundaryDecision?: TurnBoundaryDecisionCallback;
  /** Explicit backend ref when reconstructing a persisted session against a native backend conversation. */
  backendRef?: SessionBackendRef;
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
  codexApprovalPolicy: CodexApprovalPolicy;
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
   * Deprecated global allowed-model fallback preserved during migration from the
   * pre-harness config shape. Matching remains case-insensitive substring-based.
   */
  allowedModels?: string[];
}

/** Raw plugin config as accepted from OpenClaw, including deprecated legacy keys. */
export interface RawPluginConfig {
  maxSessions?: number;
  defaultModel?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  defaultWorkdir?: string;
  idleTimeoutMinutes?: number;
  sessionGcAgeMinutes?: number;
  maxPersistedSessions?: number;
  fallbackChannel?: string;
  permissionMode?: PermissionMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  agentChannels?: Record<string, string>;
  maxAutoResponds?: number;
  planApproval?: PlanApprovalMode;
  defaultHarness?: string;
  allowedModels?: string[];
  harnesses?: Record<string, HarnessConfig>;
  /** Default worktree strategy for new sessions. */
  defaultWorktreeStrategy?: WorktreeStrategy;
  /** Override base directory for agent worktrees. Defaults to <repoRoot>/.worktrees when unset. */
  worktreeDir?: string;
}

/** Persisted session metadata retained for resume/list/output after GC/restart. */
export interface PersistedSessionInfo {
  sessionId?: string;
  harnessSessionId: string;
  backendRef?: SessionBackendRef;
  name: string;
  prompt: string;
  workdir: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  createdAt?: number;
  completedAt?: number;
  status: SessionStatus;
  lifecycle?: SessionLifecycle;
  approvalState?: SessionApprovalState;
  worktreeState?: SessionWorktreeState;
  runtimeState?: SessionRuntimeState;
  deliveryState?: SessionDeliveryState;
  killReason?: KillReason;
  costUsd: number;
  originAgentId?: string;
  originChannel?: string;
  originThreadId?: string | number;
  originSessionKey?: string;
  route?: SessionRoute;
  outputPath?: string;
  harness?: string;
  currentPermissionMode?: PermissionMode;
  pendingPlanApproval?: boolean;
  planApprovalContext?: PlanApprovalContext;
  planDecisionVersion?: number;
  planApproval?: PlanApprovalMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  /** Path to the worktree if one was created. */
  worktreePath?: string;
  /** Branch name of the worktree. */
  worktreeBranch?: string;
  /** Worktree strategy used for this session. */
  worktreeStrategy?: WorktreeStrategy;
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
  /** Target repository for cross-repo PRs (e.g. 'openai/codex'). */
  worktreePrTargetRepo?: string;
  /** Remote to push worktree branch to. */
  worktreePushRemote?: string;
  /** ISO timestamp until which stale-decision reminder is snoozed. */
  worktreeDecisionSnoozedUntil?: string;
  /** Current lifecycle disposition of the worktree. */
  worktreeDisposition?: "active" | "pr-opened" | "merged" | "dismissed" | "no-change-cleaned";
  /** ISO timestamp when the worktree was dismissed. */
  worktreeDismissedAt?: string;
  resumable?: boolean;
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
