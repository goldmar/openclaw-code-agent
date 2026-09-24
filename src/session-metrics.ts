import { truncateText } from "./format";
import type { PersistedSessionInfo, SessionMetrics, SessionStatus } from "./types";
import type { Session } from "./session";

const TERMINAL_STATUSES = new Set<SessionStatus>(["completed", "failed", "killed"]);

type MetricsSession = {
  id: string;
  name: string;
  prompt: string;
  status: SessionStatus;
  costUsd: number;
  startedAt?: number;
  completedAt?: number;
};

function fromPersisted(session: PersistedSessionInfo): MetricsSession {
  return {
    id: session.sessionId ?? session.harnessSessionId,
    name: session.name,
    prompt: session.prompt,
    status: session.status,
    costUsd: session.costUsd ?? 0,
    startedAt: session.createdAt,
    completedAt: session.completedAt,
  };
}

function fromActive(session: Session): MetricsSession {
  return {
    id: session.id,
    name: session.name,
    prompt: session.prompt,
    status: session.status,
    costUsd: session.costUsd ?? 0,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
  };
}

/**
 * Usage metrics derived from the persisted session index plus live sessions,
 * so the counters survive Gateway restarts and include every retained session
 * (a live session overrides its persisted row).
 */
export function computeSessionMetrics(
  persisted: readonly PersistedSessionInfo[],
  active: readonly Session[],
): SessionMetrics {
  const byId = new Map<string, MetricsSession>();
  for (const session of persisted) {
    const entry = fromPersisted(session);
    byId.set(entry.id, entry);
  }
  for (const session of active) byId.set(session.id, fromActive(session));

  const metrics: SessionMetrics = {
    totalCostUsd: 0,
    costPerDay: new Map(),
    sessionsByStatus: { completed: 0, failed: 0, killed: 0 },
    totalLaunched: byId.size,
    totalDurationMs: 0,
    sessionsWithDuration: 0,
    mostExpensive: null,
  };
  for (const session of byId.values()) {
    const cost = session.costUsd;
    metrics.totalCostUsd += cost;
    const dayMs = session.completedAt ?? session.startedAt;
    if (dayMs !== undefined) {
      const dateKey = new Date(dayMs).toISOString().slice(0, 10);
      metrics.costPerDay.set(dateKey, (metrics.costPerDay.get(dateKey) ?? 0) + cost);
    }
    if (TERMINAL_STATUSES.has(session.status)) {
      metrics.sessionsByStatus[session.status as "completed" | "failed" | "killed"]++;
    }
    if (session.completedAt !== undefined && session.startedAt !== undefined && session.completedAt >= session.startedAt) {
      metrics.totalDurationMs += session.completedAt - session.startedAt;
      metrics.sessionsWithDuration++;
    }
    if (cost > 0 && (!metrics.mostExpensive || cost > metrics.mostExpensive.costUsd)) {
      metrics.mostExpensive = {
        id: session.id,
        name: session.name,
        costUsd: cost,
        prompt: truncateText(session.prompt, 80),
      };
    }
  }
  return metrics;
}
