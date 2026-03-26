/**
 * Formatting utilities for durations, session listings, stats summaries, and text truncation.
 *
 * Exports helpers to convert milliseconds to human-readable durations, generate
 * short session names from prompts, render rich session listings with status icons,
 * produce aggregate stats summaries, and truncate or tail text within character budgets.
 *
 * @module format
 */
import type { SessionMetrics } from "./types";

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
  harness?: string;
  harnessSessionId?: string;
  resumeSessionId?: string;
  forkSession?: boolean;
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeStrategy?: string;
  worktreeMerged?: boolean;
  worktreeMergedAt?: string;
  worktreePrUrl?: string;
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
  "awaiting-plan-approval": "📋",
};

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
    let worktreeInfo = `   🌿 Worktree: ${session.worktreeBranch}`;

    if (session.worktreeMerged) {
      worktreeInfo += ` [merged ✓]`;
    } else if (session.worktreePrUrl) {
      worktreeInfo += ` [PR: ${session.worktreePrUrl}]`;
    } else {
      worktreeInfo += ` [not merged]`;
    }

    lines.push(worktreeInfo);
  }

  if (session.phase !== session.status) {
    lines.push(`   ⚙️  Phase: ${session.phase}`);
  }

  if (session.harness) {
    lines.push(`   🧰 Harness: ${session.harness}`);
  }

  if (session.harnessSessionId) {
    lines.push(`   🔗 Session ID: ${session.harnessSessionId}`);
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
