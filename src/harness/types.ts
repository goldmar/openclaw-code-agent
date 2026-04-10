/**
 * Agent harness abstraction layer.
 *
 * Defines the contract that each coding-agent backend (Claude Code, Codex, etc.)
 * must implement so the rest of the plugin stays harness-agnostic.
 */

import type { McpServerConfig } from "../config";
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

export interface HarnessResult {
  success: boolean;
  outcome?: "completed" | "failed" | "interrupted";
  duration_ms: number;
  total_cost_usd: number;
  num_turns: number;
  result?: string;
  session_id: string;
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
  mcpServers?: McpServerConfig;
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
  submitPendingInputOption?(index: number): Promise<boolean>;

  /** Resolve an active free-text pending-input request. */
  submitPendingInputText?(text: string): Promise<boolean>;

  /** Interrupt the current turn. */
  interrupt?(): Promise<void>;
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
