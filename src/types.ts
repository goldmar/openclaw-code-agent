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

/** Terminal reason used for lifecycle messaging and auto-resume policy. */
export type KillReason = "user" | "idle-timeout" | "startup-timeout" | "shutdown" | "done" | "unknown";

/** Unified permission modes exposed by tools/commands across harnesses. */
export type PermissionMode = "default" | "plan" | "bypassPermissions";
export type WorktreeStrategy = "off" | "manual" | "ask" | "delegate" | "auto-merge" | "auto-pr";
export type CodexApprovalPolicy = "never" | "on-request";
export type ReasoningEffort = "low" | "medium" | "high";

/** Harness-scoped launch defaults and model restrictions. */
export interface HarnessConfig {
  defaultModel?: string;
  allowedModels?: string[];
  reasoningEffort?: ReasoningEffort;
  approvalPolicy?: CodexApprovalPolicy;
}

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
  permissionMode?: PermissionMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  resumeSessionId?: string;
  forkSession?: boolean;
  multiTurn?: boolean;
  /** Agent harness to use (e.g. "claude-code"). Defaults to the built-in default. */
  harness?: string;
  /** Worktree merge-back strategy. undefined or "off" = no worktree. */
  worktreeStrategy?: WorktreeStrategy;
  /** Base branch for worktree merge/PR operations. */
  worktreeBaseBranch?: string;
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
}

/** Persisted session metadata retained for resume/list/output after GC/restart. */
export interface PersistedSessionInfo {
  sessionId?: string;
  harnessSessionId: string;
  name: string;
  prompt: string;
  workdir: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  createdAt?: number;
  completedAt?: number;
  status: SessionStatus;
  killReason?: KillReason;
  costUsd: number;
  originAgentId?: string;
  originChannel?: string;
  originThreadId?: string | number;
  originSessionKey?: string;
  outputPath?: string;
  harness?: string;
  currentPermissionMode?: PermissionMode;
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
  /** ISO timestamp set when "ask" or "delegate" fires and decision is pending. Cleared on merge/PR/dismiss. */
  pendingWorktreeDecisionSince?: string;
  /** ISO timestamp of last stale-branch reminder sent. */
  lastWorktreeReminderAt?: string;
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
