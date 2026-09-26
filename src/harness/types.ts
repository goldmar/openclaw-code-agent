/**
 * Agent harness abstraction layer.
 *
 * Defines the contract that each coding-agent backend (Claude Code, Codex, etc.)
 * must implement so the rest of the plugin stays harness-agnostic.
 */

import type {
  BackendCapabilityFlags,
  PendingInputState,
  PlanArtifact,
  ReasoningEffort,
  SessionBackendRef,
  SessionBackendKind,
  ThreadAction,
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
  /**
   * Running cost so far, on the same basis as `HarnessResult.total_cost_usd`
   * (which replaces it when the turn completes). Lets status views show spend
   * while a turn is still open, for example while it waits for user input.
   */
  costUsd?: number;
  /**
   * API-list-price estimate for a backend that reports no billed cost (Codex
   * with a ChatGPT login). Never shown as spend; goal `max_cost_usd` falls
   * back to it so a spend limit still bounds such sessions.
   */
  estimatedCostUsd?: number;
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
  /** False when fast mode was requested but the model offers no fast tier (it runs at standard speed). */
  fastModeSupported?: boolean;
}

export type HarnessMessage =
  | { type: "backend_ref"; ref: SessionBackendRef }
  | { type: "run_started"; runId?: string }
  /** A pulled prompt was consumed without starting a turn (for example it answered pending input). */
  | { type: "prompt_settled" }
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
  /** The pending-input request the call raised, so answer buttons target it. */
  context?: { requestId?: string; questionId?: string },
) => Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> }>;

export interface HarnessLaunchOptions {
  prompt: string | AsyncIterable<unknown>;
  cwd: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  fastMode?: boolean;
  permissionMode?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  resumeSessionId?: string;
  forkSession?: boolean;
  /**
   * Drop the latest N backend turns before continuing. With `forkSession` the
   * fork is created before those turns; without it the resumed conversation
   * continues from before them (Codex reverts the thread, Claude Code resumes
   * at an earlier message; OpenCode supports only the fork). Files are not
   * reverted.
   */
  rewindTurns?: number;
  /** Worktree strategy of the session (Claude Code uses it for `projectConfigRoot`). */
  worktreeStrategy?: WorktreeStrategy;
  /** The repository checkout the session's worktree was created from. */
  originalWorkdir?: string;
  abortController?: AbortController;
  /** Optional tool-intercept callback (CC sessions only). */
  canUseTool?: CanUseToolCallback;
  /**
   * Usage the resumed conversation had already accumulated (Claude Code only).
   * Claude Code restores a resumed transcript's cumulative cost, so a fork
   * would otherwise report its parent's spend as its own; with this baseline
   * a fork reports only its own delta.
   */
  forkBaselineUsage?: { costUsd?: number; models?: HarnessModelUsage[] };
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

  /**
   * Inject a user message into the currently running turn. Resolves `false`
   * when no steerable turn is active (or it is being interrupted), in which
   * case the caller queues the message as a new turn instead.
   */
  steer?(text: string): Promise<boolean>;

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

  /**
   * Build a queued control message for a backend thread action (see
   * `capabilities.threadActions`). Control messages travel through the same
   * ordered prompt stream as user messages so they never overlap a turn.
   */
  buildThreadActionMessage?(action: ThreadAction): unknown;

  /** Permission modes supported by this harness. */
  readonly supportedPermissionModes: readonly string[];

  /** Structured capabilities surfaced by the backend. */
  readonly capabilities: BackendCapabilityFlags;
}
