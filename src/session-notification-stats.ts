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
  });
  if (harnessModel) {
    parts.push(...harnessModel.split(" | "));
  }

  return parts.length > 0 ? ` | ${parts.join(" | ")}` : "";
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
