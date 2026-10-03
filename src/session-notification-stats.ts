import type { ReasoningEffort } from "./types";
import { formatDuration } from "./format";
import { formatHarnessModelLabel } from "./session-display";

export type SessionNotificationStats = {
  costUsd?: number;
  duration?: number;
  createdAt?: number;
  completedAt?: number;
  harnessName?: string;
  harness?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  backendInfo?: { reasoningEffortSupported?: boolean };
};

export function formatSessionStatsSuffix(stats: SessionNotificationStats): string {
  const parts: string[] = [];

  if (typeof stats.costUsd === "number" && Number.isFinite(stats.costUsd)) {
    parts.push(`$${stats.costUsd.toFixed(2)}`);
  }

  const duration = resolveDuration(stats);
  if (duration !== undefined) {
    parts.push(formatDuration(duration));
  }

  const harnessModel = formatHarnessModelLabel({
    harness: stats.harnessName ?? stats.harness,
    model: stats.model,
    reasoningEffort: stats.reasoningEffort,
    reasoningEffortSupported: stats.backendInfo?.reasoningEffortSupported,
  });
  if (harnessModel) {
    parts.push(...harnessModel.split(" | "));
  }

  return parts.length > 0 ? ` | ${parts.join(" | ")}` : "";
}

/**
 * Add the stats footer (cost | duration | harness | model | reasoning) to a
 * status line. Every merge / PR outcome line uses this, so automatic and manual
 * outcomes carry the same footer as the generic `✅ Completed` notice. Stats go
 * on the first line; later lines (for example an outcome summary) stay as they are.
 */
export function appendSessionStatsSuffix(line: string, stats: SessionNotificationStats): string {
  const suffix = formatSessionStatsSuffix(stats);
  if (!suffix) return line;
  const newline = line.indexOf("\n");
  return newline < 0 ? `${line}${suffix}` : `${line.slice(0, newline)}${suffix}${line.slice(newline)}`;
}

function resolveDuration(stats: SessionNotificationStats): number | undefined {
  if (typeof stats.duration === "number" && Number.isFinite(stats.duration) && stats.duration >= 0) {
    return stats.duration;
  }
  if (
    typeof stats.createdAt === "number"
    && Number.isFinite(stats.createdAt)
    && typeof stats.completedAt === "number"
    && Number.isFinite(stats.completedAt)
    && stats.completedAt >= stats.createdAt
  ) {
    return stats.completedAt - stats.createdAt;
  }
  return undefined;
}
