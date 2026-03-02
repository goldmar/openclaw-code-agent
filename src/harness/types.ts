/**
 * Agent harness abstraction layer.
 *
 * Defines the contract that each coding-agent backend (Claude Code, Codex, etc.)
 * must implement so the rest of the plugin stays harness-agnostic.
 */

import type { McpServerConfig } from "../config";

// ---------------------------------------------------------------------------
// Harness message types (normalised from each SDK's wire format)
// ---------------------------------------------------------------------------

export interface HarnessResult {
  success: boolean;
  duration_ms: number;
  total_cost_usd: number;
  num_turns: number;
  result?: string;
  session_id: string;
}

export type HarnessMessage =
  | { type: "init"; session_id: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: any }
  | { type: "permission_mode_change"; mode: string }
  | { type: "result"; data: HarnessResult };

// ---------------------------------------------------------------------------
// Launch options
// ---------------------------------------------------------------------------

export interface HarnessLaunchOptions {
  prompt: string | AsyncIterable<any>;
  cwd: string;
  model?: string;
  permissionMode?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  resumeSessionId?: string;
  forkSession?: boolean;
  abortController?: AbortController;
  mcpServers?: McpServerConfig;
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
  streamInput?(input: AsyncIterable<any>): Promise<void>;

  /** Interrupt the current turn. */
  interrupt?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// AgentHarness — the interface each backend implements
// ---------------------------------------------------------------------------

export interface AgentHarness {
  /** Unique harness identifier, e.g. "claude-code", "codex". */
  readonly name: string;

  /** Launch a new session and return a handle. */
  launch(options: HarnessLaunchOptions): HarnessSession;

  /** Build a user-message payload suitable for the harness's multi-turn protocol. */
  buildUserMessage(text: string, sessionId: string): any;

  /** Permission modes supported by this harness. */
  readonly supportedPermissionModes: readonly string[];

  /** Tool-use names that mean "the agent is asking the user a question". */
  readonly questionToolNames: readonly string[];

  /** Tool-use names that mean "plan submitted for approval". */
  readonly planApprovalToolNames: readonly string[];
}
