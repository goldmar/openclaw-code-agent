// Plugin types

/** Context provided by OpenClaw's tool factory pattern. */
export interface OpenClawPluginToolContext {
  config?: Record<string, unknown>;
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  sessionKey?: string;
  messageChannel?: string;
  agentAccountId?: string;
  sandboxed?: boolean;
}

export type SessionStatus = "starting" | "running" | "completed" | "failed" | "killed";

export type KillReason = "user" | "idle-timeout" | "startup-timeout" | "done" | "unknown";

export type PermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions";

export interface SessionConfig {
  prompt: string;
  workdir: string;
  name?: string;
  model?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  originChannel?: string;
  originThreadId?: string | number;
  originAgentId?: string;
  /** OpenClaw session key of the originating chat (e.g. "agent:main:telegram:group:...:topic:28"). Used to route wake events back to the correct session. */
  originSessionKey?: string;
  permissionMode?: PermissionMode;
  resumeSessionId?: string;
  forkSession?: boolean;
  multiTurn?: boolean;
  /** Agent harness to use (e.g. "claude-code"). Defaults to the built-in default. */
  harness?: string;
  /** Whether to send wake notifications at every turn end. Defaults to true. */
  notifyOnTurnEnd?: boolean;
}

export type PlanApprovalMode = "approve" | "ask" | "delegate";

export interface PluginConfig {
  maxSessions: number;
  defaultModel?: string;
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
}

export interface PersistedSessionInfo {
  sessionId?: string;
  harnessSessionId: string;
  name: string;
  prompt: string;
  workdir: string;
  model?: string;
  createdAt?: number;
  completedAt?: number;
  status: SessionStatus;
  costUsd: number;
  originAgentId?: string;
  originChannel?: string;
  originThreadId?: string | number;
  originSessionKey?: string;
  outputPath?: string;
  harness?: string;
}

export interface SessionMetrics {
  totalCostUsd: number;
  costPerDay: Map<string, number>;
  sessionsByStatus: { completed: number; failed: number; killed: number };
  totalLaunched: number;
  totalDurationMs: number;
  sessionsWithDuration: number;
  mostExpensive: { id: string; name: string; costUsd: number; prompt: string } | null;
}
