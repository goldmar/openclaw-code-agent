/**
 * Agent harness abstraction layer.
 *
 * Defines the contract that each coding-agent backend (Claude Code, Codex, etc.)
 * must implement so the rest of the plugin stays harness-agnostic.
 */

import type {
  BackendCapabilityFlags,
  CodexApprovalPolicy,
  PendingInputState,
  PlanArtifact,
  ReasoningEffort,
  SessionBackendRef,
  SessionBackendKind,
  WorktreeStrategy,
} from "../types";

// ---------------------------------------------------------------------------
// Harness message types (normalised from each SDK's wire format)
// ---------------------------------------------------------------------------

/** Per-model token and cost totals reported by a backend. */
export interface HarnessModelUsage {
  model: string;
  /** Canonical pricing id when the backend reports one (e.g. Claude `canonicalModel`). */
  canonicalModel?: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Which price table the backend used; `unknown` means the cost is a guess. */
  costBasis?: "list" | "managed" | "unknown";
}

/** Usage snapshot reported by a backend. Fields are replaced, not summed. */
export interface HarnessUsage {
  models?: HarnessModelUsage[];
  contextTokens?: number;
  contextWindow?: number;
  /** Live, non-ambient background tasks the backend is still running. */
  backgroundTasks?: number;
}

export interface HarnessResult {
  success: boolean;
  outcome?: "completed" | "failed" | "interrupted";
  /**
   * True when the backend classified success/failure itself (structured error
   * codes). Session then skips the text-pattern startup-failure fallback that
   * exists for backends without structured failure reporting.
   */
  outcomeAuthoritative?: boolean;
  /** Structured backend failure code (e.g. Claude `authentication_failed`). */
  errorCode?: string;
  duration_ms: number;
  total_cost_usd: number;
  num_turns: number;
  result?: string;
  session_id: string;
  usage?: HarnessUsage;
}

/** A plan-approval request raised natively by the backend (Claude ExitPlanMode). */
export interface HarnessPlanApprovalRequest {
  requestId: string;
  artifact: PlanArtifact;
  planFilePath?: string;
}

/** Resolution of a native plan-approval request. */
export type HarnessPlanDecision =
  | { kind: "approve"; permissionMode: string }
  | { kind: "revise"; feedback: string };

/** Backend-reported model/effort facts (what actually runs, not what was requested). */
export interface HarnessBackendInfo {
  model?: string;
  /** Effort the backend applies; null when it sends none. */
  reasoningEffort?: ReasoningEffort | null;
  /** Whether the requested effort is supported by the resolved model. */
  reasoningEffortSupported?: boolean;
}

export type HarnessMessage =
  | { type: "backend_ref"; ref: SessionBackendRef }
  | { type: "run_started"; runId?: string }
  | { type: "activity" }
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "pending_input"; state: PendingInputState }
  | { type: "pending_input_resolved"; requestId?: string }
  | { type: "plan_artifact"; artifact: PlanArtifact; finalized: boolean }
  | { type: "plan_approval_requested"; request: HarnessPlanApprovalRequest }
  | { type: "backend_info"; info: HarnessBackendInfo }
  | { type: "usage_updated"; usage: HarnessUsage }
  | { type: "settings_changed"; permissionMode?: string }
  | { type: "run_completed"; data: HarnessResult };

// ---------------------------------------------------------------------------
// Launch options
// ---------------------------------------------------------------------------

export type CanUseToolCallback = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> }>;

export interface HarnessLaunchOptions {
  prompt: string | AsyncIterable<unknown>;
  cwd: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  fastMode?: boolean;
  permissionMode?: string;
  codexApprovalPolicy?: CodexApprovalPolicy;
  systemPrompt?: string;
  allowedTools?: string[];
  resumeSessionId?: string;
  forkSession?: boolean;
  backendRef?: SessionBackendRef;
  worktreeStrategy?: WorktreeStrategy;
  originalWorkdir?: string;
  abortController?: AbortController;
  /** Optional tool-intercept callback (CC sessions only). */
  canUseTool?: CanUseToolCallback;
}

// ---------------------------------------------------------------------------
// Session handle returned by launch()
// ---------------------------------------------------------------------------

export interface HarnessSession {
  /** Async iterable of harness-agnostic messages. */
  messages: AsyncIterable<HarnessMessage>;

  /** Change the permission / autonomy mode mid-session. */
  setPermissionMode?(mode: string): Promise<void>;

  /** Feed additional user messages into a running session. */
  streamInput?(input: AsyncIterable<unknown>): Promise<void>;

  /** Resolve an active structured pending-input request via option index. */
  submitPendingInputOption?(index: number, context?: { requestId?: string; questionId?: string }): Promise<boolean>;

  /** Resolve an active free-text pending-input request. */
  submitPendingInputText?(text: string): Promise<boolean>;

  /**
   * Resolve a pending native plan-approval request. Returns false when no
   * native request is pending, so callers fall back to prompt-level handling.
   */
  resolvePlanDecision?(decision: HarnessPlanDecision): Promise<boolean>;

  /** Interrupt the current turn. */
  interrupt?(): Promise<void>;

  /** Release backend transports and child processes owned by this session. */
  close?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// AgentHarness — the interface each backend implements
// ---------------------------------------------------------------------------

export interface AgentHarness {
  /** Unique harness identifier, e.g. "claude-code", "codex". */
  readonly name: string;

  /** Canonical backend kind used for persisted refs. */
  readonly backendKind: SessionBackendKind;

  /** Launch a new session and return a handle. */
  launch(options: HarnessLaunchOptions): HarnessSession;

  /** Build a user-message payload suitable for the harness's multi-turn protocol. */
  buildUserMessage(text: string, sessionId: string): unknown;

  /** Permission modes supported by this harness. */
  readonly supportedPermissionModes: readonly string[];

  /** Structured capabilities surfaced by the backend. */
  readonly capabilities: BackendCapabilityFlags;
}
