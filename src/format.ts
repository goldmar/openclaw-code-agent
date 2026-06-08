/**
 * Formatting utilities for durations, session listings, stats summaries, and text truncation.
 *
 * Exports helpers to convert milliseconds to human-readable durations, generate
 * short session names from prompts, render rich session listings with status icons,
 * produce aggregate stats summaries, and truncate or tail text within character budgets.
 *
 * @module format
 */
import type {
  ApprovalExecutionState,
  PermissionMode,
  PersistedWorktreeLifecycle,
  SessionBackendRef,
  SessionMetrics,
  SessionWorktreeState,
} from "./types";
import { getBackendConversationId } from "./session-backend-ref";
import { formatHarnessModelLabel } from "./session-display";

/** Session shape needed by list formatting utilities. */
export interface SessionListRenderable {
  id: string;
  name: string;
  status: string;
  duration: number;
  prompt: string;
  workdir: string;
  multiTurn: boolean;
  costUsd: number;
  phase: string;
  lifecycle?: string;
  resumable?: boolean;
  harness?: string;
  model?: string;
  backendRef?: SessionBackendRef;
  harnessSessionId?: string;
  resumeSessionId?: string;
  forkSession?: boolean;
  requestedPermissionMode?: PermissionMode;
  currentPermissionMode?: PermissionMode;
  approvalExecutionState?: ApprovalExecutionState;
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeStrategy?: string;
  worktreeState?: SessionWorktreeState;
  worktreeLifecycle?: PersistedWorktreeLifecycle;
  worktreeMerged?: boolean;
  worktreeMergedAt?: string;
  worktreePrUrl?: string;
  recovered?: boolean;
}

/** Format a duration in milliseconds as `MmSs` or `Ss`. */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes > 0) return `${minutes}m${secs}s`;
  return `${secs}s`;
}

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must",
  "i", "me", "my", "we", "our", "you", "your", "it", "its", "he", "she",
  "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
  "into", "through", "about", "that", "this", "these", "those",
  "and", "or", "but", "if", "then", "so", "not", "no",
  "please", "just", "also", "very", "all", "some", "any", "each",
  "make", "write", "create", "build", "implement", "add", "update",
]);

export function generateSessionName(prompt: string): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  const keywords = words.slice(0, 3);
  if (keywords.length === 0) return "session";
  return keywords.join("-");
}

const STATUS_ICONS: Record<string, string> = {
  starting: "🟡",
  running: "🟢",
  completed: "✅",
  failed: "❌",
  killed: "⛔",
  awaiting_plan_decision: "📋",
  awaiting_user_input: "❓",
  awaiting_worktree_decision: "🌿",
  suspended: "⏸️",
  terminal: "🏁",
};

function formatWorktreeResolutionStatus(session: SessionListRenderable): string {
  const lifecycleState = session.worktreeLifecycle?.state ?? session.worktreeState;
  if (session.worktreeMerged || lifecycleState === "merged") {
    return "[merged ✓]";
  }
  if (lifecycleState === "released") {
    return "[released]";
  }
  if (session.worktreePrUrl) {
    return `[PR: ${session.worktreePrUrl}]`;
  }
  if (lifecycleState === "pr_open") {
    return "[PR open]";
  }
  if (lifecycleState === "dismissed") {
    return "[dismissed]";
  }
  if (lifecycleState === "no_change") {
    return "[no change]";
  }
  return "[not merged]";
}

/** Render a human-readable session row for `agent_sessions`. */
export function formatSessionListing(session: SessionListRenderable): string {
  const icon = STATUS_ICONS[session.phase] ?? STATUS_ICONS[session.status] ?? "❓";
  const duration = formatDuration(session.duration);
  const mode = session.multiTurn ? "multi-turn" : "single";
  const promptSummary =
    session.prompt.length > 80 ? session.prompt.slice(0, 80) + "..." : session.prompt;

  const costStr = session.costUsd > 0 ? ` | $${session.costUsd.toFixed(2)}` : "";
  const lines = [
    `${icon} ${session.name} [${session.id}] (${duration}${costStr}) — ${mode}`,
    `   📁 ${session.workdir}`,
    `   📝 "${promptSummary}"`,
  ];

  // F1 + F5: Show branch name, merge status, and PR info when worktree is used
  if (session.worktreePath && session.worktreeBranch) {
    lines.push(`   🌿 Worktree: ${session.worktreeBranch} ${formatWorktreeResolutionStatus(session)}`);
  }

  if (session.phase !== session.status) {
    lines.push(`   ⚙️  Phase: ${session.phase}`);
  }
  if (session.lifecycle && session.lifecycle !== session.phase) {
    lines.push(`   🔄 Lifecycle: ${session.lifecycle}`);
  }
  if (session.requestedPermissionMode || session.currentPermissionMode || session.approvalExecutionState) {
    lines.push(
      `   🔐 Approval: ${session.approvalExecutionState ?? "unknown"} ` +
      `(requested=${session.requestedPermissionMode ?? "unknown"}, effective=${session.currentPermissionMode ?? "unknown"})`,
    );
  }
  if (session.resumable) {
    lines.push(`   ↩️  Resumable: yes`);
  }
  if (session.recovered) {
    lines.push(`   ♻️  Recovered: persisted metadata only; no live process to kill`);
  }

  if (session.harness) {
    lines.push(`   🧰 Harness | model: ${formatHarnessModelLabel({
      harness: session.harness,
      model: session.model,
    })}`);
  } else if (session.model) {
    lines.push(`   🧰 Harness | model: ${session.model}`);
  }

  const backendConversationId = getBackendConversationId(session);
  if (backendConversationId) {
    lines.push(`   🔗 Backend ID: ${backendConversationId}`);
  }
  if (session.resumeSessionId) {
    lines.push(`   ↩️  Resumed from: ${session.resumeSessionId}${session.forkSession ? " (forked)" : ""}`);
  }

  return lines.join("\n");
}

/** Render aggregate in-memory usage metrics for `agent_stats`. */
export function formatStats(metrics: SessionMetrics, runningCount: number): string {
  const avgDurationMs =
    metrics.sessionsWithDuration > 0
      ? metrics.totalDurationMs / metrics.sessionsWithDuration
      : 0;

  const { completed, failed, killed } = metrics.sessionsByStatus;

  const lines = [
    `📊 OpenClaw Code Agent Stats`,
    ``,
    `📋 Sessions`,
    `   Launched:   ${metrics.totalLaunched}`,
    `   Running:    ${runningCount}`,
    `   Completed:  ${completed}`,
    `   Failed:     ${failed}`,
    `   Killed:     ${killed}`,
    ``,
    `⏱️  Average duration: ${avgDurationMs > 0 ? formatDuration(avgDurationMs) : "n/a"}`,
  ];

  if (metrics.mostExpensive) {
    const me = metrics.mostExpensive;
    lines.push(
      ``,
      `🏆 Notable session`,
      `   ${me.name} [${me.id}]`,
      `   📝 "${me.prompt}"`,
    );
  }

  return lines.join("\n");
}

/** Truncate a string with "..." suffix. */
export function truncateText(text: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (text.length <= maxLen) return text;
  if (maxLen <= 3) return ".".repeat(maxLen);
  return text.slice(0, maxLen - 3) + "...";
}

/**
 * Take the last N complete lines from text that fit within a character budget.
 * Never cuts mid-line.
 */
export function lastCompleteLines(text: string, maxChars: number): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let len = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const lineLen = lines[i].length + (result.length > 0 ? 1 : 0);
    if (len + lineLen > maxChars && result.length > 0) break;
    result.unshift(lines[i]);
    len += lineLen;
  }
  return result.join("\n");
}

/**
 * Take the first N complete lines from text that fit within a character budget.
 * Never cuts mid-line.
 */
export function firstCompleteLines(text: string, maxChars: number): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let len = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineLen = lines[i].length + (result.length > 0 ? 1 : 0);
    if (len + lineLen > maxChars && result.length > 0) break;
    result.push(lines[i]);
    len += lineLen;
  }
  return result.join("\n");
}
